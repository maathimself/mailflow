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
