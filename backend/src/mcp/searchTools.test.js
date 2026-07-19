import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/search/queryParser.js', () => ({ parseQuery: vi.fn() }));
vi.mock('../services/search/searchService.js', () => ({ search: vi.fn() }));
vi.mock('../services/embeddings/chunkmatch.js', () => ({ matchFromChunk: vi.fn(), matchesInMessage: vi.fn() }));
// The search seam returns raw rows; MCP hydrates hit ids into MessageSummary shape.
vi.mock('./engineAdapter.js', () => ({ getMessageSummariesByIDs: vi.fn(), resolveAccountScope: vi.fn() }));
import { parseQuery } from '../services/search/queryParser.js';
import { search } from '../services/search/searchService.js';
import { matchFromChunk } from '../services/embeddings/chunkmatch.js';
import { getMessageSummariesByIDs, resolveAccountScope } from './engineAdapter.js';
import { handleSearchMetadata, handleSearchMessageBodies, handleSemanticSearchMessages } from './searchTools.js';

class VectorUnavailableError extends Error {
  constructor(reason) { super(reason); this.name = 'VectorUnavailableError'; this.reason = reason; }
}

const scope = { userId: 'u1', accountIds: ['acc-1'] };
function payload(r) { return JSON.parse(r.content[0].text); }
// Hydration echoes each requested id as a minimal summary unless a test overrides it.
function echoSummaries(rows) {
  getMessageSummariesByIDs.mockImplementation(async (ids) => ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean));
}

beforeEach(() => {
  parseQuery.mockReset(); search.mockReset(); matchFromChunk.mockReset(); getMessageSummariesByIDs.mockReset();
  resolveAccountScope.mockReset();
  // Default: no `account` narrowing — pass the token's full scope through.
  resolveAccountScope.mockImplementation(async (account, ids) => ({ accountIds: ids }));
});

