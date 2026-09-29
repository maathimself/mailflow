import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('./gtdConfig.js', () => ({ getGtdConfig: vi.fn() }));
vi.mock('../../utils/mailUtils.js', () => ({ resolveAllDraftsPaths: vi.fn() }));
vi.mock('../../services/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  getOwnerAddresses,
  invalidateOwnerAddressesCache,
  runGtdTransitions,
  runTransitionsForSentMessage,
  threadKeysForMessageIds,
  threadKeysInFolders,
} from './gtdTransitions.js';
import { query } from '../../services/db.js';
import { getGtdConfig } from './gtdConfig.js';
import { resolveAllDraftsPaths } from '../../utils/mailUtils.js';

const DEFAULT_FOLDERS = { todo: 'Todo', watch: 'Watch', delegated: 'Delegated', someday: 'Someday', reference: 'Reference' };
const account = { id: 'acct-1', user_id: 'user-1', email_address: 'me@example.com', folder_mappings: {} };

const fakeManager = () => ({ hasMessageCopy: vi.fn().mockResolvedValue(true), removeMessageCopy: vi.fn().mockResolvedValue({}), broadcast: vi.fn() });

// One switchboard for the queries the engine issues: the sent-message Message-ID lookup
// (recognised by message_id = ANY), the owner-address UNION (account_aliases), and the
// per-thread row load (thread_key = ANY).
function mockQuery({ owner = [{ addr: 'me@example.com' }], rows = [], sent = [] }) {
  query.mockImplementation((sql) => {
    if (sql.includes('message_id = ANY')) return Promise.resolve({ rows: sent });
    if (sql.includes('account_aliases')) return Promise.resolve({ rows: owner });
    if (sql.includes('thread_key = ANY')) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

// ── getOwnerAddresses ────────────────────────────────────────────────────────

describe('getOwnerAddresses', () => {
  beforeEach(() => { query.mockReset(); invalidateOwnerAddressesCache('acct-1'); });

  it('unions the login address with aliases, lowercased', async () => {
    query.mockResolvedValueOnce({ rows: [{ addr: 'Me@Example.com' }, { addr: 'alias@example.com' }] });
    const set = await getOwnerAddresses('acct-1');
    expect(set.has('me@example.com')).toBe(true);
    expect(set.has('alias@example.com')).toBe(true);
  });

  it('normalizes a "Name <addr>" alias down to the bare addr-spec', async () => {
    query.mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: 'Work Me <  Work@Alias.COM >' }] });
    const set = await getOwnerAddresses('acct-1');
    expect(set.has('work@alias.com')).toBe(true);
  });

  it('drops empty / blank alias values', async () => {
    query.mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: '   ' }, { addr: null }] });
    const set = await getOwnerAddresses('acct-1');
    expect(set.size).toBe(1);
  });

  it('caches within the TTL and re-queries only after invalidation', async () => {
    query.mockResolvedValue({ rows: [{ addr: 'me@example.com' }] });
    await getOwnerAddresses('acct-1');
    await getOwnerAddresses('acct-1');
    expect(query).toHaveBeenCalledTimes(1);
    invalidateOwnerAddressesCache('acct-1');
    await getOwnerAddresses('acct-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('picks up changed aliases immediately after cache invalidation', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: 'old@example.com' }] })
      .mockResolvedValueOnce({ rows: [{ addr: 'me@example.com' }, { addr: 'masked@user.masked.fastmail.com' }] });
    const cached = await getOwnerAddresses('acct-1');
    expect(cached.has('old@example.com')).toBe(true);

    invalidateOwnerAddressesCache('acct-1');
    const refreshed = await getOwnerAddresses('acct-1');
    expect(refreshed.has('old@example.com')).toBe(false);
    expect(refreshed.has('masked@user.masked.fastmail.com')).toBe(true);
  });
});

// ── runGtdTransitions ────────────────────────────────────────────────────────

