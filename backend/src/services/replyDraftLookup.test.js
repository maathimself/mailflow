import { describe, expect, it, vi } from 'vitest';
import * as lookup from './replyDraftLookup.js';
import { replyChainIds, draftFolderPaths, chooseReplyDraft, searchReplyDraftUids } from './replyDraftLookup.js';

const A = { id: 'a', account_id: 'account-a', message_id: '<a@example.test>', thread_id: 'shared' };
const sent = { id: 'sent', account_id: 'account-a', message_id: '<sent@example.test>', in_reply_to: A.message_id, thread_references: A.message_id, thread_id: 'shared' };
const draft = { id: 'draft', account_id: 'account-a', message_id: '<draft@example.test>', in_reply_to: sent.message_id, thread_references: `${A.message_id} ${sent.message_id}`, folder: 'Drafts', uid: '20', date: '2026-09-24T10:00:00Z', thread_id: 'shared' };

describe('request-shared reply matching work', () => {
  it('does not inspect a conversation when there are no eligible candidates', () => {
    const row = { ...sent, get thread_references() { throw new Error('graph read without candidates'); } };
    expect(chooseReplyDraft(A, [row], [], ['Drafts'])).toBeNull();
    expect(chooseReplyDraft(A, [row], [{ ...draft, folder: 'Archive' }], ['Drafts'])).toBeNull();
  });

  for (const size of [1000, 2000, 10000]) it(`indexes a ${size}-member conversation with one graph read and one traversal`, () => {
    let headerReads = 0;
    const rows = Array.from({ length: size }, (_, i) => ({ account_id: 'account-a', message_id: `<${i}@example.test>`,
      get in_reply_to() { headerReads++; return i ? `<${i - 1}@example.test>` : null; },
      get thread_references() { headerReads++; return null; } }));
    const graph = lookup.createReplyGraph(rows);
    let traversed = 0;
    for (const edges of graph.get('account-a').values()) {
      const iterator = edges[Symbol.iterator].bind(edges);
      edges[Symbol.iterator] = function* () { for (const id of iterator()) { traversed++; yield id; } };
    }
    const candidates = Array.from({ length: 100 }, (_, i) => ({ ...draft, id: `draft-${i}`, message_id: null,
      in_reply_to: '<0@example.test>', thread_references: null, date: '2026-10-06T00:00:00Z', uid: i + 1 }));
    const index = lookup.indexReplyDrafts(graph, candidates, new Map([['account-a', ['Drafts']]]));
    const targets = size === 10000 ? rows.slice(0, 100) : rows;
    for (const row of targets) expect(index.get('account-a').get(row.message_id).id).toBe('draft-99');
    expect(headerReads).toBeLessThanOrEqual(size * 2);
    expect(traversed).toBeLessThanOrEqual(size * 2);
    traversed = 0;
    const ids = lookup.replyChainIdsFor(graph, targets).get('account-a');
    expect(ids.size).toBe(size);
    expect(ids.has('<0@example.test>')).toBe(true);
    expect(ids.has(`<${size - 1}@example.test>`)).toBe(true);
    expect(traversed).toBeLessThanOrEqual(size * 2);
  });

  it('a draft without its own ID reaches two components without joining them for other candidates', () => {
    const b = { ...A, message_id: '<b@example.test>' };
    const graph = lookup.createReplyGraph([A, b]);
    const multi = { ...draft, id: 'multi', message_id: null, thread_references: `${A.message_id} ${b.message_id}`, date: '2026-09-23' };
    const latest = { ...draft, id: 'latest', message_id: null, in_reply_to: A.message_id, thread_references: null };
    const index = lookup.indexReplyDrafts(graph, [multi, latest], new Map([['account-a', ['Drafts']]]));
    expect(index.get('account-a').get(A.message_id).id).toBe('latest');
    expect(index.get('account-a').get(b.message_id).id).toBe('multi');
  });

  it('adds all candidate connectors before ranking, retaining account and deletion boundaries', () => {
    const b = { ...A, message_id: '<b@example.test>' };
    const c = { ...A, message_id: '<c@example.test>' };
    const graph = lookup.createReplyGraph([A, b, c, { ...A, account_id: 'account-b' }, { ...sent, is_deleted: true }]);
    const newer = { ...draft, id: 'newer', message_id: '<newer@example.test>', in_reply_to: A.message_id, thread_references: null };
    const bridge = { ...draft, id: 'bridge', message_id: '<bridge@example.test>', thread_references: `${A.message_id} ${b.message_id}`, date: '2026-09-20' };
    const wrong = { ...draft, folder: 'Archive', thread_references: `${A.message_id} ${c.message_id}` };
    const index = lookup.indexReplyDrafts(graph, [bridge, wrong, newer], new Map([['account-a', ['Drafts']]]));
    expect(index.get('account-a').get(b.message_id).id).toBe('newer');
    expect(index.get('account-a').get(c.message_id)).toBeUndefined();
    expect(index.get('account-b')).toBeUndefined();
  });
});

