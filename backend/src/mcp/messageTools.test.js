import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./engineAdapter.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    getMessage: vi.fn(), listMessages: vi.fn(), listAccounts: vi.fn(), getTotalStats: vi.fn(), aggregate: vi.fn(), searchByDomains: vi.fn(),
    getMessageSummariesByIDs: vi.fn(), stageDeletion: vi.fn(),
    resolveAccountScope: vi.fn(), messageInScope: vi.fn(),
  };
});
vi.mock('./vectorStats.js', () => ({ collectStats: vi.fn() }));
vi.mock('../services/embeddings/hybrid.js', () => ({ resolveActiveGenerationFromConfig: vi.fn() }));
vi.mock('../services/embeddings/vectorStore.js', () => ({ loadVector: vi.fn(), annSearch: vi.fn() }));
vi.mock('../services/embeddings/chunkmatch.js', () => ({ matchesInMessage: vi.fn() }));
import * as adapter from './engineAdapter.js';
import { resolveAccountScope, messageInScope } from './engineAdapter.js';
import { collectStats } from './vectorStats.js';
import { resolveActiveGenerationFromConfig } from '../services/embeddings/hybrid.js';
import { loadVector, annSearch } from '../services/embeddings/vectorStore.js';
import { matchesInMessage } from '../services/embeddings/chunkmatch.js';

// The one vector-availability gate returns { cfg, generation }; a VectorUnavailableError
// (name + reason) thrown from it is what every degraded/disabled path surfaces.
class VUE extends Error { constructor(r) { super(r); this.name = 'VectorUnavailableError'; this.reason = r; } }
import {
  handleGetMessage, handleListMessages, handleGetStats, handleAggregate,
  handleSearchByDomains, handleFindSimilarMessages, handleSearchInMessage, handleStageDeletion,
} from './messageTools.js';

const scope = { userId: 'u', accountIds: ['acc-1'] };
const detailRow = {
  id: 'm1', account_id: 'acc-1', message_id: '<x>', thread_id: 't', subject: 'S', snippet: '',
  from_email: 'a@b.com', from_name: 'A', to_addresses: [], cc_addresses: [], date: new Date('2024-01-01T00:00:00Z'),
  has_attachments: false, attachments: [], flags: [], folder: 'INBOX',
  body_text: 'café — meeting notes and a much longer body '.repeat(100), body_html: '',
};

beforeEach(() => {
  adapter.getMessage.mockReset();
  resolveAccountScope.mockReset();
  messageInScope.mockReset();
  // Defaults: no account narrowing; seed messages are in scope unless a test says otherwise.
  resolveAccountScope.mockImplementation(async (account, ids) => ({ accountIds: ids }));
  messageInScope.mockResolvedValue(true);
});

