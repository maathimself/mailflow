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

    expect(query.mock.calls[1][1]).toEqual([['acc-included'], 'INBOX']);
    expect(query.mock.calls[2][1][0]).toEqual(['acc-included']);
  });

  // The Snoozed view (#269).
  it('the Snoozed view without an account covers every enabled account, soonest wake-up first', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'acc-included', include_in_unified_inbox: true },
          { id: 'acc-excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', folder: 'Snoozed', threaded: 'true' });

    expect(query.mock.calls[1][1]).toEqual([['acc-included', 'acc-excluded'], 'Snoozed']);
    const [sql, params] = query.mock.calls[2];
    expect(params[0]).toEqual(['acc-included', 'acc-excluded']);
    expect(sql).toContain("m.folder = 'Snoozed'");
    expect(sql).toContain('sz.snooze_until');
    expect(sql).toMatch(/ORDER BY sz\.snooze_until ASC NULLS LAST, m\.date DESC, m\.id/);
    expect(sql).not.toContain('paged_threads');
  });

  // The snooze route files mail under the path the server gave the Snoozed folder: INBOX.Snoozed on a
  // server with an INBOX. namespace prefix. Outside the folder named Snoozed, the view lists the
  // messages whose own snooze record names the folder they are in, and counts them by row: a folder
  // Snoozed was renamed to holds other mail too. Each row carries its record's folder, which the
  // client's menu goes by.
  it.each([
    ['total_count', undefined, ''],
    ['unread_count', 'true', ' AND m.is_read = false'],
  ])('the Snoozed view also lists and counts the snoozed mail in other folders (%s)', async (column, unreadOnly, unreadSql) => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1', include_in_unified_inbox: true }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1', folder: 'Snoozed', unreadOnly });

    const snoozedElsewhere = '(m.folder = ANY(ARRAY(SELECT DISTINCT sm.snoozed_folder FROM snoozed_messages sm WHERE sm.account_id = ANY($1)))'
      + ' AND EXISTS (SELECT 1 FROM snoozed_messages own WHERE own.account_id = m.account_id'
      + ' AND own.message_id_header = m.message_id AND own.snoozed_folder = m.folder))';
    expect(query.mock.calls[1]).toEqual([
      `SELECT COALESCE(SUM(${column}), 0)::int + (SELECT COUNT(*)::int FROM messages m WHERE m.account_id = ANY($1) AND m.folder <> $2`
        + ` AND m.is_deleted = false${unreadSql} AND ${snoozedElsewhere}) AS n FROM folders WHERE account_id = ANY($1) AND path = $2`,
      [['acc-1'], 'Snoozed'],
    ]);
    const [sql, params] = query.mock.calls[2];
    expect(sql).toContain(`(m.folder = 'Snoozed' OR ${snoozedElsewhere})${unreadSql}`);
    expect(params[0]).toEqual(['acc-1']);
    expect(sql).toContain('sz.snooze_until, sz.snoozed_folder');
    expect(sql).toContain('SELECT sm.snooze_until, sm.snoozed_folder FROM snoozed_messages sm');
  });

  it('other folders read no snooze times and keep their order', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-included', include_in_unified_inbox: true }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    await listMessages({ userId: 'user-1' });

    const [sql] = query.mock.calls[2];
    expect(sql).not.toContain('snooze_until');
    expect(sql).toMatch(/ORDER BY m\.date DESC, m\.id/);
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

  // #576: the badge counts the thread across folders so it matches the thread route, which
  // loads every folder. Scoped to INBOX, a received message plus your reply (in Sent) counted 1.
  const threadTotalsSql = (sql) => sql.slice(sql.indexOf('thread_totals AS'), sql.indexOf('ranked AS'));

  it('counts thread messages across all folders for a specific account INBOX (#576)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'INBOX', threaded: 'true' });

    const totals = threadTotalsSql(query.mock.calls[2][0]);
    expect(totals).toContain('COUNT(DISTINCT (m.account_id, m.message_id))');
    expect(totals).not.toMatch(/folder\s*=/);
  });

  it('counts thread messages across all folders when viewing a non-INBOX folder', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValueOnce({ rows: [{ total_count: 10, unread_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', accountId: 'acc-1', folder: 'Sent', threaded: 'true' });

    const totals = threadTotalsSql(query.mock.calls[2][0]);
    expect(totals).toContain('COUNT(DISTINCT (m.account_id, m.message_id))');
    expect(totals).not.toMatch(/folder\s*=/);
  });

  it('counts thread messages across all folders for the unified inbox threaded view (#576)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }, { id: 'acc-2' }] })
      .mockResolvedValueOnce({ rows: [{ n: 20 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await listMessages({ userId: 'user-1', threaded: 'true' });

    const sql = query.mock.calls[2][0];
    const totals = threadTotalsSql(sql);
    expect(totals).toContain('COUNT(DISTINCT (m.account_id, m.message_id))');
    expect(totals).not.toMatch(/folder\s*=/);
    // The listed rows themselves stay INBOX-only; only the count widens.
    expect(sql).toContain("m.folder = 'INBOX'");
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