describe('reply-chain draft matching', () => {
  it('terminates cycles and ranks duplicate deliveries by date, UID, then row ID', () => {
    const cycle = { ...A, in_reply_to: sent.message_id };
    const candidates = [
      { ...draft, id: 'z', uid: 30 },
      { ...draft, id: 'a', uid: 30 },
      { ...draft, id: 'newer-uid-but-old', uid: 100, date: '2026-09-23' },
      { ...draft, id: 'lower-uid', uid: 29 },
    ];
    expect(chooseReplyDraft(cycle, [cycle, sent, { ...sent, id: 'delivery-copy' }], candidates, ['Drafts'])?.id).toBe('a');
  });
  it('follows a reply through a Sent-folder connector', () => {
    expect([...replyChainIds(A, [A, sent, draft])]).toEqual([A.message_id, sent.message_id, draft.message_id]);
    expect(chooseReplyDraft(A, [A, sent], [draft], ['Drafts'])?.id).toBe('draft');
  });

  it('does not match an unrelated reply in a subject-merged thread', () => {
    const other = { ...A, id: 'other', message_id: '<other@example.test>' };
    const unrelated = { ...draft, id: 'unrelated', message_id: '<unrelated@example.test>', in_reply_to: other.message_id, thread_references: other.message_id };
    expect(chooseReplyDraft(A, [A, other], [unrelated], ['Drafts'])).toBeNull();
  });

  it('does not cross accounts or use a message without an RFC Message-ID', () => {
    expect(chooseReplyDraft(A, [A], [{ ...draft, account_id: 'account-b', in_reply_to: A.message_id }], ['Drafts'])).toBeNull();
    expect(chooseReplyDraft({ ...A, message_id: null }, [sent], [draft], ['Drafts'])).toBeNull();
  });

  it('matches a reply draft without its own Message-ID through its reply header', () => {
    const external = { ...draft, message_id: null, in_reply_to: A.message_id, thread_references: null };
    expect(chooseReplyDraft(A, [A], [external], ['Drafts'])?.id).toBe('draft');
  });

  it('keeps the newest eligible live draft and ignores other folders', () => {
    const older = { ...draft, id: 'older', uid: '18', date: '2026-09-23T10:00:00Z' };
    const wrongFolder = { ...draft, id: 'wrong-folder', folder: 'Draft Projects', date: '2026-09-25T10:00:00Z' };
    expect(chooseReplyDraft(A, [A, sent], [older, wrongFolder, draft], ['Drafts'])?.id).toBe('draft');
  });

  it('connects siblings through an uncached ancestor without subject matching', () => {
    const selected = { ...A, in_reply_to: '<missing@example.test>' };
    const siblingDraft = { ...draft, in_reply_to: '<missing@example.test>', thread_references: null };
    expect(chooseReplyDraft(selected, [], [siblingDraft], ['Drafts'])?.id).toBe('draft');
  });

  it('ignores deleted connectors and exact-token substring false positives', () => {
    const bridge = { ...sent, is_deleted: true };
    const indirect = { ...draft, thread_references: null };
    expect(chooseReplyDraft(A, [bridge], [indirect], ['Drafts'])).toBeNull();
    const substring = { ...draft, in_reply_to: '<prefix-a@example.test>', thread_references: null };
    expect(chooseReplyDraft(A, [], [substring], ['Drafts'])).toBeNull();
  });
});

describe('real Drafts folder resolution', () => {
  it('unions selectable mapping and server-designated Drafts, excluding lookalike names', () => {
    const folders = [
      { account_id: 'account-a', path: 'ServerDrafts', special_use: '\\Drafts' },
      { account_id: 'account-a', path: 'Custom' },
      { account_id: 'account-a', path: 'Drafts backup' },
      { account_id: 'account-a', path: 'Unselectable', special_use: '\\Drafts', no_select: true },
      { account_id: 'account-b', path: 'Other', special_use: '\\Drafts' },
    ];
    expect(draftFolderPaths('account-a', { drafts: 'Custom' }, folders)).toEqual(['Custom', 'ServerDrafts']);
  });
});