describe('get_message', () => {
  it('404s a missing message with a string id', async () => {
    adapter.getMessage.mockResolvedValue(null);
    const r = await handleGetMessage({ id: 'nope' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('message not found');
  });

  it('pages by BYTES, never splitting a rune, with correct body_length', async () => {
    adapter.getMessage.mockResolvedValue(detailRow);
    const total = Buffer.byteLength(detailRow.body_text, 'utf8');
    const r = await handleGetMessage({ id: 'm1', max_chars: 20 }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.body_length).toBe(total);
    expect(b.offset).toBe(0);
    expect(b.body_returned).toBeLessThanOrEqual(20);
    expect(b.has_more).toBe(true);
    // returned slice is valid UTF-8 (no replacement char from a split é)
    expect(b.body_text).not.toContain('�');
    expect(b.body_format).toBe('text');
    expect(b.id).toBe('m1'); // uuid string
    // scoped read
    expect(adapter.getMessage).toHaveBeenCalledWith('m1', ['acc-1']);
  });

  it('center_at round-trips a byte offset into a window around it', async () => {
    adapter.getMessage.mockResolvedValue(detailRow);
    const r = await handleGetMessage({ id: 'm1', center_at: 200, max_chars: 100 }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.offset).toBeLessThanOrEqual(200);
    expect(b.offset + b.body_returned).toBeGreaterThanOrEqual(200);
  });

  it('clamps max_chars to 4000', async () => {
    adapter.getMessage.mockResolvedValue({ ...detailRow, body_text: 'z'.repeat(9000) });
    const r = await handleGetMessage({ id: 'm1', max_chars: 99999 }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.body_returned).toBe(4000);
  });

  it('full_body returns the whole body ignoring paging', async () => {
    adapter.getMessage.mockResolvedValue({ ...detailRow, body_text: 'z'.repeat(5000) });
    const r = await handleGetMessage({ id: 'm1', full_body: true }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.body_returned).toBe(5000);
    expect(b.has_more).toBe(false);
  });

  it('emits sent_at as RFC3339 without milliseconds (Go wire format)', async () => {
    adapter.getMessage.mockResolvedValue(detailRow);
    const b = JSON.parse((await handleGetMessage({ id: 'm1' }, scope)).content[0].text);
    expect(b.sent_at).toBe('2024-01-01T00:00:00Z');
  });

  it('html-only message pages the html body with body_format=html under auto', async () => {
    adapter.getMessage.mockResolvedValue({ ...detailRow, body_text: '', body_html: '<p>hello world</p>' });
    const r = await handleGetMessage({ id: 'm1' }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.body_format).toBe('html');
    expect(b.body_html).toContain('hello');
    expect(b.body_text).toBe('');
  });
});

describe('list_messages', () => {
  beforeEach(() => { adapter.listMessages.mockReset(); adapter.listAccounts.mockReset(); });

  it('returns a newest-first envelope with total=-1 and pages via has_more (limit+1 over-fetch)', async () => {
    // 21 rows for a default limit of 20 -> has_more true, sliced to 20.
    adapter.listMessages.mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ id: `m${i}` })));
    const r = await handleListMessages({}, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.total).toBe(-1);
    expect(b.returned).toBe(20);
    expect(b.has_more).toBe(true);
    expect(adapter.listMessages).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['acc-1'], limit: 21, offset: 0 }));
  });

  it('threads a string conversation_id filter through to listMessages', async () => {
    adapter.listMessages.mockResolvedValue([]);
    await handleListMessages({ conversation_id: 'tid-1' }, scope);
    expect(adapter.listMessages).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'tid-1' }));
  });

  it('resolves an account email to its id and narrows the scope', async () => {
    resolveAccountScope.mockResolvedValue({ accountIds: ['acc-2'] });
    adapter.listMessages.mockResolvedValue([]);
    await handleListMessages({ account: 'c@d.com' }, scope);
    expect(resolveAccountScope).toHaveBeenCalledWith('c@d.com', ['acc-1']);
    expect(adapter.listMessages).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['acc-2'] }));
  });

  it('404-style errors an unknown account (msgvault getAccountID parity)', async () => {
    resolveAccountScope.mockResolvedValue({ error: 'account not found: nope@x.com' });
    const r = await handleListMessages({ account: 'nope@x.com' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('account not found: nope@x.com');
  });

  it('rejects malformed after/before dates before touching the engine (msgvault getDateArg, handlers.go:265-275)', async () => {
    for (const [key, bad] of [['after', '13/45/2024'], ['before', '2024-02-31']]) {
      const r = await handleListMessages({ [key]: bad }, scope);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(`invalid ${key} date "${bad}": expected YYYY-MM-DD`);
    }
    expect(adapter.listMessages).not.toHaveBeenCalled();
  });

  it('emits sent_at as RFC3339 without milliseconds (Go wire format)', async () => {
    adapter.listMessages.mockResolvedValue([{ id: 'm1', sent_at: '2024-01-01T00:00:00.000Z' }]);
    const r = await handleListMessages({}, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.data[0].sent_at).toBe('2024-01-01T00:00:00Z');
  });
});

