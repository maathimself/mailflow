import { describe, it, expect, afterAll } from 'vitest';
import { hasTestDb, withTestDb, closeTestDb } from './__testdb__.js';
import { fusedSearch } from './vectorStore.js';
import { searchLexical } from '../search/lexicalRepo.js';

afterAll(async () => { await closeTestDb(); });

describe.skipIf(!hasTestDb())('pgvector test DB', () => {
  it('boots ensureVectorSchema and exposes the vector extension', async () => {
    await withTestDb(async (pool) => {
      const { rows } = await pool.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
      expect(rows).toHaveLength(1);
    });
  });
});

function unitVec(dim, axis) {
  const v = new Array(dim).fill(0);
  v[axis] = 1;
  return v;
}

// Seeds one user + account + N messages (trigger fills search_fts) and an active
// generation with one chunk per message. Returns { accountId, generation, ids }.
async function seedThree(pool) {
  const u = (await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ('t','x') RETURNING id`)).rows[0].id;
  const acc = (await pool.query(
    `INSERT INTO email_accounts (user_id, name, email_address, enabled)
     VALUES ($1,'A','a@x.test',true) RETURNING id`, [u])).rows[0].id;
  const base = Date.UTC(2025, 0, 15, 12, 0, 0);
  const rows = [
    ['alpha quantum project update', 'discussing the quantum roadmap', 0, false],
    ['beta vector indexing notes',   'notes about hybrid search and ranking', 1, true],
    ['gamma project retrospective',  'retro covering the quantum milestone', 2, false],
  ];
  const ids = [];
  for (let i = 0; i < rows.length; i++) {
    const [subject, body, , hasAtt] = rows[i];
    const id = (await pool.query(
      `INSERT INTO messages (account_id, uid, folder, subject, from_name, from_email,
                             date, snippet, body_text, has_attachments, is_deleted)
       VALUES ($1,$2,'INBOX',$3,'Sender','s@x.test',$4,$5,$6,$7,false) RETURNING id`,
      [acc, 100 + i, subject, new Date(base + i * 86400000).toISOString(), body, body, hasAtt]
    )).rows[0].id;
    ids.push(id);
  }
  const gen = (await pool.query(
    `INSERT INTO index_generations (model, dimension, fingerprint, started_at, state)
     VALUES ('m', 4, 'm:4:test', $1, 'active') RETURNING id`,
    [Math.floor(Date.now() / 1000)])).rows[0].id;
  for (let i = 0; i < ids.length; i++) {
    await pool.query(
      `INSERT INTO embeddings (generation_id, message_id, chunk_index, embedded_at, source_char_len, embedding, dimension)
       VALUES ($1,$2,0,$3,4,$4::vector,4)`,
      [gen, ids[i], Math.floor(Date.now() / 1000), `[${unitVec(4, i).join(',')}]`]);
  }
  return { accountId: acc, generation: { id: gen, dimension: 4 }, ids };
}

const base = { rrfK: 60, kPerSignal: 10, limit: 10, buildFilters: () => [] };

describe.skipIf(!hasTestDb())('fusedSearch', () => {
  it('FTS-only: returns the two quantum messages, bm25 set / vector null, RRF descending', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const { hits, poolSaturated } = await fusedSearch(
        { ...base, ftsQuery: 'quantum', queryVec: null, generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      expect(poolSaturated).toBe(false);
      expect(hits).toHaveLength(2);
      const set = new Set(hits.map(h => h.message_id));
      expect(set.has(s.ids[0]) && set.has(s.ids[2])).toBe(true);
      for (const h of hits) {
        expect(h.vector_score).toBeNull();
        expect(h.bm25_score).not.toBeNull();
        expect(h.rrf_score).toBeGreaterThan(0);
      }
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1].rrf_score).toBeGreaterThanOrEqual(hits[i].rrf_score);
      }
    });
  });

  it('prefix consistency: the fused FTS leg matches the same hit set as the lexical path for a prefix term (Opus review fix-round)', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      // A message whose only match for "invo" is a prefix of "invoice" — none
      // of seedThree's quantum-related docs share that prefix, so a correct
      // prefix match (and only a correct prefix match) finds exactly this one.
      const invoiceId = (await pool.query(
        `INSERT INTO messages (account_id, uid, folder, subject, from_name, from_email,
                               date, snippet, body_text, is_deleted)
         VALUES ($1,103,'INBOX','Invoice reminder','Sender','s@x.test',now(),'inv','an invoice is attached',false)
         RETURNING id`,
        [s.accountId])).rows[0].id;

      const { hits } = await fusedSearch(
        { ...base, ftsQuery: 'invo', queryVec: null, generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      const lex = await searchLexical((text, params) => pool.query(text, params), {
        parsed: { filters: [], terms: [{ value: 'invo', negate: false }] },
        accountIds: [s.accountId], folderScope: null, folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
      });

      const fusedIds = new Set(hits.map(h => h.message_id));
      const lexIds = new Set(lex.rows.map(r => r.id));
      expect(fusedIds.has(invoiceId)).toBe(true);
      expect(fusedIds).toEqual(lexIds);
    });
  });

  it('ANN-only: top hit is the on-axis message, bm25 null / vector set', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const { hits, poolSaturated } = await fusedSearch(
        { ...base, ftsQuery: null, queryVec: unitVec(4, 0), generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      expect(poolSaturated).toBe(false);
      expect(hits[0].message_id).toBe(s.ids[0]);
      for (const h of hits) {
        expect(h.bm25_score).toBeNull();
        expect(h.vector_score).not.toBeNull();
      }
    });
  });

  it('hybrid: union of the FTS pair and the ANN-only third message (3 hits), RRF descending', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const { hits } = await fusedSearch(
        { ...base, ftsQuery: 'quantum', queryVec: unitVec(4, 1), generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      expect(hits).toHaveLength(3);
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1].rrf_score).toBeGreaterThanOrEqual(hits[i].rrf_score);
      }
    });
  });

  it('saturation: kPerSignal below the pool size flips poolSaturated and trims', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const { hits, poolSaturated } = await fusedSearch(
        { ...base, kPerSignal: 1, ftsQuery: 'quantum', queryVec: null, generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      expect(poolSaturated).toBe(true);
      expect(hits).toHaveLength(1);
    });
  });

  it('tenant scope: a different account never leaks into the pool', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const { hits } = await fusedSearch(
        { ...base, ftsQuery: 'quantum', queryVec: null, generation: s.generation,
          accountIds: ['00000000-0000-0000-0000-000000000000'] },
        { client: pool });
      expect(hits).toHaveLength(0);
    });
  });

  it('multi-chunk dedup: a message with a close and a far chunk appears once at its MIN distance', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      // Give the winning (chunk_index=0, on-axis) chunk distinctive offsets so
      // Task 5b's best_char_start assertion can tell it apart from the far one.
      await pool.query(
        `UPDATE embeddings SET chunk_char_start = 6, chunk_char_end = 40
          WHERE generation_id = $1 AND message_id = $2 AND chunk_index = 0`,
        [s.generation.id, s.ids[0]]);
      // give ids[0] a second, far chunk on axis 2, with DIFFERENT offsets
      await pool.query(
        `INSERT INTO embeddings (generation_id, message_id, chunk_index, embedded_at, source_char_len, chunk_char_start, chunk_char_end, embedding, dimension)
         VALUES ($1,$2,1,$3,4,100,140,$4::vector,4)`,
        [s.generation.id, s.ids[0], Math.floor(Date.now() / 1000), `[${unitVec(4, 2).join(',')}]`]);
      const { hits } = await fusedSearch(
        { ...base, ftsQuery: null, queryVec: unitVec(4, 0), generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      const counts = {};
      for (const h of hits) counts[h.message_id] = (counts[h.message_id] || 0) + 1;
      expect(counts[s.ids[0]]).toBe(1);
      const top = hits.find(h => h.message_id === s.ids[0]);
      expect(top.vector_score).toBeCloseTo(1.0, 6); // 1 - MIN(distance)=0
      // The winning (close) chunk's offsets ride through, not the far chunk's.
      expect(top.best_chunk_index).toBe(0);
      expect(top.best_char_start).toBe(6);
      expect(top.best_char_end).toBe(40);
    });
  });

  it('rejects an empty request', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      await expect(fusedSearch(
        { ...base, ftsQuery: null, queryVec: null, generation: s.generation, accountIds: [s.accountId] },
        { client: pool })).rejects.toThrow();
    });
  });
});

// Wave D Fix 1, verified against the live pgvector container: english stopwords
// normalize to an EMPTY tsquery under 'english' (numnode = 0) and `@@ ''` is
// FALSE — pre-fix, ONE stopword in the AND'd term chain zeroed every backfilled
// result ("waiting for invoice" → 0 hits because of "for").
describe.skipIf(!hasTestDb())('stopword terms never zero a search (Fix 1)', () => {
  async function seedWaiting(pool, s) {
    return (await pool.query(
      `INSERT INTO messages (account_id, uid, folder, subject, from_name, from_email,
                             date, snippet, body_text, is_deleted)
       VALUES ($1,104,'INBOX','Waiting for invoice','Sender','s@x.test',now(),'w',
               'we are waiting for the invoice payment',false) RETURNING id`,
      [s.accountId])).rows[0].id;
  }
  const lex = (pool, terms, s, ordering = 'relevance') =>
    searchLexical((text, params) => pool.query(text, params), {
      parsed: { filters: [], terms },
      accountIds: [s.accountId], folderScope: null, folderFuzzy: false, ordering, limit: 50, offset: 0,
    });

  it('lexical: "waiting for invoice" finds the message despite the stopword', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const id = await seedWaiting(pool, s);
      const res = await lex(pool, [
        { value: 'waiting', negate: false },
        { value: 'for', negate: false },
        { value: 'invoice', negate: false },
      ], s);
      expect(res.rows.map((r) => r.id)).toContain(id);
    });
  });

  it('lexical: a stopword-ONLY query degrades to filter-only/date-order — never zero-by-stopword', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const res = await lex(pool, [{ value: 'the', negate: false }], s);
      expect(res.hasCondition).toBe(true);
      expect(res.rows).toHaveLength(3); // the whole (trash-excluded) scope
      const dates = res.rows.map((r) => new Date(r.date).getTime());
      expect(dates).toEqual([...dates].sort((a, b) => b - a)); // rank 0 ⇒ date tiebreak
    });
  });

  it('lexical: a NEGATED stopword contributes nothing instead of excluding everything', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const id = await seedWaiting(pool, s);
      const res = await lex(pool, [
        { value: 'invoice', negate: false },
        { value: 'the', negate: true },   // body contains "the" — must NOT exclude
      ], s);
      expect(res.rows.map((r) => r.id)).toContain(id);
    });
  });

  it('fused BM25 leg: "waiting for invoice" matches the same set the lexical path finds', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const id = await seedWaiting(pool, s);
      const { hits } = await fusedSearch(
        { ...base, ftsQuery: 'waiting for invoice', queryVec: null, generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      const res = await lex(pool, [
        { value: 'waiting', negate: false },
        { value: 'for', negate: false },
        { value: 'invoice', negate: false },
      ], s);
      expect(hits.map((h) => h.message_id)).toContain(id);
      expect(new Set(hits.map((h) => h.message_id))).toEqual(new Set(res.rows.map((r) => r.id)));
    });
  });

  it('fused: an ALL-stopword ftsQuery leaves the BM25 leg empty — pure-ANN ranking, silence not noise', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      const { hits } = await fusedSearch(
        { ...base, ftsQuery: 'the for you', queryVec: unitVec(4, 0), generation: s.generation, accountIds: [s.accountId] },
        { client: pool });
      expect(hits.length).toBeGreaterThan(0);              // ANN still answers
      expect(hits.every((h) => h.bm25_score === null)).toBe(true); // FTS contributed nothing
    });
  });

});

describe.skipIf(!hasTestDb())('fusedSearch input validation', () => {
  it('rejects a dimension mismatch', async () => {
    await withTestDb(async (pool) => {
      const s = await seedThree(pool);
      await expect(fusedSearch(
        { ...base, ftsQuery: null, queryVec: [1, 2, 3], generation: s.generation, accountIds: [s.accountId] },
        { client: pool })).rejects.toThrow();
    });
  });
});
