import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock inline and import the mocked bindings — referencing an outer `const fn`
// from a vi.mock factory hits Vitest's hoisting temporal-dead-zone error.
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('./lexicalRepo.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, searchLexical: vi.fn() };
});
vi.mock('../embeddings/hybrid.js', () => ({
  hybridSearch: vi.fn(),
  isLexicalFallback: vi.fn(() => true),
  MissingFreeTextError: class extends Error {},
}));

import { query } from '../db.js';
import { searchLexical } from './lexicalRepo.js';
import * as hybrid from '../embeddings/hybrid.js';
import { search } from './searchService.js';

beforeEach(() => {
  query.mockReset(); searchLexical.mockReset();
  hybrid.hybridSearch.mockReset();
  hybrid.isLexicalFallback.mockReset();
  hybrid.isLexicalFallback.mockReturnValue(true);
});

function withAccounts(ids) {
  query.mockResolvedValueOnce({ rows: ids.map(id => ({ id })) });
}

describe('searchService.search', () => {
  it('returns an empty shaped result when the user has no enabled accounts', async () => {
    withAccounts([]);
    const res = await search({ userId: 'u1', parsed: { filters: [], terms: [{ value: 'hi', negate: false }] } });
    expect(res).toEqual({ messages: [], mode: 'lexical', page: { offset: 0, limit: 50, hasMore: false } });
    expect(searchLexical).not.toHaveBeenCalled();
  });

  it('scopes to a single account only when it belongs to the user', async () => {
    withAccounts(['a1', 'a2']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: true });
    await search({ userId: 'u1', accountId: 'a2', parsed: { filters: [], terms: [{ value: 'hi', negate: false }] } });
    expect(searchLexical.mock.calls[0][1].accountIds).toEqual(['a2']);
  });

  it('passes through an optional total when searchLexical returns one', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [{ id: 'm' }], total: 137, hasCondition: true });
    const res = await search({ userId: 'u1', parsed: { filters: [], terms: [{ value: 'x', negate: false }] } });
    expect(res.total).toBe(137);
  });

  it('chooses relevance ordering for free text and date ordering for filter-only queries', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: true });
    await search({ userId: 'u1', parsed: { filters: [], terms: [{ value: 'invoice', negate: false }] } });
    expect(searchLexical.mock.calls[0][1].ordering).toBe('relevance');

    query.mockReset(); searchLexical.mockReset();
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: true });
    await search({ userId: 'u1', parsed: { filters: [{ key: 'is', value: 'unread', negate: false }], terms: [] } });
    expect(searchLexical.mock.calls[0][1].ordering).toBe('date');
  });

  it('shapes rows into messages + page, clamping the limit to 200 and flagging hasMore on a full page', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: new Array(200).fill({ id: 'm' }), hasCondition: true });
    const res = await search({ userId: 'u1', limit: 9999, offset: 40, parsed: { filters: [], terms: [{ value: 'x', negate: false }] } });
    expect(res.messages).toHaveLength(200);
    expect(res.mode).toBe('lexical');
    expect(res.page).toEqual({ offset: 40, limit: 200, hasMore: true });
    expect(searchLexical.mock.calls[0][1].limit).toBe(200);
  });

  it('returns empty when there is no real search condition', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: false });
    const res = await search({ userId: 'u1', parsed: { filters: [{ key: 'in', value: 'inbox', negate: false }], terms: [] } });
    expect(res.messages).toEqual([]);
    expect(res.page.hasMore).toBe(false);
  });
});

