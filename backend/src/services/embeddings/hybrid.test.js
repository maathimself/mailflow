import { describe, it, expect } from 'vitest';
import { applySubjectBoost, hybridSearch, isLexicalFallback, MissingFreeTextError } from './hybrid.js';
import { VectorUnavailableError } from './vectorErrors.js';

const h = (id, rrf, subject) => ({ message_id: id, rrf_score: rrf, subject });

describe('applySubjectBoost', () => {
  it('lifts a subject-term match above an equal-scoring non-match (port TestFuse_SubjectBoost)', () => {
    const hits = [h('a', 1 / 61, 'ordinary email'), h('b', 1 / 61, 'Quarterly Review meeting')];
    const out = applySubjectBoost(hits, ['meeting'], 2.0);
    expect(out[0].message_id).toBe('b');
    expect(out[0].subject_boosted).toBe(true);
    expect(out.find(x => x.message_id === 'a').subject_boosted).toBeUndefined();
  });

  it('matches case-insensitively (port TestFuse_SubjectBoost_CaseInsensitive)', () => {
    const out = applySubjectBoost([h('a', 1 / 61, 'MEETING Minutes')], ['meeting'], 2.0);
    expect(out[0].subject_boosted).toBe(true);
  });

  it('does nothing when boost <= 1 (port TestFuse_NoBoostWhenFlagUnset)', () => {
    const out = applySubjectBoost([h('a', 1 / 61, 'meeting subject')], ['meeting'], 1.0);
    expect(out[0].subject_boosted).toBeUndefined();
    expect(out[0].rrf_score).toBeCloseTo(1 / 61, 12);
  });

  it('breaks ties by message_id ascending, deterministically (port TestFuse_TiedRRFScoresStableByMessageID)', () => {
    for (let i = 0; i < 20; i++) {
      const out = applySubjectBoost([h('m7', 0.05, 'x'), h('m3', 0.05, 'y')], [], 2.0);
      expect(out.map(x => x.message_id)).toEqual(['m3', 'm7']);
    }
  });
});

function fakes(over = {}) {
  const calls = { embed: [], fused: [] };
  const base = {
    resolveEmbedConfig: async () => ({ enabled: true, model: 'm', dimension: 4 }),
    generationFingerprint: (cfg) => `${cfg.model}:${cfg.dimension}:test`,
    resolveActiveGeneration: async () => ({ id: 1, model: 'm', dimension: 4, fingerprint: 'm:4:test', state: 'active' }),
    makeClient: () => ({ embed: async (texts) => { calls.embed.push(texts); return [[1, 0, 0, 0]]; } }),
    // Hit 'a' also surfaced via the FTS leg (bm25_score set) so the subject
    // boost is legitimately live; 'b' is ANN-only. (The boost is gated on the
    // BM25 leg contributing — see the empty-leg regression test below.)
    fusedSearch: async (r) => { calls.fused.push(r); return {
      hits: [{ message_id: 'a', rrf_score: 0.02, subject: 'quarterly meeting', bm25_score: 0.5, vector_score: 0.7 },
             { message_id: 'b', rrf_score: 0.03, subject: 'ordinary', bm25_score: null, vector_score: 0.8 }],
      poolSaturated: false, generation: r.generation }; },   // echoes the rich generation it was given
  };
  return { deps: { ...base, ...over }, calls };
}