describe('search_metadata', () => {
  it('requires a query', async () => {
    const r = await handleSearchMetadata({}, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('query parameter is required');
  });

  it('hydrates hits into the msgvault envelope with a real total, scoped to the token accounts', async () => {
    parseQuery.mockReturnValue({ filters: [{ key: 'from', value: 'alice' }], terms: [], unsupported: [] });
    search.mockResolvedValue({
      messages: [{ id: 'm1' }], // raw seam row — only the id is load-bearing for hydration
      total: 5, mode: 'lexical', page: { offset: 0, limit: 20, hasMore: true },
    });
    echoSummaries([{ id: 'm1', subject: 'Hi', to: [{ Email: 'c@d.com', Name: 'C' }] }]);
    const r = await handleSearchMetadata({ query: 'from:alice' }, scope);
    const body = payload(r);
    expect(body).toEqual({ data: [{ id: 'm1', subject: 'Hi', to: [{ Email: 'c@d.com', Name: 'C' }] }], total: 5, returned: 1, offset: 0, has_more: true });
    // scope + parsed handed to the seam; MCP never builds SQL; hydration is scoped
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: 'lexical', scope: 'metadata', accountIds: ['acc-1'], limit: 20, offset: 0 }));
    expect(getMessageSummariesByIDs).toHaveBeenCalledWith(['m1'], ['acc-1']);
  });

  it('clamps limit to 50', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'x', negate: false }], unsupported: [] });
    search.mockResolvedValue({ messages: [], total: 0, mode: 'lexical', page: { offset: 0, limit: 50, hasMore: false } });
    getMessageSummariesByIDs.mockResolvedValue([]);
    await handleSearchMetadata({ query: 'x', limit: 999 }, scope);
    expect(search.mock.calls[0][0].limit).toBe(50);
  });

  it('narrows scope to a resolved account id (the account arg is no longer a silent no-op)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'x', negate: false }], unsupported: [] });
    resolveAccountScope.mockResolvedValue({ accountIds: ['acc-2'] });
    search.mockResolvedValue({ messages: [{ id: 'm1' }], total: 1, mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false } });
    echoSummaries([{ id: 'm1', subject: 'Hi' }]);
    await handleSearchMetadata({ query: 'x', account: 'work@x.com' }, scope);
    expect(resolveAccountScope).toHaveBeenCalledWith('work@x.com', ['acc-1']);
    expect(search.mock.calls[0][0].accountIds).toEqual(['acc-2']); // narrowed, not the full token scope
    expect(getMessageSummariesByIDs).toHaveBeenCalledWith(['m1'], ['acc-2']); // hydration narrowed too
  });

  it('rejects an unknown account without querying (msgvault getAccountID parity)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'x', negate: false }], unsupported: [] });
    resolveAccountScope.mockResolvedValue({ error: 'account not found: nope@x.com' });
    const r = await handleSearchMetadata({ query: 'x', account: 'nope@x.com' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('account not found: nope@x.com');
    expect(search).not.toHaveBeenCalled();
  });

  it('returns parser value errors verbatim instead of silently widening (msgvault q.Err, handlers.go:373-375)', async () => {
    parseQuery.mockReturnValue({
      filters: [], terms: [], unsupported: [],
      errors: ['invalid value "xyz" for older_than: — expected a relative age like 7d, 2w, 1m, or 1y'],
    });
    const r = await handleSearchMetadata({ query: 'older_than:xyz' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('invalid value "xyz" for older_than: — expected a relative age like 7d, 2w, 1m, or 1y');
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects schema-unsupported operators with the unsupported_search_operator taxonomy (handlers.go:408-428)', async () => {
    parseQuery.mockReturnValue({
      filters: [], terms: [{ value: 'x', negate: false }],
      unsupported: [{ key: 'label', token: 'label:promos' }, { key: 'larger', token: 'larger:5M' }],
      errors: [],
    });
    const r = await handleSearchMetadata({ query: 'x label:promos larger:5M' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^unsupported_search_operator: label: /);
    expect(r.content[0].text).toContain('larger:');
    expect(search).not.toHaveBeenCalled();
  });

  it('treats literal list:/list-id: terms as unsupported (msgvault parser set, parser.go:270-273, hoisted to the handler)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'list-id:foo', negate: false }], unsupported: [], errors: [] });
    const r = await handleSearchMetadata({ query: 'list-id:foo' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^unsupported_search_operator: list-id: is Gmail-only syntax/);
    expect(search).not.toHaveBeenCalled();
  });

  it('always carries a numeric total, even when the seam omits it (degenerate all-terms-dropped query)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'a', negate: false }], unsupported: [], errors: [] });
    search.mockResolvedValue({ messages: [], mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false } }); // no total key
    getMessageSummariesByIDs.mockResolvedValue([]);
    const body = payload(await handleSearchMetadata({ query: 'a' }, scope));
    expect(body.total).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('emits sent_at as RFC3339 without milliseconds (Go wire format)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'x', negate: false }], unsupported: [], errors: [] });
    search.mockResolvedValue({ messages: [{ id: 'm1' }], total: 1, mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false } });
    echoSummaries([{ id: 'm1', sent_at: '2024-01-01T00:00:00.000Z' }]);
    const body = payload(await handleSearchMetadata({ query: 'x' }, scope));
    expect(body.data[0].sent_at).toBe('2024-01-01T00:00:00Z');
  });
});