describe('searchService mode dispatch (Phase 4 Task 5)', () => {
  const hybridReq = (extra = {}) => ({
    userId: 'u1', mode: 'hybrid', limit: 50, offset: 0,
    parsed: { filters: [], terms: [{ value: 'quarterly', negate: false }, { value: 'revenue', negate: false }] },
    ...extra,
  });

  it('defaults to lexical and marks the mode', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: true });
    const res = await search({ userId: 'u1', parsed: { filters: [], terms: [{ value: 'hello', negate: false }] } });
    expect(res.mode).toBe('lexical');
    expect(res.fellBack).toBeUndefined();
    expect(hybrid.hybridSearch).not.toHaveBeenCalled();
  });

  it('hybrid success returns score-ordered messages with pool_saturated + the rich generation object, no total', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockResolvedValue({
      hits: [{ message_id: 'a', rrf_score: 0.04, subject: 's' }],
      poolSaturated: true, generation: { id: 7 },
    });
    const res = await search(hybridReq());
    expect(res.mode).toBe('hybrid');
    expect(res.pool_saturated).toBe(true);
    // Task 5b supersedes Task 5's bare generation.id with the rich object
    // fusedSearch/hybridSearch echoes back.
    expect(res.generation).toEqual({ id: 7 });
    expect(res.total).toBeUndefined();
    expect(res.messages[0].message_id).toBe('a');
  });

  it('additively aliases id onto message_id for BOTH vector and hybrid hits (mode-invariant seam contract), leaving message_id intact', async () => {
    // The vector/hybrid SQL (fusedSearch DISPLAY_COLS) projects the message id
    // as `message_id`, NOT `id` — the real seam shape the live MCP round-trip
    // exposed. The lexical path and every hit consumer (REST serialization, MCP
    // hydration via getMessageSummariesByIDs) key on `id`, so the seam must add
    // it for both modes. Regression guard for `semantic_search_messages`
    // returning 0.
    for (const mode of ['vector', 'hybrid']) {
      query.mockReset(); hybrid.hybridSearch.mockReset();
      withAccounts(['a1']);
      hybrid.hybridSearch.mockResolvedValue({
        hits: [{ message_id: 'real-uuid', uid: 7, folder: 'INBOX', subject: 'Run failed: CD deploy', rrf_score: 0.04 }],
        poolSaturated: false, generation: { id: 1 },
      });
      const res = await search({
        userId: 'u1', mode, limit: 50, offset: 0,
        parsed: { filters: [], terms: [{ value: 'deploy', negate: false }] },
      });
      expect(res.messages[0].message_id).toBe('real-uuid'); // unchanged — REST reads it
      expect(res.messages[0].id).toBe('real-uuid');          // additive alias — MCP hydration + lexical parity
    }
  });

  it('drops sub-2-char and punctuation-only terms from the semantic freeText, matching the lexical path\'s hygiene (review MINOR 3)', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockResolvedValue({ hits: [], poolSaturated: false, generation: null });
    await search(hybridReq({
      parsed: {
        filters: [],
        terms: [
          { value: 'quarterly', negate: false },
          { value: 'a', negate: false },      // 1-char — dropped
          { value: '!!!', negate: false },     // punctuation-only — dropped
          { value: 'revenue', negate: false },
        ],
      },
    }));
    expect(hybrid.hybridSearch.mock.calls[0][0].freeText).toBe('quarterly revenue');
  });

  it('falls back to lexical (fellBack:true) when hybrid degrades', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [{ id: 'lex1', subject: 'kw' }], hasCondition: true });
    hybrid.hybridSearch.mockRejectedValue(Object.assign(new Error('building'), { code: 'INDEX_BUILDING' }));
    const res = await search(hybridReq());
    expect(res.mode).toBe('lexical');
    expect(res.fellBack).toBe(true);
    expect(res.messages[0].id).toBe('lex1');
  });

  it('serves a filter-only semantic query lexically WITHOUT fellBack — not an "index building" event (Wave D Fix 6)', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [{ id: 'lex1' }], hasCondition: true });
    hybrid.hybridSearch.mockRejectedValue(new hybrid.MissingFreeTextError());
    const res = await search(hybridReq({ parsed: { filters: [{ key: 'is', value: 'unread', negate: false }], terms: [] } }));
    expect(res.mode).toBe('lexical');
    expect(res.fellBack).toBeUndefined(); // the UI keys an amber degradation hint on fellBack
    expect(res.messages[0].id).toBe('lex1');
  });

  it('propagates an unexpected (non-degradation) error instead of falling back', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockRejectedValue(new Error('boom'));
    hybrid.isLexicalFallback.mockReturnValue(false);
    await expect(search(hybridReq())).rejects.toThrow('boom');
  });
});

