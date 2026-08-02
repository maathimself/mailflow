import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query, withTransaction } from '../services/db.js';
import { rowToMessageSummary, rowToMessageDetail, mapAddrs, getMessageSummariesByIDs, listAccounts, listMessages, getTotalStats, aggregate, searchByDomains, stageDeletion, resolveAccountScope, messageInScope, countEnforceableQueryPredicates } from './engineAdapter.js';
import { parseQuery } from '../services/search/queryParser.js';
import { freeTextTermClause, searchLexical } from '../services/search/lexicalRepo.js';

const row = {
  id: '11111111-1111-1111-1111-111111111111', account_id: 'acc-1', message_id: '<abc@x>',
  thread_id: 'tid-9', subject: 'Hi', snippet: 's', from_email: 'a@b.com', from_name: 'A',
  to_addresses: [{ name: 'C', email: 'c@d.com' }], cc_addresses: [],
  date: '2024-01-01T00:00:00.000Z', has_attachments: true,
  attachments: [{ part: '2', filename: 'f.pdf', type: 'application/pdf', size: 10 }],
  flags: ['\\Seen'], folder: 'INBOX', body_text: 'hello', body_html: '<p>hello</p>',
};

describe('mapAddrs', () => {
  it('emits capitalized Email/Name keys (msgvault no-json-tag quirk)', () => {
    expect(mapAddrs([{ name: 'C', email: 'c@d.com' }])).toEqual([{ Email: 'c@d.com', Name: 'C' }]);
    expect(mapAddrs(null)).toEqual([]);
  });
});