describe('runGtdTransitions', () => {
  beforeEach(() => {
    query.mockReset();
    getGtdConfig.mockReset();
    resolveAllDraftsPaths.mockReset();
    invalidateOwnerAddressesCache('acct-1');
    getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_FOLDERS });
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
  });

  it('strips Todo and Someday when the last message is from the owner, leaving waiting labels', async () => {
    mockQuery({ rows: [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 10, folder: 'INBOX',     from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 11, folder: 'Todo',      from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 12, folder: 'Someday',   from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 13, folder: 'Watch',     from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r4' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 14, folder: 'Delegated', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r5' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 11, 'Todo');
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 12, 'Someday');
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 13, 'Watch');
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 14, 'Delegated');
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-1' }, 'user-1');
  });

  it.each(['missing', 'unavailable'])('retains the only live GTD member when an outside cached copy is %s', async (failure) => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 10, folder: 'INBOX', message_id: '<invoice@example.test>', from_email: 'vendor@example.test', date: '2026-07-01', id: 'stale' },
      { thread_key: 't1', uid: 77, folder: 'Todo', message_id: '<invoice@example.test>', from_email: 'vendor@example.test', date: '2026-07-01', id: 'sole' },
      { thread_key: 't1', uid: 90, folder: 'Sent', message_id: '<reply@example.test>', from_email: 'me@example.com', date: '2026-07-02', id: 'reply' },
    ] });
    const mgr = fakeManager();
    mgr.hasMessageCopy.mockImplementation(async (_account, _uid, path) => {
      if (path === 'Todo') return true;
      if (failure === 'unavailable') throw new Error('offline');
      return false;
    });
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it.each(['mismatched', 'unavailable'])('retains a GTD source whose live identity is %s', async (failure) => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 10, folder: 'INBOX', message_id: '<invoice@example.test>', from_email: 'vendor@example.test', date: '2026-07-01', id: 'outside' },
      { thread_key: 't1', uid: 77, folder: 'Todo', message_id: '<invoice@example.test>', from_email: 'vendor@example.test', date: '2026-07-01', id: 'stale-source' },
      { thread_key: 't1', uid: 90, folder: 'Sent', message_id: '<reply@example.test>', from_email: 'me@example.com', date: '2026-07-02', id: 'reply' },
    ] });
    const live = new Map([['INBOX:10', '<invoice@example.test>'], ['Todo:77', '<other-only@example.test>']]);
    const mgr = fakeManager();
    mgr.hasMessageCopy.mockImplementation(async (_account, uid, folder, messageId) => {
      if (folder === 'Todo' && failure === 'unavailable') throw new Error('offline');
      return live.get(`${folder}:${uid}`) === messageId;
    });
    mgr.removeMessageCopy.mockImplementation(async (_accountId, uid, folder) => live.delete(`${folder}:${uid}`));
    await runGtdTransitions(mgr, account, ['t1']);
    expect(live.get('Todo:77')).toBe('<other-only@example.test>');
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it.each(['Todo', 'Someday'])('keeps a filed-only member in %s after an owner reply', async (folder) => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 98, folder, message_id: '<invoice@example.test>', from_email: 'vendor@example.test', date: '2026-07-01', id: 'old' },
      { thread_key: 't1', uid: 99, folder: 'Sent', message_id: '<reply@example.test>', from_email: 'me@example.com', date: '2026-07-02', id: 'new' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it.each(['Reference', 'Drafts'])('does not trust an identical copy only in %s for automatic stripping', async (folder) => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 98, folder: 'Todo', message_id: '<filed@example.test>', from_email: 'me@example.com', date: '2026-07-01', id: 'old' },
      { thread_key: 't1', uid: 99, folder, message_id: '<filed@example.test>', from_email: 'me@example.com', date: '2026-07-01', id: 'new' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('keeps an unidentified GTD member even when another thread member is in Inbox', async () => {
    mockQuery({ rows: [
      { thread_key: 't1', uid: 98, folder: 'Todo', message_id: null, from_email: 'me@example.com', date: '2026-07-01', id: 'old' },
      { thread_key: 't1', uid: 99, folder: 'INBOX', message_id: null, from_email: 'me@example.com', date: '2026-07-01', id: 'new' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('keeps every GTD label when the last message is not from the owner', async () => {
    mockQuery({ rows: [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 20, folder: 'INBOX',     from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r1' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 21, folder: 'Todo',      from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r2' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 22, folder: 'Someday',   from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r3' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 23, folder: 'Watch',     from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r4' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 24, folder: 'Delegated', from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r5' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('treats an alias sender as the owner (self-strips Todo)', async () => {
    mockQuery({
      owner: [{ addr: 'me@example.com' }, { addr: 'Work Me <work@alias.com>' }],
      rows: [
        { message_id: '<original@example.test>', thread_key: 't1', uid: 30, folder: 'INBOX', from_email: 'work@alias.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { message_id: '<original@example.test>', thread_key: 't1', uid: 31, folder: 'Todo',  from_email: 'work@alias.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      ],
    });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 31, 'Todo');
  });

  it('keeps Watch when the newest message is from a configured Fastmail masked alias', async () => {
    mockQuery({
      owner: [{ addr: 'me@example.com' }, { addr: 'masked@user.masked.fastmail.com' }],
      rows: [
        { message_id: '<original@example.test>', thread_key: 't1', uid: 32, folder: 'INBOX', from_email: 'masked@user.masked.fastmail.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { message_id: '<original@example.test>', thread_key: 't1', uid: 33, folder: 'Watch', from_email: 'masked@user.masked.fastmail.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      ],
    });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 33, 'Watch');
  });

  it('keeps Watch when the newest message is from an external address', async () => {
    mockQuery({
      owner: [{ addr: 'me@example.com' }, { addr: 'masked@user.masked.fastmail.com' }],
      rows: [
        { message_id: '<original@example.test>', thread_key: 't1', uid: 34, folder: 'INBOX', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { message_id: '<original@example.test>', thread_key: 't1', uid: 35, folder: 'Watch', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      ],
    });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 35, 'Watch');
  });

  it('never strips Reference, whoever sent last', async () => {
    // last message from me
    mockQuery({ rows: [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 40, folder: 'INBOX',     from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 41, folder: 'Reference', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
    ] });
    let mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();

    // last message from them
    invalidateOwnerAddressesCache('acct-1');
    mockQuery({ rows: [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 42, folder: 'INBOX',     from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 43, folder: 'Reference', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r4' },
    ] });
    mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does not let a newer owner-authored draft clear Todo or Someday', async () => {
    mockQuery({ rows: [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 50, folder: 'INBOX',   from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r1' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 51, folder: 'Todo',    from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r2' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 52, folder: 'Someday', from_email: 'them@other.com', date: '2026-07-09T12:00:00Z', id: 'r3' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 53, folder: 'Drafts',  from_email: 'me@example.com',  date: '2026-07-09T15:00:00Z', id: 'r4' },
    ] });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('is fully inert when GTD is disabled — no rows query, no strips, no broadcast', async () => {
    getGtdConfig.mockResolvedValue({ enabled: false, folders: DEFAULT_FOLDERS });
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, ['t1']);
    expect(query).not.toHaveBeenCalled();
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('does nothing for an empty thread-key set (no config lookup)', async () => {
    const mgr = fakeManager();
    await runGtdTransitions(mgr, account, []);
    expect(getGtdConfig).not.toHaveBeenCalled();
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('is a no-op on the second run once the state-folder rows are gone (idempotent)', async () => {
    const withTodo = [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 60, folder: 'INBOX', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 61, folder: 'Todo',  from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
    ];
    const mgr = fakeManager();

    mockQuery({ rows: withTodo });
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);

    // Second run sees the stripped state: the Todo sibling is gone. Same verdict, nothing left.
    mockQuery({ rows: [withTodo[0]] });
    await runGtdTransitions(mgr, account, ['t1']);
    expect(mgr.removeMessageCopy).toHaveBeenCalledTimes(1);
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
  });

  it('keeps Watch and Delegated through subsequent transition reconciliation', async () => {
    const waitingRows = [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 62, folder: 'INBOX',     from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 63, folder: 'Watch',     from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 64, folder: 'Delegated', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
    ];
    const mgr = fakeManager();

    mockQuery({ rows: waitingRows });
    await runGtdTransitions(mgr, account, ['t1']);
    mockQuery({ rows: waitingRows });
    await runGtdTransitions(mgr, account, ['t1']);

    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('tolerates a removeMessageCopy rejection (concurrent external strip) as success', async () => {
    mockQuery({ rows: [
      { message_id: '<original@example.test>', thread_key: 't1', uid: 70, folder: 'INBOX', from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
      { message_id: '<original@example.test>', thread_key: 't1', uid: 71, folder: 'Todo',  from_email: 'me@example.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
    ] });
    const mgr = fakeManager();
    mgr.removeMessageCopy.mockRejectedValue(new Error('NO [TRYCREATE] no such UID'));
    await expect(runGtdTransitions(mgr, account, ['t1'])).resolves.toBeUndefined();
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 71, 'Todo');
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
  });
});

// ── runTransitionsForSentMessage (the send-route hook) ───────────────────────

describe('runTransitionsForSentMessage', () => {
  beforeEach(() => {
    query.mockReset();
    getGtdConfig.mockReset();
    resolveAllDraftsPaths.mockReset();
    invalidateOwnerAddressesCache('acct-1');
    getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_FOLDERS });
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
  });

  it('is inert when the account has GTD disabled — no query, no engine', async () => {
    getGtdConfig.mockResolvedValue({ enabled: false, folders: DEFAULT_FOLDERS });
    const mgr = fakeManager();
    await runTransitionsForSentMessage(mgr, account, '<abc@example.com>');
    expect(query).not.toHaveBeenCalled();
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });

  it('strips Todo and Someday on a self-reply while keeping Watch and Delegated', async () => {
    mockQuery({
      sent: [{ thread_key: 't1' }],
      rows: [
        { message_id: '<original@example.test>', thread_key: 't1', uid: 80, folder: 'INBOX', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r1' },
        { message_id: '<original@example.test>', thread_key: 't1', uid: 81, folder: 'Todo',  from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r2' },
        { message_id: '<original@example.test>', thread_key: 't1', uid: 82, folder: 'Someday', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r3' },
        { message_id: '<original@example.test>', thread_key: 't1', uid: 83, folder: 'Watch', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r4' },
        { message_id: '<original@example.test>', thread_key: 't1', uid: 84, folder: 'Delegated', from_email: 'them@other.com', date: '2026-07-09T10:00:00Z', id: 'r5' },
        // My just-sent reply, now synced into Sent — the newest non-draft message.
        { message_id: '<reply@example.test>', thread_key: 't1', uid: 85, folder: 'Sent',  from_email: 'me@example.com',  date: '2026-07-09T11:00:00Z', id: 'r6' },
      ],
    });
    const mgr = fakeManager();
    await runTransitionsForSentMessage(mgr, { ...account, gtd_enabled: true }, '<abc@example.com>');

    const midCall = query.mock.calls.find(([sql]) => sql.includes('message_id = ANY'));
    expect(midCall[1]).toEqual(['acct-1', ['abc@example.com', '<abc@example.com>']]);
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 81, 'Todo');
    expect(mgr.removeMessageCopy).toHaveBeenCalledWith('acct-1', 82, 'Someday');
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 83, 'Watch');
    expect(mgr.removeMessageCopy).not.toHaveBeenCalledWith('acct-1', 84, 'Delegated');
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: 'acct-1' }, 'user-1');
  });

  it('no-ops when the Sent copy has not synced yet (Message-ID resolves to nothing)', async () => {
    mockQuery({ sent: [] });
    const mgr = fakeManager();
    await runTransitionsForSentMessage(mgr, { ...account, gtd_enabled: true }, '<notyet@example.com>');
    // Only the Message-ID lookup ran; the engine short-circuits on an empty thread set.
    expect(query.mock.calls.every(([sql]) => sql.includes('message_id = ANY'))).toBe(true);
    expect(mgr.removeMessageCopy).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
  });
});

// ── thread-key resolvers (feed the two hooks) ────────────────────────────────

describe('threadKeysForMessageIds', () => {
  beforeEach(() => query.mockReset());

  it('returns the distinct thread keys for the given row ids', async () => {
    query.mockResolvedValue({ rows: [{ thread_key: 't1' }, { thread_key: 't2' }] });
    const keys = await threadKeysForMessageIds('acct-1', ['r1', 'r2']);
    expect(keys).toEqual(['t1', 't2']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('id = ANY($2::uuid[])');
    expect(params).toEqual(['acct-1', ['r1', 'r2']]);
  });

  it('short-circuits with no query on an empty id list', async () => {
    expect(await threadKeysForMessageIds('acct-1', [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('keys on row id with no folder filter, so a rule-MOVED reply still yields its thread', async () => {
    // An inbound reply a rule filed out of INBOX keeps its row (just in another folder) and
    // its thread must still be re-evaluated. The lookup never filters on folder, so the moved
    // row resolves.
    query.mockResolvedValue({ rows: [{ thread_key: 't-moved' }] });
    const keys = await threadKeysForMessageIds('acct-1', ['moved-reply']);
    expect(keys).toEqual(['t-moved']);
    expect(query.mock.calls[0][0]).not.toContain('folder');
  });
});

describe('threadKeysInFolders', () => {
  beforeEach(() => query.mockReset());

  it('returns the distinct thread keys for non-deleted rows in the given folders', async () => {
    query.mockResolvedValue({ rows: [{ thread_key: 't1' }] });
    const keys = await threadKeysInFolders('acct-1', ['Watch', 'Todo']);
    expect(keys).toEqual(['t1']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('folder = ANY($2::text[])');
    expect(sql).toContain('is_deleted = false');
    expect(params).toEqual(['acct-1', ['Watch', 'Todo']]);
  });

  it('short-circuits with no query on an empty folder list', async () => {
    expect(await threadKeysInFolders('acct-1', [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