describe('searchService fused folder scope + negation (Fix 2 + Fix 4)', () => {
  const semReq = (extra = {}) => ({
    userId: 'u1', mode: 'hybrid', limit: 50, offset: 0,
    parsed: { filters: [], terms: [{ value: 'invoice', negate: false }] },
    ...extra,
  });
  // Run the buildFilters closure the semantic branch hands hybridSearch, so we
  // can inspect the SQL predicates + params it applies to BOTH fused legs.
  function runBuildFilters() {
    const buildFilters = hybrid.hybridSearch.mock.calls[0][0].buildFilters;
    const params = [];
    let p = 2;
    const bind = (v) => { params.push(v); return `$${p++}`; };
    return { clauses: buildFilters(bind), params };
  }

  beforeEach(() => {
    hybrid.hybridSearch.mockResolvedValue({ hits: [], poolSaturated: false, generation: null });
  });

  it('scopes the fused query to an in:<folder> for BOTH vector and hybrid (never leaks other folders)', async () => {
    for (const mode of ['vector', 'hybrid']) {
      query.mockReset(); hybrid.hybridSearch.mockReset();
      hybrid.hybridSearch.mockResolvedValue({ hits: [], poolSaturated: false, generation: null });
      withAccounts(['a1']);
      await search(semReq({ mode, parsed: { filters: [{ key: 'in', value: 'sent', negate: false }], terms: [{ value: 'invoice', negate: false }] } }));
      const { clauses, params } = runBuildFilters();
      expect(clauses.some((c) => /m\.folder ILIKE .+ OR m\.folder ILIKE/.test(c))).toBe(true);
      expect(params).toContain('sent');
      expect(params).toContain('%/sent');
    }
  });

  it('honors an exact REST folderParam on the fused query', async () => {
    withAccounts(['a1']);
    await search(semReq({ folderParam: 'INBOX' }));
    const { clauses, params } = runBuildFilters();
    expect(clauses.some((c) => c === 'm.folder = $2')).toBe(true);
    expect(params).toContain('INBOX');
  });

  it('defaults the fused query to the trash-excluding scope when no folder is specified', async () => {
    withAccounts(['a1']);
    await search(semReq());
    const { clauses } = runBuildFilters();
    expect(clauses.some((c) => /NOT EXISTS/.test(c) && /%trash%/.test(c))).toBe(true);
  });

  it('enforces a negated free-text term as a NOT-condition on the fused query (invoice -draft excludes drafts)', async () => {
    withAccounts(['a1']);
    await search(semReq({ parsed: { filters: [], terms: [{ value: 'invoice', negate: false }, { value: 'draft', negate: true }] } }));
    const { clauses, params } = runBuildFilters();
    // Positive term drives freeText (embedded + BM25 leg); the negated term becomes
    // a stopword-guarded NOT COALESCE(...) filter using the SAME prefix-aware
    // FTS builder as lexical (guard OUTSIDE the NOT, so a negated stopword
    // contributes nothing instead of excluding everything — Fix 1).
    expect(hybrid.hybridSearch.mock.calls[0][0].freeText).toBe('invoice');
    const notClause = clauses.find((c) => /OR NOT COALESCE/.test(c));
    expect(notClause).toBeDefined();
    expect(notClause).toMatch(/^\(numnode\(to_tsquery\('english', quote_literal\(\$\d+\) \|\| ':\*'\)\) = 0 OR NOT COALESCE/);
    expect(notClause).toContain("m.search_fts @@ to_tsquery('english', quote_literal($");
    expect(params).toContain('draft');
  });

  it('drops a sub-2-char / punctuation-only negated term from the fused NOT-conditions (lexical hygiene parity)', async () => {
    withAccounts(['a1']);
    await search(semReq({ parsed: { filters: [], terms: [{ value: 'invoice', negate: false }, { value: 'x', negate: true }, { value: '!!!', negate: true }] } }));
    const { clauses } = runBuildFilters();
    expect(clauses.some((c) => /NOT COALESCE/.test(c))).toBe(false);
  });
});

describe('searchService semantic pagination hasMore (Fix 3)', () => {
  const semReq = (extra = {}) => ({
    userId: 'u1', mode: 'hybrid', limit: 2, offset: 0,
    parsed: { filters: [], terms: [{ value: 'invoice', negate: false }] },
    ...extra,
  });

  it('fetches window+1 and flags hasMore when a sentinel hit is present', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockResolvedValue({
      hits: [{ message_id: 'a', rrf_score: 3 }, { message_id: 'b', rrf_score: 2 }, { message_id: 'c', rrf_score: 1 }],
      poolSaturated: false, generation: null,
    });
    const res = await search(semReq());
    expect(hybrid.hybridSearch.mock.calls[0][0].limit).toBe(3); // window(2) + 1
    expect(res.messages).toHaveLength(2);                        // page sliced to limit
    expect(res.page.hasMore).toBe(true);
  });

  it('flags hasMore false when exactly the window is returned', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockResolvedValue({
      hits: [{ message_id: 'a', rrf_score: 2 }, { message_id: 'b', rrf_score: 1 }],
      poolSaturated: false, generation: null,
    });
    const res = await search(semReq());
    expect(res.messages).toHaveLength(2);
    expect(res.page.hasMore).toBe(false);
  });

  it('respects offset: window+1 = offset+limit+1 and slices the page', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockResolvedValue({
      hits: [{ message_id: 'a' }, { message_id: 'b' }, { message_id: 'c' }, { message_id: 'd' }, { message_id: 'e' }],
      poolSaturated: false, generation: null,
    });
    const res = await search(semReq({ offset: 2, limit: 2 }));
    expect(hybrid.hybridSearch.mock.calls[0][0].limit).toBe(5); // offset(2)+limit(2)+1
    expect(res.messages.map((m) => m.message_id)).toEqual(['c', 'd']);
    expect(res.page.hasMore).toBe(true); // 5 hits > window(4)
  });
});