describe('search_message_bodies', () => {
  it('rejects filter-only queries (no free-text term)', async () => {
    parseQuery.mockReturnValue({ filters: [{ key: 'from', value: 'alice' }], terms: [], unsupported: [] });
    const r = await handleSearchMessageBodies({ query: 'from:alice' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('requires at least one free-text term');
  });

  it('returns keyword envelope: total -1, mode keyword, empty generation, snippet-only matches on a hydrated summary', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] });
    search.mockResolvedValue({
      messages: [{ id: 'm1', body_text: 'the budget is approved. budget notes.' }],
      mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false },
    });
    echoSummaries([{ id: 'm1', subject: 'Q3', from_email: 'a@b.com' }]);
    const r = await handleSearchMessageBodies({ query: 'budget' }, scope);
    const body = JSON.parse(r.content[0].text);
    expect(body.total).toBe(-1);
    expect(body.mode).toBe('keyword');
    expect(body.pool_saturated).toBe(false);
    expect(body.generation).toEqual({ id: 0, model: '', dimension: 0, fingerprint: '', state: '' });
    expect(body.data[0].subject).toBe('Q3'); // hydrated summary, not the raw row
    expect(body.data[0]).not.toHaveProperty('body_text'); // body is not leaked to the wire
    expect(body.data[0].matches[0]).toHaveProperty('snippet');
    expect(body.data[0].matches[0]).not.toHaveProperty('char_offset'); // keyword body = snippet only
  });

  it('narrows scope to a resolved account id', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] });
    resolveAccountScope.mockResolvedValue({ accountIds: ['acc-2'] });
    search.mockResolvedValue({ messages: [{ id: 'm1', body_text: 'budget' }], mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false } });
    echoSummaries([{ id: 'm1', subject: 'Q3' }]);
    await handleSearchMessageBodies({ query: 'budget', account: 'work@x.com' }, scope);
    expect(search.mock.calls[0][0].accountIds).toEqual(['acc-2']);
    expect(getMessageSummariesByIDs).toHaveBeenCalledWith(['m1'], ['acc-2']);
  });

  it('rejects an unknown account', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] });
    resolveAccountScope.mockResolvedValue({ error: 'account not found: nope@x.com' });
    const r = await handleSearchMessageBodies({ query: 'budget', account: 'nope@x.com' }, scope);
    expect(r.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects explicit mode=vector/hybrid — keyword-only tool (msgvault handlers.go:447-452)', async () => {
    for (const mode of ['vector', 'hybrid']) {
      const r = await handleSearchMessageBodies({ query: 'budget', mode }, scope);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(
        `invalid mode "${mode}": search_message_bodies is keyword-only; use semantic_search_messages for vector or hybrid search`,
      );
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects unknown modes with the only-supports wording (msgvault handlers.go:453-457)', async () => {
    const r = await handleSearchMessageBodies({ query: 'budget', mode: 'fuzzy' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      'invalid mode "fuzzy": search_message_bodies only supports keyword search; use semantic_search_messages for vector or hybrid search',
    );
  });

  it('accepts an explicit mode=keyword', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] });
    search.mockResolvedValue({ messages: [], mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false } });
    getMessageSummariesByIDs.mockResolvedValue([]);
    const r = await handleSearchMessageBodies({ query: 'budget', mode: 'keyword' }, scope);
    expect(r.isError).toBeFalsy();
  });

  it('returns parser value errors and unsupported operators before the free-text check (msgvault ordering)', async () => {
    parseQuery.mockReturnValue({
      filters: [], terms: [], unsupported: [{ key: 'bcc', token: 'bcc:x@y.com' }], errors: [],
    });
    const r = await handleSearchMessageBodies({ query: 'bcc:x@y.com' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^unsupported_search_operator: bcc: /);

    parseQuery.mockReturnValue({
      filters: [], terms: [], unsupported: [],
      errors: ['invalid value "5X" for smaller: — expected a size like 5M, 100K, or 1G'],
    });
    const r2 = await handleSearchMessageBodies({ query: 'smaller:5X' }, scope);
    expect(r2.content[0].text).toBe('invalid value "5X" for smaller: — expected a size like 5M, 100K, or 1G');
    expect(search).not.toHaveBeenCalled();
  });

  it('OMITS matches/matches_truncated when empty/false and emits matches_truncated past 5 excerpts (Go omitempty, handlers.go:339-341)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] });
    // m1: term absent from the body → no snippets; m2: 7 occurrences spaced
    // past the 300-byte context window (no merge) → 5 capped + truncated.
    const spread = Array.from({ length: 7 }, () => 'budget').join(' filler'.repeat(120));
    search.mockResolvedValue({
      messages: [{ id: 'm1', body_text: 'nothing relevant here' }, { id: 'm2', body_text: spread }],
      mode: 'lexical', page: { offset: 0, limit: 20, hasMore: false },
    });
    echoSummaries([{ id: 'm1', subject: 'A' }, { id: 'm2', subject: 'B' }]);
    const body = payload(await handleSearchMessageBodies({ query: 'budget' }, scope));
    expect(body.data[0]).not.toHaveProperty('matches');
    expect(body.data[0]).not.toHaveProperty('matches_truncated');
    expect(body.data[1].matches).toHaveLength(5);
    expect(body.data[1].matches_truncated).toBe(true);
  });
});

