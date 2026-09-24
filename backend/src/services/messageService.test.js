import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

const { query } = await import('./db.js');
import { listMessages } from './messageService.js';

beforeEach(() => {
  query.mockClear();
});

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

    // Unified inbox returns the cached total from the folder sum query
    expect(result.total).toBe(5);
    expect(result.resolvedAccountId).toBeNull();

    // The folder count query should have used total_count (not unread_count)
    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain('total_count');
    expect(countSql).not.toContain('unread_count');
  });

  it('uses only opted-in accounts for the unified inbox', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'acc-included', include_in_unified_inbox: true },
          { id: 'acc-excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1' });

    expect(query.mock.calls[1][1]).toEqual([['acc-included']]);
    expect(query.mock.calls[2][1][0]).toEqual(['acc-included']);
  });

  it('keeps an opted-out account available in its direct account view', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 'acc-excluded', include_in_unified_inbox: false }],
      })
      .mockResolvedValueOnce({ rows: [{ total_count: 2, unread_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] });

    const result = await listMessages({
      userId: 'user-1',
      accountId: 'acc-excluded',
    });

    expect(result.resolvedAccountId).toBe('acc-excluded');
    expect(query.mock.calls[1][1]).toEqual(['acc-excluded', 'INBOX']);
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

// Threaded mode: 4 query calls — accounts, folder cache, thread CTE, thread count
describe('listMessages — threaded mode', () => {
  it('returns thread count as total, ignoring the cached folder count', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })                       // accounts
      .mockResolvedValueOnce({ rows: [{ total_count: 99, unread_count: 2 }] })  // folder cache (not used)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] })                       // thread CTE
      .mockResolvedValueOnce({ rows: [{ total: 5 }] });                          // thread count

    const result = await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    expect(result.total).toBe(5);
    expect(result.threaded).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it('counts a thread message per account, not per Message-ID (#476)', async () => {
    // One email delivered to two connected accounts is two messages in the conversation, so
    // the thread badge must count both. Counting DISTINCT message_id alone reported 1 beside
    // a conversation holding 2. Verified against a live database: the same thread goes from
    // message_count 1 to 2 while the same-account Sent twin still collapses.
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    expect(cteSql).toContain('COUNT(DISTINCT (m.account_id, m.message_id))');
    expect(cteSql).not.toContain('COUNT(DISTINCT m.message_id)');
  });

  it('keeps the per-thread message rows scoped per account so both copies survive (#476)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    expect(query.mock.calls[2][0]).toContain('DISTINCT ON (m.account_id, m.thread_key, m.message_id)');
  });

  it('scopes thread_totals to INBOX when viewing a specific account INBOX', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    expect(cteSql).toContain('AND folder = $2');
  });

  it('counts thread messages across all folders when viewing a non-INBOX folder', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'Sent', threaded: 'true' });

    // thread_totals must not be scoped to a specific folder so the badge reflects true thread size
    const cteSql = query.mock.calls[2][0];
    expect(cteSql).not.toContain('AND folder = $2');
    expect(cteSql).not.toContain("AND folder = 'INBOX'");
  });

  it('scopes thread_totals to INBOX for unified inbox threaded view', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] })
      .mockResolvedValueOnce({ rows: [{ n: 20 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', threaded: 'true' });

    const cteSql = query.mock.calls[2][0];
    expect(cteSql).toContain("AND folder = 'INBOX'");
  });
});

describe('listMessages — message shape', () => {
  it('selects delivery_addresses in the flat query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    expect(query.mock.calls[2][0]).toContain('delivery_addresses');
  });

  it('selects delivery_addresses in the threaded query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    expect(query.mock.calls[2][0]).toContain('delivery_addresses');
  });
});

describe('listMessages — ghost row suppression (#407)', () => {
  it('excludes hollow UID-only placeholder rows in the flat query', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1' });

    const sql = query.mock.calls[2][0];
    expect(sql).toContain('NOT (m.message_id IS NULL');
    expect(sql).toContain("m.subject = '(no subject)'");
  });

  it('excludes hollow placeholder rows in the threaded query too (consistent pagination)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 1, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', threaded: 'true' });

    // CTE (call 2) and thread-count (call 3) both share `where`, so both exclude ghosts.
    expect(query.mock.calls[2][0]).toContain('NOT (m.message_id IS NULL');
    expect(query.mock.calls[3][0]).toContain('NOT (m.message_id IS NULL');
  });
});