describe('hybridSearch', () => {
  const req = (m) => ({ mode: m, freeText: 'quarterly meeting', accountIds: ['acc'], buildFilters: () => [], limit: 10 });

  it('vector mode calls fusedSearch with ftsQuery=null and embeds once', async () => {
    const { deps, calls } = fakes();
    await hybridSearch(req('vector'), deps);
    expect(calls.embed).toHaveLength(1);
    expect(calls.fused[0].ftsQuery).toBeNull();
    expect(calls.fused[0].queryVec).toEqual([1, 0, 0, 0]);
  });

  it('hybrid mode passes the free text as the BM25 leg', async () => {
    const { deps, calls } = fakes();
    await hybridSearch(req('hybrid'), deps);
    expect(calls.fused[0].ftsQuery).toBe('quarterly meeting');
  });

  it('applies the subject boost so a subject-term hit outranks a higher raw RRF (hybrid mode)', async () => {
    const { deps } = fakes();
    const { hits } = await hybridSearch(req('hybrid'), deps);
    expect(hits[0].message_id).toBe('a');       // 0.02*2 = 0.04 > 0.03
    expect(hits[0].subject_boosted).toBe(true);
  });

  it('does NOT apply the subject boost in vector-only mode — msgvault\'s vector path is pure ANN (review MINOR 1)', async () => {
    const { deps } = fakes();
    const { hits } = await hybridSearch(req('vector'), deps);
    const a = hits.find(h => h.message_id === 'a');
    expect(a.rrf_score).toBeCloseTo(0.02, 12); // unboosted — NOT 0.02*2
    expect(hits.every(h => h.subject_boosted === undefined)).toBe(true);
  });

  // Regression: real-corpus eval (2026-07-16) showed hybrid LOSING to pure vector on
  // paraphrase queries because the BM25 AND-leg is empty (no doc has all terms) yet the
  // subject boost still reranked the widened ANN pool by loose substring matches and
  // EVICTED keyword-free-subject targets. Gate: an empty BM25 leg ⇒ no boost ⇒ hybrid
  // ranking == vector ranking. (Documented divergence from msgvault, which boosts
  // unconditionally.)
  it('does NOT boost when the BM25 leg is empty — hybrid ranking == vector ranking (eval fix)', async () => {
    // Pure-ANN pool: every hit's bm25_score is null (FTS matched nothing). The
    // lower-ranked hit's subject contains both query terms; it must NOT be lifted.
    const annOnly = async (r) => ({
      hits: [
        { message_id: 'top', rrf_score: 1 / 61, subject: 'no relevant words in here', bm25_score: null, vector_score: 0.90 },
        { message_id: 'low', rrf_score: 1 / 62, subject: 'quarterly meeting notes', bm25_score: null, vector_score: 0.80 },
      ],
      poolSaturated: false, generation: r.generation,
    });
    const { deps } = fakes({ fusedSearch: annOnly });
    const { hits } = await hybridSearch(req('hybrid'), deps);
    expect(hits.map(h => h.message_id)).toEqual(['top', 'low']);         // ANN order preserved, no eviction
    expect(hits.every(h => !h.subject_boosted)).toBe(true);             // nothing boosted
  });

  it('still boosts when the BM25 leg contributed at least one hit (keyword behavior preserved)', async () => {
    // Mixed pool: 'low' also surfaced via the FTS leg (bm25_score set), so the lexical
    // signal is live and the subject nudge legitimately applies.
    const mixed = async (r) => ({
      hits: [
        { message_id: 'top', rrf_score: 1 / 61, subject: 'no relevant words in here', bm25_score: null, vector_score: 0.90 },
        { message_id: 'low', rrf_score: 1 / 62, subject: 'quarterly meeting notes', bm25_score: 0.5, vector_score: 0.80 },
      ],
      poolSaturated: false, generation: r.generation,
    });
    const { deps } = fakes({ fusedSearch: mixed });
    const { hits } = await hybridSearch(req('hybrid'), deps);
    expect(hits[0].message_id).toBe('low');       // (1/62)*2 ≈ 0.0323 > 1/61 ≈ 0.0164
    expect(hits[0].subject_boosted).toBe(true);
  });

  it('rejects a filter-only (no free text) query with MissingFreeTextError', async () => {
    const { deps } = fakes();
    const err = await hybridSearch({ ...req('hybrid'), freeText: '   ' }, deps).catch(e => e);
    expect(err).toBeInstanceOf(MissingFreeTextError);
    expect(isLexicalFallback(err)).toBe(true);
  });

  it('treats a disabled embed config as VectorUnavailableError(vector_not_enabled)', async () => {
    const { deps } = fakes({ resolveEmbedConfig: async () => ({ enabled: false }) });
    const err = await hybridSearch(req('hybrid'), deps).catch(e => e);
    expect(err).toBeInstanceOf(VectorUnavailableError);
    expect(err.reason).toBe('vector_not_enabled');
    expect(isLexicalFallback(err)).toBe(true);
  });

  it('treats a missing (null) embed config as VectorUnavailableError(vector_not_enabled)', async () => {
    const { deps } = fakes({ resolveEmbedConfig: async () => null });
    const err = await hybridSearch(req('hybrid'), deps).catch(e => e);
    expect(err.reason).toBe('vector_not_enabled');
  });

  it('wraps a transient embed failure as VectorUnavailableError(embedding_timeout) — NOT vector_not_enabled (Wave D Fix 6)', async () => {
    // The config was already resolved as enabled by this point, so a failed
    // embed call is an upstream/transient event (msgvault engine.go wraps it
    // as ErrEmbeddingTimeout), not a "vector search is not configured" one.
    const { deps } = fakes({ makeClient: () => ({ embed: async () => { throw new Error('econnrefused'); } }) });
    const err = await hybridSearch(req('hybrid'), deps).catch(e => e);
    expect(err).toBeInstanceOf(VectorUnavailableError);
    expect(err.reason).toBe('embedding_timeout');
    expect(isLexicalFallback(err)).toBe(true); // REST still falls back to lexical silently
  });

  it('wraps a malformed embedder response as embedding_timeout too (embed-step failure)', async () => {
    const { deps } = fakes({ makeClient: () => ({ embed: async () => [] }) });
    const err = await hybridSearch(req('hybrid'), deps).catch(e => e);
    expect(err.reason).toBe('embedding_timeout');
  });

  it('propagates a stale-index VectorUnavailableError from the resolver', async () => {
    const stale = new VectorUnavailableError('index_stale');
    const { deps } = fakes({ resolveActiveGeneration: async () => { throw stale; } });
    const err = await hybridSearch(req('hybrid'), deps).catch(e => e);
    expect(err).toBe(stale);
    expect(isLexicalFallback(err)).toBe(true);
  });
});

describe('hybrid.js public re-exports', () => {
  it('exposes VectorUnavailableError + resolveActiveGeneration from ./hybrid.js (phase-5 imports them here)', async () => {
    const mod = await import('./hybrid.js');
    expect(typeof mod.resolveActiveGeneration).toBe('function');
    expect(typeof mod.VectorUnavailableError).toBe('function');
    expect(new mod.VectorUnavailableError('index_stale').reason).toBe('index_stale');
  });
});