describe('live IMAP reply search', () => {
  it('searches both reply headers in every real Drafts folder and keeps old UIDs', async () => {
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValueOnce([1, 201]).mockResolvedValueOnce([4]),
    };
    const found = await searchReplyDraftUids(client, ['Custom', 'ServerDrafts'], ['<a@example.test>', '<b@example.test>']);
    expect(found).toEqual([{ folder: 'Custom', uid: 1 }, { folder: 'Custom', uid: 201 }, { folder: 'ServerDrafts', uid: 4 }]);
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(client.search.mock.calls[0][0])).toContain('In-Reply-To');
    expect(JSON.stringify(client.search.mock.calls[0][0])).toContain('References');
    expect(client.getMailboxLock.mock.results[0].value).toBeDefined();
  });

  it('does not treat an incomplete SEARCH as an empty Drafts folder', async () => {
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }), search: vi.fn().mockResolvedValue(undefined) };
    await expect(searchReplyDraftUids(client, ['Drafts'], ['<a@example.test>'])).rejects.toThrow('Incomplete draft search');
  });

  it('fails explicitly when the candidate limit is exceeded and releases its lock', async () => {
    const release = vi.fn();
    const client = { getMailboxLock: vi.fn().mockResolvedValue({ release }), search: vi.fn().mockResolvedValue(Array.from({ length: 501 }, (_, i) => i + 1)) };
    await expect(searchReplyDraftUids(client, ['Drafts'], [A.message_id])).rejects.toThrow('Too many reply drafts');
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('incremental cached draft index', () => {
  it('keeps the best early candidate when a later page joins components, without requiring matching stored roots', () => {
    const b = { ...A, message_id: '<b@example.test>' };
    const graph = lookup.createReplyGraph([A, b]);
    const index = lookup.createReplyDraftIndex(graph, new Map([['account-a', ['Drafts']]]));
    const newest = { ...draft, id: 'newest', in_reply_to: A.message_id, thread_references: null, date: '2026-10-07', thread_id: 'another-root' };
    index.add([newest]);
    index.add([{ ...draft, id: 'bridge', thread_references: `${A.message_id} ${b.message_id}`, date: '2026-09-01' }]);
    expect(index.result([A, b]).get('account-a').get(b.message_id).id).toBe('newest');
  });

  it('does not join disconnected components for a missing-own-ID draft, and preserves account/folder/deletion boundaries across pages', () => {
    const b = { ...A, message_id: '<b@example.test>' };
    const foreign = { ...A, account_id: 'account-b' };
    const index = lookup.createReplyDraftIndex(lookup.createReplyGraph([A, b, foreign]), new Map([['account-a', ['Drafts']]]));
    index.add([{ ...draft, id: 'both', message_id: null, thread_references: `${A.message_id} ${b.message_id}`, date: '2026-09-01' }]);
    index.add([{ ...draft, id: 'only-a', message_id: null, in_reply_to: A.message_id, thread_references: null },
      { ...draft, folder: 'Archive', thread_references: `${A.message_id} ${b.message_id}` },
      { ...draft, is_deleted: true, thread_references: `${A.message_id} ${b.message_id}` },
      { ...draft, account_id: 'account-b', date: '2026-12-01' }]);
    const result = index.result([A, b, foreign]);
    expect(result.get('account-a').get(A.message_id).id).toBe('only-a');
    expect(result.get('account-a').get(b.message_id).id).toBe('both');
    expect(result.get('account-b')).toBeUndefined();
  });

  it('ranks independently of page order and limits result maps to requested members', () => {
    const index = lookup.createReplyDraftIndex(lookup.createReplyGraph([A]), new Map([['account-a', ['Drafts']]]));
    const candidates = [
      { ...draft, id: 'z', uid: 30, in_reply_to: A.message_id, thread_references: null },
      { ...draft, id: 'old-high-uid', uid: 100, date: '2026-09-01', in_reply_to: A.message_id, thread_references: null },
      { ...draft, id: 'a', uid: 30, in_reply_to: A.message_id, thread_references: null },
    ];
    for (const row of candidates) index.add([row]);
    const result = index.result([A]);
    expect([...result.get('account-a').keys()]).toEqual([A.message_id]);
    expect(result.get('account-a').get(A.message_id).id).toBe('a');
  });
});
