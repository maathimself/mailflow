import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveTrashFolder: vi.fn(),
  resolveArchiveFolder: vi.fn(),
}));

const { query } = await import('./db.js');
const { resolveTrashFolder, resolveArchiveFolder } = await import('../utils/mailUtils.js');
import { listMessages } from './messageService.js';

beforeEach(() => {
  query.mockClear();
  resolveTrashFolder.mockClear();
  resolveArchiveFolder.mockClear();
  resolveTrashFolder.mockResolvedValue(null);
  resolveArchiveFolder.mockResolvedValue(null);
});

// Threaded mode query call order:
//   0: accounts
//   1: folder cache
//   2: accountsWithMappings
//   3+: resolveTrashFolder / resolveArchiveFolder (via Promise.all, not query calls)
//   next: thread CTE
//   last: thread count

function mockThreadedQueries({ accounts = [{ id: 'acc-1' }], folderCache = { total_count: 10, unread_count: 0 }, threadRows = [], threadTotal = 0 } = {}) {
  query
    .mockResolvedValueOnce({ rows: accounts })
    .mockResolvedValueOnce({ rows: [folderCache] })
    .mockResolvedValueOnce({ rows: accounts.map(a => ({ id: a.id, folder_mappings: {} })) })
    .mockResolvedValueOnce({ rows: threadRows })
    .mockResolvedValueOnce({ rows: [{ total: threadTotal }] });
}

describe('listMessages — account scope', () => {
  it('returns empty result immediately when user has no enabled accounts', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await listMessages({ userId: 'user-1' });

    expect(result).toEqual({ messages: [], total: 0 });
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to unified inbox when accountId is not owned by the user', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })           // accounts
      .mockResolvedValueOnce({ rows: [{ n: 5 }] })                  // folder count
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1', folder: 'INBOX' }] }); // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-other' });

    expect(result.total).toBe(5);
    expect(result.resolvedAccountId).toBeNull();

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('total_count');
    expect(countSql).not.toContain('unread_count');
  });
});

describe('listMessages — total count selection', () => {
  it('sums unread_count across accounts for unified inbox when unreadOnly=true', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 7 }] })                          // folder count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1', unreadOnly: 'true' });

    expect(result.total).toBe(7);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('unread_count');
    expect(countSql).not.toContain('total_count');
  });

  it('sums total_count across accounts for unified inbox when unreadOnly is not set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }) // accounts
      .mockResolvedValueOnce({ rows: [{ n: 42 }] })                         // folder count
      .mockResolvedValueOnce({ rows: [] });                                  // messages

    const result = await listMessages({ userId: 'user-1' });

    expect(result.total).toBe(42);

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('total_count');
    expect(countSql).not.toContain('unread_count');
  });

  it('reads unread_count from folder row for specific account when unreadOnly=true', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 100, unread_count: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', unreadOnly: 'true' });

    expect(result.total).toBe(3);
    expect(result.resolvedAccountId).toBe('acc-1');
  });

  it('reads total_count from folder row for specific account when unreadOnly is not set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 100, unread_count: 3 }] })  // folder row
      .mockResolvedValueOnce({ rows: [] });                                        // messages

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    expect(result.total).toBe(100);
  });
});

describe('listMessages — threaded mode', () => {
  it('returns thread count as total, ignoring the cached folder count', async () => {
    mockThreadedQueries({ threadRows: [{ id: 'msg-1' }], threadTotal: 5 });

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    expect(result.total).toBe(5);
    expect(result.threaded).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it('excludes trash and archive paths from thread_totals', async () => {
    resolveTrashFolder.mockResolvedValue('[Gmail]/Bin');
    resolveArchiveFolder.mockResolvedValue(null);
    mockThreadedQueries();

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteSql = query.mock.calls[3][0];
    expect(cteSql).toContain('folder != ALL(');
    // excluded paths are passed as the last param
    const cteParams = query.mock.calls[3][1];
    expect(cteParams.at(-1)).toContain('[Gmail]/Bin');
  });

  it('passes empty excluded paths when no trash or archive folder exists', async () => {
    resolveTrashFolder.mockResolvedValue(null);
    resolveArchiveFolder.mockResolvedValue(null);
    mockThreadedQueries();

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteParams = query.mock.calls[3][1];
    expect(cteParams.at(-1)).toEqual([]);
  });

  it('excludes both trash and archive when both exist', async () => {
    resolveTrashFolder.mockResolvedValue('Trash');
    resolveArchiveFolder.mockResolvedValue('Archive');
    mockThreadedQueries();

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteParams = query.mock.calls[3][1];
    expect(cteParams.at(-1)).toEqual(expect.arrayContaining(['Trash', 'Archive']));
  });

  it('counts thread messages across all non-excluded folders', async () => {
    mockThreadedQueries();

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'Sent', threaded: 'true' });

    const cteSql = query.mock.calls[3][0];
    expect(cteSql).toContain('folder != ALL(');
    expect(cteSql).not.toContain("AND folder = 'INBOX'");
  });

  it('does not scope thread_totals to INBOX when viewing a specific account INBOX', async () => {
    mockThreadedQueries();

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteSql = query.mock.calls[3][0];
    expect(cteSql).not.toContain('AND folder = $2');
    expect(cteSql).toContain('folder != ALL(');
  });

  it('does not scope thread_totals to INBOX for unified inbox', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] })
      .mockResolvedValueOnce({ rows: [{ n: 20 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', folder_mappings: {} }, { id: 'acc-2', folder_mappings: {} }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', threaded: 'true' });

    const cteSql = query.mock.calls[3][0];
    expect(cteSql).not.toContain("AND folder = 'INBOX'");
    expect(cteSql).toContain('folder != ALL(');
  });
});