describe('semantic_search_messages', () => {
  it('rejects filter-only queries with missing_free_text', async () => {
    parseQuery.mockReturnValue({ filters: [{ key: 'from', value: 'alice' }], terms: [], unsupported: [] });
    const r = await handleSemanticSearchMessages({ query: 'from:alice' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^missing_free_text: mode=hybrid/);
  });

  it('rejects mode=keyword', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'x', negate: false }], unsupported: [] });
    const r = await handleSemanticSearchMessages({ query: 'x', mode: 'keyword' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/invalid mode "keyword"/);
  });

  it('returns vector_not_enabled when the seam is strict-unavailable', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [] });
    search.mockRejectedValue(new VectorUnavailableError('vector_not_enabled'));
    const r = await handleSemanticSearchMessages({ query: 'travel plans' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('vector_not_enabled: vector search is not configured on this server');
  });

  it('builds matches from best_chunk via matchFromChunk on a hydrated summary, with mode/pool_saturated/generation and per-signal scores when explain', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [] });
    matchFromChunk.mockResolvedValue({ char_offset: 42, snippet: 'flights', line: 3, score: 0.9 });
    search.mockResolvedValue({
      // Real hybrid/vector seam shape: keyed on message_id, with the additive
      // `id` alias searchService now emits (mode-invariant with the lexical path).
      messages: [{ message_id: 'm1', id: 'm1',
        best_chunk: { chunk_index: 2, char_start: 100, char_end: 180, score: 0.9 },
        score: { rrf: 0.5, bm25: 1.2, vector: 0.8, subject_boosted: true } }],
      mode: 'hybrid', page: { offset: 0, limit: 20, hasMore: false },
      pool_saturated: true,
      generation: { id: 3, model: 'text-embedding-3-small', dimension: 1536, fingerprint: 'fp', state: 'active' },
    });
    echoSummaries([{ id: 'm1', subject: 'Trip' }]);
    const r = await handleSemanticSearchMessages({ query: 'travel plans', explain: true }, scope);
    const body = JSON.parse(r.content[0].text);
    expect(body.total).toBe(-1);
    expect(body.mode).toBe('hybrid');
    expect(body.pool_saturated).toBe(true);
    expect(body.generation).toEqual({ id: 3, model: 'text-embedding-3-small', dimension: 1536, fingerprint: 'fp', state: 'active' });
    expect(body.data[0].subject).toBe('Trip'); // hydrated summary
    expect(body.data[0].score).toEqual({ rrf: 0.5, bm25: 1.2, vector: 0.8, subject_boosted: true });
    expect(body.data[0].matches).toEqual([{ char_offset: 42, snippet: 'flights', line: 3, score: 0.9 }]);
    expect(body.data[0]).not.toHaveProperty('best_chunk');
    expect(matchFromChunk).toHaveBeenCalledWith('m1', { chunk_index: 2, char_start: 100, char_end: 180, score: 0.9 }, { accountIds: scope.accountIds });
  });

  it('drops the excerpt when its score is below min_score (ranking unaffected)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [] });
    matchFromChunk.mockResolvedValue({ snippet: 'weak', score: 0.1 });
    search.mockResolvedValue({
      messages: [{ message_id: 'm1', id: 'm1', best_chunk: { chunk_index: 0, char_start: 10, char_end: 20, score: 0.1 } }],
      mode: 'vector', page: { offset: 0, limit: 20, hasMore: false }, pool_saturated: false,
      generation: { id: 1, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' },
    });
    echoSummaries([{ id: 'm1', subject: 'Trip' }]);
    const r = await handleSemanticSearchMessages({ query: 'travel', mode: 'vector', min_score: 0.5 }, scope);
    const body = JSON.parse(r.content[0].text);
    expect(body.data[0]).not.toHaveProperty('matches'); // excerpt dropped, message still returned
    expect(body.mode).toBe('vector');
  });

  it('narrows scope to a resolved account id (search + hydration + matchFromChunk)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [] });
    resolveAccountScope.mockResolvedValue({ accountIds: ['acc-2'] });
    matchFromChunk.mockResolvedValue({ snippet: 'x', score: 0.9 });
    search.mockResolvedValue({
      messages: [{ message_id: 'm1', id: 'm1', best_chunk: { chunk_index: 0, char_start: 0, char_end: 5, score: 0.9 } }],
      mode: 'hybrid', page: { offset: 0, limit: 20, hasMore: false }, pool_saturated: false,
      generation: { id: 1, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' },
    });
    echoSummaries([{ id: 'm1', subject: 'Trip' }]);
    await handleSemanticSearchMessages({ query: 'travel', account: 'work@x.com' }, scope);
    expect(search.mock.calls[0][0].accountIds).toEqual(['acc-2']);
    expect(getMessageSummariesByIDs).toHaveBeenCalledWith(['m1'], ['acc-2']);
    expect(matchFromChunk).toHaveBeenCalledWith('m1', expect.any(Object), { accountIds: ['acc-2'] });
  });

  it('rejects an unknown account', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [] });
    resolveAccountScope.mockResolvedValue({ error: 'account not found: nope@x.com' });
    const r = await handleSemanticSearchMessages({ query: 'travel', account: 'nope@x.com' }, scope);
    expect(r.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns parser value errors verbatim and unsupported operators as taxonomy errors', async () => {
    parseQuery.mockReturnValue({
      filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [],
      errors: ['invalid value "13" for newer_than: — expected a relative age like 7d, 2w, 1m, or 1y'],
    });
    const r = await handleSemanticSearchMessages({ query: 'travel newer_than:13' }, scope);
    expect(r.content[0].text).toBe('invalid value "13" for newer_than: — expected a relative age like 7d, 2w, 1m, or 1y');

    parseQuery.mockReturnValue({
      filters: [], terms: [{ value: 'travel', negate: false }],
      unsupported: [{ key: 'smaller', token: 'smaller:1M' }], errors: [],
    });
    const r2 = await handleSemanticSearchMessages({ query: 'travel smaller:1M' }, scope);
    expect(r2.content[0].text).toMatch(/^unsupported_search_operator: smaller: /);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects offsets past the hybrid ranking window with pagination_limit (msgvault handlers.go:656-663)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'x', negate: false }], unsupported: [], errors: [] });
    const r = await handleSemanticSearchMessages({ query: 'x', offset: 100 }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      'pagination_limit: offset 100 exceeds hybrid ranking window (max 100); use search_metadata or search_message_bodies for deeper pagination',
    );
    expect(search).not.toHaveBeenCalled();
  });

  it('maps a seam MissingFreeTextError to the missing_free_text result — never `internal error:` (msgvault handlers.go:631-635)', async () => {
    // 'a' survives the handler's raw-terms pre-check, but the seam's stricter
    // hygiene (sub-2-char tokens do not embed) throws MissingFreeTextError.
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'a', negate: false }], unsupported: [], errors: [] });
    class MissingFreeTextError extends Error { constructor() { super('missing_free_text'); this.name = 'MissingFreeTextError'; } }
    search.mockRejectedValue(new MissingFreeTextError());
    const r = await handleSemanticSearchMessages({ query: 'a' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('missing_free_text: mode=hybrid requires at least one free-text term; use search_metadata for filter-only queries');
  });

  it('explain omits rrf in mode=vector and subject_boosted when false (Go omitempty, handlers.go:563-572)', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [], errors: [] });
    search.mockResolvedValue({
      messages: [{ message_id: 'm1', id: 'm1', score: { rrf: 0.5, vector: 0.8, subject_boosted: false } }],
      mode: 'vector', page: { offset: 0, limit: 20, hasMore: false }, pool_saturated: false,
      generation: { id: 1, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' },
    });
    echoSummaries([{ id: 'm1', subject: 'Trip' }]);
    const body = payload(await handleSemanticSearchMessages({ query: 'travel', mode: 'vector', explain: true }, scope));
    expect(body.data[0].score).toEqual({ vector: 0.8 }); // no rrf (one signal), no false subject_boosted
  });

  it('explain keeps rrf in mode=hybrid but still omits a false subject_boosted', async () => {
    parseQuery.mockReturnValue({ filters: [], terms: [{ value: 'travel', negate: false }], unsupported: [], errors: [] });
    search.mockResolvedValue({
      messages: [{ message_id: 'm1', id: 'm1', score: { rrf: 0.5, bm25: 1.2, vector: 0.8, subject_boosted: false } }],
      mode: 'hybrid', page: { offset: 0, limit: 20, hasMore: false }, pool_saturated: false,
      generation: { id: 1, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' },
    });
    echoSummaries([{ id: 'm1', subject: 'Trip' }]);
    const body = payload(await handleSemanticSearchMessages({ query: 'travel', explain: true }, scope));
    expect(body.data[0].score).toEqual({ rrf: 0.5, bm25: 1.2, vector: 0.8 });
  });
});