describe('searchService envelope (Task 5b)', () => {
  const hybridReq2 = (extra = {}) => ({
    userId: 'u1', mode: 'hybrid', limit: 50, offset: 0,
    parsed: { filters: [], terms: [{ value: 'q', negate: false }] },
    ...extra,
  });

  it('returns the rich generation object and per-hit score under explain', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockResolvedValue({
      hits: [{ message_id: 'a', rrf_score: 0.04, bm25_score: 0.01, vector_score: 0.9, subject_boosted: true, best_char_start: null }],
      poolSaturated: false, generation: { id: 7, model: 'm', dimension: 4, fingerprint: 'm:4:x', state: 'active' },
    });
    const res = await search(hybridReq2({ explain: true }));
    expect(res.generation).toEqual({ id: 7, model: 'm', dimension: 4, fingerprint: 'm:4:x', state: 'active' });
    expect(res.messages[0].score).toEqual({ rrf: 0.04, bm25: 0.01, vector: 0.9, subject_boosted: true });
  });

  it('attaches best_chunk metadata under scope=body', async () => {
    withAccounts(['a1']);
    hybrid.hybridSearch.mockResolvedValue({
      hits: [{ message_id: 'a', rrf_score: 0.04, vector_score: 0.9, best_chunk_index: 2, best_char_start: 6, best_char_end: 40 }],
      poolSaturated: false, generation: { id: 1, model: 'm', dimension: 4, fingerprint: 'f', state: 'active' },
    });
    const res = await search(hybridReq2({ scope: 'body' }));
    expect(res.messages[0].best_chunk).toEqual({ chunk_index: 2, char_start: 6, char_end: 40, score: 0.9 });
  });
});
