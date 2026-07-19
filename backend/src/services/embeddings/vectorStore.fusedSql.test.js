import { describe, it, expect } from 'vitest';
import { fusedSearch, FUSED_ANN_CHUNKS_PER_MESSAGE, HNSW_EF_SEARCH_MAX } from './vectorStore.js';

// SQL-text pins for fusedSearch, driven through an injected fake client (a
// plain object — NOT a pg.Pool — so withEfSearch uses it verbatim and every
// statement it issues is recorded in order).
//
// `annPools` scripts the ann_pool_size the fused SELECT reports on each
// successive attempt, so the widening loop's exits are testable.
function fakeDb({ chunkCount = 5000, filteredMessages = 3000, annPools = [999], ftsPool = 5 } = {}) {
  const calls = [];
  let attempt = -1;
  return {
    calls,
    fusedRuns() { return calls.filter((c) => /^WITH /.test(c.text) && /FROM fused f/.test(c.text)); },
    query: async (text, params) => {
      calls.push({ text, params });
      if (/count\(\*\)::int AS n FROM embeddings/.test(text)) return { rows: [{ n: chunkCount }] };
      if (/count\(DISTINCT e\.message_id\)/.test(text)) return { rows: [{ n: filteredMessages }] };
      if (/FROM fused f/.test(text)) {
        attempt = Math.min(attempt + 1, annPools.length - 1);
        return {
          rows: [{
            message_id: 'm1', subject: 's',
            fts_pool_size: ftsPool, ann_pool_size: annPools[attempt],
          }],
        };
      }
      return { rows: [] };
    },
  };
}

const gen = { id: 7, dimension: 4 };
const base = {
  generation: gen, accountIds: ['a1'], rrfK: 60, kPerSignal: 10, limit: 10,
  buildFilters: () => [],
};

describe('fusedSearch BM25 leg — stopword-safe combined tsquery (Fix 1)', () => {
  it('matches AND ranks with ONE `&&`-combined tsquery so an empty (stopword) operand drops out', async () => {
    const db = fakeDb();
    await fusedSearch({ ...base, ftsQuery: 'waiting for invoice', queryVec: [1, 0, 0, 0] }, { client: db });
    const sql = db.fusedRuns()[0].text;
    const combined =
      "(to_tsquery('english', quote_literal($2) || ':*') && " +
      "to_tsquery('english', quote_literal($3) || ':*') && " +
      "to_tsquery('english', quote_literal($4) || ':*'))";
    // Single @@ against the combined query — `&&` drops an empty-normalizing
    // operand ("for"), so a stopword can no longer zero the whole leg the way
    // the old per-term `@@ ... AND @@ ...` chain did.
    expect(sql).toContain(`m.search_fts @@ ${combined}`);
    // The rank arg is the SAME combined construction (match and rank can't diverge).
    expect(sql).toContain(`ts_rank_cd(ARRAY[0.1, 0.1, 0.4, 1.0]::real[], m.search_fts, ${combined}, 32)`);
    // No per-term AND chain remains.
    expect(sql).not.toMatch(/@@ to_tsquery\('english', quote_literal\(\$\d+\) \|\| ':\*'\) AND/);
    const params = db.fusedRuns()[0].params;
    expect(params.slice(1, 4)).toEqual(['waiting', 'for', 'invoice']);
  });
});

describe('fusedSearch ANN leg — hnsw.ef_search per attempt (Fix 2)', () => {
  it('runs each ANN attempt in a transaction that SET LOCALs ef_search to the inner LIMIT', async () => {
    const db = fakeDb();
    await fusedSearch({ ...base, ftsQuery: 'quantum', queryVec: [1, 0, 0, 0] }, { client: db });
    const texts = db.calls.map((c) => c.text);
    const inner = (base.kPerSignal + 1) * FUSED_ANN_CHUNKS_PER_MESSAGE; // 88
    const begin = texts.indexOf('BEGIN');
    const guc = texts.indexOf(`SET LOCAL hnsw.ef_search = ${inner}`);
    const run = texts.findIndex((t) => /FROM fused f/.test(t));
    const commit = texts.indexOf('COMMIT');
    // BEGIN → SET LOCAL → fused SELECT → COMMIT, in that order, on one client.
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(guc).toBeGreaterThan(begin);
    expect(run).toBeGreaterThan(guc);
    expect(commit).toBeGreaterThan(run);
  });

  it(`caps the GUC at HNSW_EF_SEARCH_MAX (${HNSW_EF_SEARCH_MAX}) — pgvector rejects larger values`, async () => {
    const db = fakeDb();
    // kPerSignal=200 → inner LIMIT (201*8=1608) exceeds the pgvector cap.
    await fusedSearch({ ...base, kPerSignal: 200, ftsQuery: 'quantum', queryVec: [1, 0, 0, 0] }, { client: db });
    expect(db.calls.some((c) => c.text === `SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH_MAX}`)).toBe(true);
    expect(db.calls.some((c) => /SET LOCAL hnsw\.ef_search = 1608/.test(c.text))).toBe(false);
  });

  it('re-issues a LARGER ef_search when the widening loop grows the inner LIMIT', async () => {
    // First attempt dedups to 5 (< kPerSignal+1 = 11, < filteredCeiling),
    // second grows to 11 and exits.
    const db = fakeDb({ annPools: [5, 11] });
    await fusedSearch({ ...base, ftsQuery: 'quantum', queryVec: [1, 0, 0, 0] }, { client: db });
    const gucs = db.calls.filter((c) => /^SET LOCAL hnsw\.ef_search = /.test(c.text)).map((c) => c.text);
    expect(gucs).toEqual(['SET LOCAL hnsw.ef_search = 88', 'SET LOCAL hnsw.ef_search = 176']);
    expect(db.fusedRuns()).toHaveLength(2);
  });

  it('breaks the widening loop when the ann pool stops growing between attempts', async () => {
    // The pool sticks at 5 forever; without the no-growth break the loop
    // would double 88 → … → 5000 (the chunk ceiling) re-running for nothing.
    const db = fakeDb({ annPools: [5, 5] });
    const { poolSaturated } = await fusedSearch(
      { ...base, ftsQuery: 'quantum', queryVec: [1, 0, 0, 0] }, { client: db });
    expect(db.fusedRuns()).toHaveLength(2);
    expect(poolSaturated).toBe(false);
  });

  it('an FTS-only request issues no transaction and no GUC (nothing to tune)', async () => {
    const db = fakeDb();
    await fusedSearch({ ...base, ftsQuery: 'quantum', queryVec: null }, { client: db });
    expect(db.calls.some((c) => /hnsw\.ef_search|^BEGIN$/.test(c.text))).toBe(false);
  });
});