describe('get_stats', () => {
  beforeEach(() => { adapter.getTotalStats.mockReset(); adapter.listAccounts.mockReset(); collectStats.mockReset(); });

  const stats = { MessageCount: 10, TotalSize: 500, AttachmentCount: 2, AttachmentSize: 0, LabelCount: 3, AccountCount: 1, ActiveMessageCount: 10, SourceDeletedMessageCount: 0 };
  const accounts = [{ ID: 'acc-1', SourceType: 'imap', Identifier: 'a@b.com', DisplayName: 'Work' }];

  it('omits vector_search when vector search is disabled (collectStats null)', async () => {
    adapter.getTotalStats.mockResolvedValue(stats);
    adapter.listAccounts.mockResolvedValue(accounts);
    collectStats.mockResolvedValue(null);
    const r = await handleGetStats({}, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.stats).toEqual(stats);
    expect(b.accounts).toEqual(accounts);
    expect(b).not.toHaveProperty('vector_search');
    expect(adapter.getTotalStats).toHaveBeenCalledWith(['acc-1']);
  });

  it('includes the StatsView when vector search is enabled', async () => {
    adapter.getTotalStats.mockResolvedValue(stats);
    adapter.listAccounts.mockResolvedValue(accounts);
    const vs = { enabled: true, active_generation: null, missing_embeddings_total: 4 };
    collectStats.mockResolvedValue(vs);
    const r = await handleGetStats({}, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.vector_search).toEqual(vs);
  });

  it('survives a broken vector sub-query (omits vector_search, keeps stats)', async () => {
    adapter.getTotalStats.mockResolvedValue(stats);
    adapter.listAccounts.mockResolvedValue(accounts);
    collectStats.mockRejectedValue(new Error('boom'));
    const r = await handleGetStats({}, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.stats).toEqual(stats);
    expect(b).not.toHaveProperty('vector_search');
  });
});