describe('rowToMessageSummary', () => {
  it('maps thread_id to conversation_id and keeps the uuid id as a string', () => {
    const s = rowToMessageSummary(row);
    expect(s.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(s.conversation_id).toBe('tid-9');
    expect(s.source_conversation_id).toBe('tid-9');
    expect(s.source_message_id).toBe('<abc@x>');
    expect(s.source_id).toBe('acc-1');
    expect(s.to).toEqual([{ Email: 'c@d.com', Name: 'C' }]);
    expect(s.attachment_count).toBe(1);
    expect(s.size_estimate).toBe(0);
    expect(s.labels).toContain('INBOX');
    expect(s.labels).toContain('\\Seen');
    expect(s.message_type).toBe('email');
  });

  it('omits empty to/cc (omitempty parity)', () => {
    const s = rowToMessageSummary({ ...row, to_addresses: [], cc_addresses: [] });
    expect(s).not.toHaveProperty('to');
    expect(s).not.toHaveProperty('cc');
  });
});

describe('rowToMessageDetail', () => {
  it('adds body + capitalized AttachmentInfo', () => {
    const d = rowToMessageDetail(row);
    expect(d.body_text).toBe('hello');
    expect(d.body_html).toBe('<p>hello</p>');
    expect(d.from).toEqual([{ Email: 'a@b.com', Name: 'A' }]);
    expect(d.attachments[0]).toEqual({ ID: 0, Filename: 'f.pdf', MimeType: 'application/pdf', Size: 10, ContentHash: '', URL: '', StoragePath: '' });
  });
});

describe('getMessageSummariesByIDs', () => {
  beforeEach(() => query.mockReset());
  it('scopes to accountIds and preserves input order', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...row, id: 'b' }, { ...row, id: 'a' }] });
    const out = await getMessageSummariesByIDs(['a', 'b'], ['acc-1']);
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/account_id = ANY/);
    expect(params[1]).toContain('acc-1'); // accountIds is the array bound to ANY($2)
  });
  it('returns [] for empty ids without hitting the DB', async () => {
    expect(await getMessageSummariesByIDs([], ['acc-1'])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('listAccounts', () => {
  beforeEach(() => query.mockReset());
  it('maps to capitalized AccountInfo scoped to accountIds', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acc-1', protocol: 'imap', email_address: 'a@b.com', name: 'Work' }] });
    const out = await listAccounts(['acc-1']);
    expect(out).toEqual([{ ID: 'acc-1', SourceType: 'imap', Identifier: 'a@b.com', DisplayName: 'Work' }]);
    expect(query.mock.calls[0][1]).toEqual([['acc-1']]);
  });
  it('returns [] for empty scope without querying', async () => {
    expect(await listAccounts([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('resolveAccountScope', () => {
  beforeEach(() => query.mockReset());
  it('no account → full scope, no lookup', async () => {
    expect(await resolveAccountScope('', ['acc-1', 'acc-2'])).toEqual({ accountIds: ['acc-1', 'acc-2'] });
    expect(query).not.toHaveBeenCalled();
  });
  it('known account email → narrowed to its id', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acc-2', protocol: 'imap', email_address: 'c@d.com', name: 'W' }] });
    expect(await resolveAccountScope('c@d.com', ['acc-2'])).toEqual({ accountIds: ['acc-2'] });
  });
  it('unknown account email → error (msgvault getAccountID parity)', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acc-1', protocol: 'imap', email_address: 'a@b.com', name: 'W' }] });
    expect(await resolveAccountScope('nope@x.com', ['acc-1'])).toEqual({ error: 'account not found: nope@x.com' });
  });
});

describe('messageInScope', () => {
  beforeEach(() => query.mockReset());
  it('true when the id belongs to one of the accounts, scoped', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await messageInScope('m1', ['acc-1'])).toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['m1', ['acc-1']]);
  });
  it('false for a foreign/absent id', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await messageInScope('m1', ['acc-1'])).toBe(false);
  });
  it('false for empty scope without querying', async () => {
    expect(await messageInScope('m1', [])).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('getTotalStats', () => {
  beforeEach(() => query.mockReset());
  it('returns capitalized TotalStats keys scoped to accountIds', async () => {
    query.mockResolvedValueOnce({ rows: [{ message_count: '10', active_count: '9', deleted_count: '1', total_size: '5000', attachment_count: '3', label_count: '2' }] });
    const s = await getTotalStats(['acc-1', 'acc-2']);
    expect(s).toEqual({
      MessageCount: 10, ActiveMessageCount: 9, SourceDeletedMessageCount: 1,
      TotalSize: 5000, AttachmentCount: 3, AttachmentSize: 0, LabelCount: 2, AccountCount: 2,
    });
    expect(query.mock.calls[0][1]).toEqual([['acc-1', 'acc-2']]);
  });
  it('returns a zeroed struct for empty scope without querying', async () => {
    const s = await getTotalStats([]);
    expect(s.MessageCount).toBe(0);
    expect(s.AccountCount).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('aggregate', () => {
  beforeEach(() => query.mockReset());
  it('groups sender by from_email and maps capitalized AggregateRow keys, scoped', async () => {
    query.mockResolvedValueOnce({ rows: [{ key: 'a@b.com', count: '3', total_size: '10', attachment_count: '1', total_unique: '5' }] });
    const out = await aggregate('sender', { accountIds: ['acc-1'], limit: 50 });
    expect(out).toEqual([{ Key: 'a@b.com', Count: 3, TotalSize: 10, AttachmentSize: 0, AttachmentCount: 1, TotalUnique: 5 }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/m\.from_email AS key/);
    expect(sql).toMatch(/account_id = ANY\(\$1\)/);
    expect(params[0]).toEqual(['acc-1']);
  });

  it("time buckets by calendar year (to_char YYYY)", async () => {
    query.mockResolvedValueOnce({ rows: [{ key: '2024', count: '9', total_size: '0', attachment_count: '0', total_unique: '2' }] });
    const out = await aggregate('time', { accountIds: ['acc-1'], limit: 50 });
    expect(out[0].Key).toBe('2024');
    expect(query.mock.calls[0][0]).toMatch(/to_char\(m\.date, 'YYYY'\) AS key/);
  });

  it('recipient unnests to_addresses via a lateral join', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await aggregate('recipient', { accountIds: ['acc-1'], limit: 50 });
    expect(query.mock.calls[0][0]).toMatch(/LATERAL jsonb_array_elements/);
  });
});

describe('searchByDomains', () => {
  beforeEach(() => query.mockReset());
  it('matches any participant at a domain, scoped, and maps capitalized summaries', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...row, id: 'm1' }] });
    const out = await searchByDomains(['gobright.com'], null, null, 100, 0, ['acc-1']);
    expect(out[0].id).toBe('m1');
    expect(out[0].to).toEqual([{ Email: 'c@d.com', Name: 'C' }]); // capitalized address keys
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/from_email ILIKE/);
    expect(sql).toMatch(/to_addresses::text ILIKE/);
    expect(sql).toMatch(/cc_addresses::text ILIKE/);
    expect(params[0]).toEqual(['acc-1']);
    expect(params).toContain('%@gobright.com');
  });
});

describe('stageDeletion', () => {
  beforeEach(() => { query.mockReset(); withTransaction.mockReset(); });

  it('resolves ids scoped to accountIds, records a STAGED batch + members, never soft-deletes', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'm1' }, { id: 'm2' }] }); // id resolution
    const clientCalls = [];
    const client = { query: vi.fn(async (text) => {
      clientCalls.push(text);
      if (/INSERT INTO mcp_deletion_batches/.test(text)) return { rows: [{ id: 'batch-1' }] };
      return { rows: [] };
    }) };
    withTransaction.mockImplementation(async (fn) => fn(client));
    const out = await stageDeletion({ userId: 'u1', accountIds: ['acc-1'], domain: 'linkedin.com', description: 'filter' });
    expect(out).toEqual({ batchId: 'batch-1', messageCount: 2 });
    expect(query.mock.calls[0][1][0]).toEqual(['acc-1']); // id resolution scoped
    expect(clientCalls.some((t) => /INSERT INTO mcp_deletion_batches/.test(t) && /'staged'/.test(t))).toBe(true);
    expect(clientCalls.some((t) => /INSERT INTO mcp_deletion_batch_messages/.test(t))).toBe(true);
    expect(clientCalls.some((t) => /UPDATE messages SET is_deleted/.test(t))).toBe(false); // never hard/soft deletes here
  });

  it('returns a zero count without opening a transaction when nothing matches', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const out = await stageDeletion({ userId: 'u1', accountIds: ['acc-1'], from: 'x' });
    expect(out).toEqual({ batchId: null, messageCount: 0 });
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe('structured after/before args (Wave D Fix 5)', () => {
  beforeEach(() => { query.mockReset(); withTransaction.mockReset(); });

  it('rejects a malformed after/before with msgvault getDateArg wording, before any SQL runs', async () => {
    await expect(listMessages({ accountIds: ['a'], after: 'notadate', limit: 50, offset: 0 }))
      .rejects.toThrow('invalid after date "notadate": expected YYYY-MM-DD');
    // Strict YYYY-MM-DD (msgvault time.Parse("2006-01-02")) — no loose forms.
    await expect(aggregate('sender', { accountIds: ['a'], before: '2025-1-2', limit: 10 }))
      .rejects.toThrow('invalid before date "2025-1-2": expected YYYY-MM-DD');
    await expect(searchByDomains(['x.com'], null, '2025-02-31', 10, 0, ['a']))
      .rejects.toThrow('invalid before date "2025-02-31": expected YYYY-MM-DD');
    await expect(stageDeletion({ userId: 'u', accountIds: ['a'], before: 'garbage' }))
      .rejects.toThrow('invalid before date "garbage": expected YYYY-MM-DD');
    expect(query).not.toHaveBeenCalled();
  });

  it('binds valid dates as midnight-UTC ISO with an EXCLUSIVE before (<), matching lexicalRepo', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await listMessages({ accountIds: ['a'], after: '2025-01-02', before: '2025-02-03', limit: 50, offset: 0 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.date >= $2');
    expect(sql).toContain('m.date < $3');
    expect(sql).not.toContain('m.date <=');
    expect(params[1]).toBe('2025-01-02T00:00:00.000Z');
    expect(params[2]).toBe('2025-02-03T00:00:00.000Z');
  });
});

describe('stage_deletion / search predicate parity (Wave D Fix 3)', () => {
  beforeEach(() => { query.mockReset(); withTransaction.mockReset(); });

  // Rebuild the term clauses through lexicalRepo's shared owner with the same
  // ordinals both paths allocate ($1 = accountIds, terms from $2).
  function expectedClauses(terms) {
    const params = [];
    let p = 2;
    const bind = (v) => { params.push(v); return `$${p++}`; };
    return { clauses: terms.map((t) => freeTextTermClause(t, false, bind)), params };
  }

  it('builds the staging WHERE from the ranked/search_fts builder the search path uses, stopword guard included', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await stageDeletion({ userId: 'u1', accountIds: ['acc-1'], parsed: parseQuery('the invoice') });
    const [sql, params] = query.mock.calls[0];
    const expected = expectedClauses(['the', 'invoice']);
    for (const clause of expected.clauses) expect(sql).toContain(clause);
    expect(params.slice(1, 5)).toEqual(expected.params);
    // Ranked construction, not the legacy ILIKE/plainto fork the staging path
    // used to build (preview and staged set must agree): search_fts-first match
    // with the stopword vacuity guard, so `the invoice` stages the invoice set
    // instead of zero rows ("the" normalizes to an empty tsquery).
    expect(sql).toContain('m.search_fts @@');
    expect(sql).toContain('numnode(');
  });

  it('emits byte-identical term predicates to a lexical search of the same query', async () => {
    const searchCalls = [];
    const client = async (text, params) => { searchCalls.push({ text, params }); return { rows: [] }; };
    await searchLexical(client, {
      parsed: parseQuery('the invoice'), accountIds: ['acc-1'],
      folderScope: 'INBOX', folderFuzzy: false, ordering: 'date', limit: 50, offset: 0,
    });
    query.mockResolvedValueOnce({ rows: [] });
    await stageDeletion({ userId: 'u1', accountIds: ['acc-1'], parsed: parseQuery('the invoice') });
    const stagingSql = query.mock.calls[0][0];
    const searchSql = searchCalls[0].text;
    const expected = expectedClauses(['the', 'invoice']);
    for (const clause of expected.clauses) {
      expect(searchSql).toContain(clause);   // same ordinals in both WHEREs…
      expect(stagingSql).toContain(clause);  // …so the clause text is identical
    }
    // And the bind values line up pairwise (like + fts per term).
    expect(searchCalls[0].params.slice(1, 5)).toEqual(query.mock.calls[0][1].slice(1, 5));
  });
});

describe('countEnforceableQueryPredicates', () => {
  const n = (q) => countEnforceableQueryPredicates(parseQuery(q));

  it('counts supported structured filters and usable positive free-text terms', () => {
    expect(n('from:amazon invoice')).toBe(2);      // from: + invoice
    expect(n('is:unread')).toBe(1);                // one structured predicate
    expect(n('invoice urgent')).toBe(2);           // two positive terms
  });

  it('returns 0 when every token is discarded (the stage-everything hazard)', () => {
    expect(n('label:promotions')).toBe(0);         // unsupported operator only
    expect(n('-newsletter')).toBe(0);              // negation-only (not enforced on staging)
    expect(n('a')).toBe(0);                        // sub-2-char
    expect(n('!!!')).toBe(0);                      // punctuation-only
    expect(n('in:inbox')).toBe(0);                 // folder scope is not a row predicate
  });

  it('mirrors resolveStageDeletionIds: a real term survives alongside an unsupported operator', () => {
    expect(n('invoice label:promotions')).toBe(1);
  });

  it('treats a null parsed query (structured-filter path) as zero', () => {
    expect(countEnforceableQueryPredicates(null)).toBe(0);
  });
});