describe('aggregate', () => {
  beforeEach(() => { adapter.aggregate.mockReset(); adapter.listAccounts.mockReset(); });

  it('requires group_by', async () => {
    const r = await handleAggregate({}, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('group_by parameter is required');
  });

  it('rejects an invalid group_by', async () => {
    const r = await handleAggregate({ group_by: 'colour' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('invalid group_by: colour');
  });

  it('returns the raw AggregateRow array (no envelope), default limit 50, scoped', async () => {
    const rows = [{ Key: 'a@b.com', Count: 3, TotalSize: 10, AttachmentSize: 0, AttachmentCount: 1, TotalUnique: 5 }];
    adapter.aggregate.mockResolvedValue(rows);
    const r = await handleAggregate({ group_by: 'sender' }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b).toEqual(rows);
    expect(adapter.aggregate).toHaveBeenCalledWith('sender', expect.objectContaining({ accountIds: ['acc-1'], limit: 50 }));
  });

  it('rejects malformed after/before dates instead of leaking a raw PG error (msgvault getDateArg)', async () => {
    const r = await handleAggregate({ group_by: 'sender', after: 'notadate' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('invalid after date "notadate": expected YYYY-MM-DD');
    expect(adapter.aggregate).not.toHaveBeenCalled();
  });
});

describe('search_by_domains', () => {
  beforeEach(() => adapter.searchByDomains.mockReset());

  it('requires domains', async () => {
    const r = await handleSearchByDomains({}, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('domains is required');
  });

  it('splits/trims the CSV, default limit 100, scoped, returns the raw array', async () => {
    const rows = [{ id: 'm1', from_email: 'x@gobright.com' }];
    adapter.searchByDomains.mockResolvedValue(rows);
    const r = await handleSearchByDomains({ domains: ' gobright.com , ascentae.com ' }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b).toEqual(rows);
    expect(adapter.searchByDomains).toHaveBeenCalledWith(['gobright.com', 'ascentae.com'], undefined, undefined, 100, 0, ['acc-1']);
  });

  it('rejects malformed after/before dates and emits sent_at as RFC3339 (Go wire format)', async () => {
    const bad = await handleSearchByDomains({ domains: 'x.com', before: '2024-1-1' }, scope);
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('invalid before date "2024-1-1": expected YYYY-MM-DD');
    expect(adapter.searchByDomains).not.toHaveBeenCalled();

    adapter.searchByDomains.mockResolvedValue([{ id: 'm1', sent_at: '2024-01-01T00:00:00.000Z' }]);
    const ok = await handleSearchByDomains({ domains: 'x.com' }, scope);
    expect(JSON.parse(ok.content[0].text)[0].sent_at).toBe('2024-01-01T00:00:00Z');
  });
});

describe('find_similar_messages', () => {
  beforeEach(() => {
    resolveActiveGenerationFromConfig.mockReset(); loadVector.mockReset(); annSearch.mockReset();
    adapter.getMessageSummariesByIDs.mockReset(); adapter.listAccounts.mockReset();
    resolveActiveGenerationFromConfig.mockResolvedValue({
      cfg: { enabled: true, model: 'm', dimension: 2, preprocess: {}, maxInputChars: 100 },
      generation: { id: 3, model: 'm', dimension: 2, fingerprint: 'fp', state: 'active' },
    });
  });

  it('returns vector_not_enabled when embeddings are disabled (config check before the resolver)', async () => {
    resolveActiveGenerationFromConfig.mockRejectedValueOnce(new VUE('vector_not_enabled'));
    const r = await handleFindSimilarMessages({ message_id: 'seed' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('vector_not_enabled: vector search is not configured on this server');
  });

  it('maps a VectorUnavailableError reason from the resolver to its wire string', async () => {
    resolveActiveGenerationFromConfig.mockRejectedValue(new VUE('no_active_generation'));
    const r = await handleFindSimilarMessages({ message_id: 'seed' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^no_active_generation:/);
  });

  it('excludes the seed, hydrates in rank order via annSearch(gen.id, ...), scoped', async () => {
    resolveActiveGenerationFromConfig.mockResolvedValue({
      cfg: { enabled: true, model: 'm', dimension: 2, preprocess: {}, maxInputChars: 100 },
      generation: { id: 3, model: 'text-embedding-3-small', dimension: 1536, fingerprint: 'fp', state: 'active' },
    });
    loadVector.mockResolvedValue([0.1, 0.2]);
    annSearch.mockResolvedValue([
      { messageId: 'm1', score: 0.9, rank: 1 },
      { messageId: 'seed', score: 1, rank: 0 },
      { messageId: 'm2', score: 0.7, rank: 2 },
    ]);
    adapter.getMessageSummariesByIDs.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    const r = await handleFindSimilarMessages({ message_id: 'seed', limit: 20 }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.seed_message_id).toBe('seed');
    expect(b.returned).toBe(2);
    expect(b.generation).toEqual({ id: 3, model: 'text-embedding-3-small', dimension: 1536, fingerprint: 'fp', state: 'active' });
    expect(b.messages).toEqual([{ id: 'm1' }, { id: 'm2' }]);
    // real annSearch takes the generation ID and the {filter} with accountIds
    expect(annSearch).toHaveBeenCalledWith(3, [0.1, 0.2], 21, { filter: { accountIds: ['acc-1'] } });
    expect(adapter.getMessageSummariesByIDs).toHaveBeenCalledWith(['m1', 'm2'], ['acc-1']);
  });

  it('reports a readable error when the seed has no embedding', async () => {
    loadVector.mockRejectedValue(new Error('no embedding for message seed'));
    const r = await handleFindSimilarMessages({ message_id: 'seed' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('load seed vector: no embedding for message seed');
  });

  it('rejects a foreign/out-of-scope seed id without loading its vector (owner-scope isolation)', async () => {
    messageInScope.mockResolvedValue(false); // seed belongs to another user
    const r = await handleFindSimilarMessages({ message_id: 'foreign-seed' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('message not found');
    expect(loadVector).not.toHaveBeenCalled();
    expect(annSearch).not.toHaveBeenCalled();
    expect(messageInScope).toHaveBeenCalledWith('foreign-seed', ['acc-1']);
  });

  it('applies the advertised message_type filter to hydrated results (msgvault handlers.go:1042-1044)', async () => {
    loadVector.mockResolvedValue([0.1, 0.2]);
    annSearch.mockResolvedValue([{ messageId: 'm1', score: 0.9, rank: 1 }]);
    adapter.getMessageSummariesByIDs.mockResolvedValue([{ id: 'm1', message_type: 'email' }]);
    const none = JSON.parse((await handleFindSimilarMessages({ message_id: 'seed', message_type: 'sms' }, scope)).content[0].text);
    expect(none.messages).toEqual([]);
    expect(none.returned).toBe(0);
    const all = JSON.parse((await handleFindSimilarMessages({ message_id: 'seed', message_type: 'email' }, scope)).content[0].text);
    expect(all.messages).toHaveLength(1);
  });

  it('clamps limit to the hybrid page cap (msgvault handlers.go:885-888)', async () => {
    loadVector.mockResolvedValue([0.1, 0.2]);
    annSearch.mockResolvedValue([]);
    adapter.getMessageSummariesByIDs.mockResolvedValue([]);
    await handleFindSimilarMessages({ message_id: 'seed', limit: 5000 }, scope);
    expect(annSearch).toHaveBeenCalledWith(3, [0.1, 0.2], 101, expect.anything()); // 100 + 1 seed over-fetch
  });

  it('rejects malformed after/before dates and emits sent_at as RFC3339 (Go wire format)', async () => {
    const bad = await handleFindSimilarMessages({ message_id: 'seed', after: '2024-13-45' }, scope);
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('invalid after date "2024-13-45": expected YYYY-MM-DD');
    expect(annSearch).not.toHaveBeenCalled();

    loadVector.mockResolvedValue([0.1, 0.2]);
    annSearch.mockResolvedValue([{ messageId: 'm1', score: 0.9, rank: 1 }]);
    adapter.getMessageSummariesByIDs.mockResolvedValue([{ id: 'm1', sent_at: '2024-01-01T00:00:00.000Z' }]);
    const ok = JSON.parse((await handleFindSimilarMessages({ message_id: 'seed' }, scope)).content[0].text);
    expect(ok.messages[0].sent_at).toBe('2024-01-01T00:00:00Z');
  });
});

describe('search_in_message', () => {
  const body = 'café note — the budget is set here';
  const detail = { id: 'm1', account_id: 'acc-1', message_id: '<x>', thread_id: 't', subject: 'S', snippet: '', from_email: 'a@b.com', from_name: 'A', to_addresses: [], cc_addresses: [], date: new Date('2024-01-01T00:00:00Z'), has_attachments: false, attachments: [], flags: [], folder: 'INBOX', body_text: body, body_html: '' };
  beforeEach(() => { adapter.getMessage.mockReset(); matchesInMessage.mockReset(); });

  it('keyword mode returns a byte char_offset + real total; the offset round-trips into get_message center_at', async () => {
    adapter.getMessage.mockResolvedValue(detail);
    const r = await handleSearchInMessage({ id: 'm1', query: 'budget' }, scope);
    const b = JSON.parse(r.content[0].text);
    const byteOffset = Buffer.from(body, 'utf8').indexOf(Buffer.from('budget', 'utf8'));
    expect(b.total).toBe(1);
    expect(b.data[0].char_offset).toBe(byteOffset); // BYTE offset (not code-point index)
    expect(b.data[0]).not.toHaveProperty('score'); // keyword = no score
    const g = JSON.parse((await handleGetMessage({ id: 'm1', center_at: byteOffset, max_chars: 100 }, scope)).content[0].text);
    expect(g.offset).toBeLessThanOrEqual(byteOffset);
    expect(g.offset + g.body_returned).toBeGreaterThanOrEqual(byteOffset);
  });

  it('404s a missing message in keyword mode', async () => {
    adapter.getMessage.mockResolvedValue(null);
    const r = await handleSearchInMessage({ id: 'x', query: 'q' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('message not found');
  });

  it('vector mode maps VectorUnavailableError to vector_not_enabled (stock Postgres)', async () => {
    class VUE extends Error { constructor(r) { super(r); this.name = 'VectorUnavailableError'; this.reason = r; } }
    matchesInMessage.mockRejectedValue(new VUE('vector_not_enabled'));
    const r = await handleSearchInMessage({ id: 'm1', query: 'travel', mode: 'vector' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('vector_not_enabled: vector search is not configured on this server');
  });

  it('vector mode pages scored matches from matchesInMessage (scoped)', async () => {
    matchesInMessage.mockResolvedValue([{ snippet: 'a', score: 0.9 }, { snippet: 'b', score: 0.8 }]);
    const r = await handleSearchInMessage({ id: 'm1', query: 'travel', mode: 'vector', limit: 1 }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b.total).toBe(2);
    expect(b.returned).toBe(1);
    expect(b.has_more).toBe(true);
    expect(matchesInMessage).toHaveBeenCalledWith('m1', 'travel', 0, { accountIds: ['acc-1'] });
  });

  it('rejects an unknown mode', async () => {
    const r = await handleSearchInMessage({ id: 'm1', query: 'q', mode: 'fuzzy' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('invalid mode "fuzzy": must be keyword (default) or vector');
  });
});

describe('stage_deletion', () => {
  beforeEach(() => adapter.stageDeletion.mockReset());

  it('rejects query + structured filters together', async () => {
    const r = await handleStageDeletion({ query: 'from:x', from: 'y@z.com' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("use either 'query' or structured filters (from, domain, label, etc.), not both");
  });

  it('rejects neither query nor filters', async () => {
    const r = await handleStageDeletion({}, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("must provide either 'query' or at least one filter (from, domain, label, after, before, has_attachment)");
  });

  it('rejects an all-whitespace query with no structured filters (empty/missing query guard)', async () => {
    const r = await handleStageDeletion({ query: '   ' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("must provide either 'query' or at least one filter (from, domain, label, after, before, has_attachment)");
    expect(adapter.stageDeletion).not.toHaveBeenCalled();
  });

  it('rejects a query with an unsupported operator via the taxonomy error — never stages the whole mailbox', async () => {
    const r = await handleStageDeletion({ query: 'label:promotions' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^unsupported_search_operator: label: /);
    expect(adapter.stageDeletion).not.toHaveBeenCalled();
  });

  it('refuses a negation-only / sub-2-char / punctuation-only query (all tokens discarded)', async () => {
    for (const query of ['-newsletter', 'a', '!!!']) {
      adapter.stageDeletion.mockReset();
      const r = await handleStageDeletion({ query }, scope);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe('query produced no enforceable filters (all query terms were discarded as too short, punctuation-only, or negation-only); refusing to stage deletions');
      expect(adapter.stageDeletion).not.toHaveBeenCalled();
    }
  });

  it('rejects a mixed query too — dropping label: would stage a SUPERSET of what was asked (msgvault handlers.go:1818-1821)', async () => {
    const r = await handleStageDeletion({ query: 'invoice label:promotions' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^unsupported_search_operator: label: /);
    expect(adapter.stageDeletion).not.toHaveBeenCalled();
  });

  it('returns parser value errors verbatim (msgvault q.Err front-door rule)', async () => {
    const r = await handleStageDeletion({ query: 'invoice older_than:xyz' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('invalid value "xyz" for older_than: — expected a relative age like 7d, 2w, 1m, or 1y');
    expect(adapter.stageDeletion).not.toHaveBeenCalled();
  });

  it('rejects malformed structured after/before dates (msgvault getDateArg, handlers.go:1793-1800)', async () => {
    const r = await handleStageDeletion({ after: '13/45/2024' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('invalid after date "13/45/2024": expected YYYY-MM-DD');
    expect(adapter.stageDeletion).not.toHaveBeenCalled();
  });

  it('errors when no messages match', async () => {
    adapter.stageDeletion.mockResolvedValue({ batchId: null, messageCount: 0 });
    const r = await handleStageDeletion({ from: 'linkedin.com' }, scope);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('no messages match the specified criteria');
  });

  it('stages a batch with wire status "pending" (msgvault manifest.StatusPending, manifest.go:25) — never soft-deletes', async () => {
    adapter.stageDeletion.mockResolvedValue({ batchId: 'batch-9', messageCount: 5 });
    const r = await handleStageDeletion({ domain: 'linkedin.com' }, scope);
    const b = JSON.parse(r.content[0].text);
    expect(b).toEqual({
      batch_id: 'batch-9', message_count: 5, status: 'pending',
      next_step: 'POST /api/mcp-deletions/batch-9/execute to soft-delete, or DELETE /api/mcp-deletions/batch-9 to cancel',
    });
    // batch is scoped to the token user (cross-user isolation) and never flips is_deleted here
    expect(adapter.stageDeletion).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', accountIds: ['acc-1'], domain: 'linkedin.com' }));
  });
});
