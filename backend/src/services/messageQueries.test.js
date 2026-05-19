import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  listAccounts, listFolders, listMessages, getUnreadCounts,
  getMessage, getThread, searchMessages,
} from './messageQueries.js';

beforeEach(() => vi.clearAllMocks());

describe('listAccounts', () => {
  it('returns rows for user', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: '1', email_address: 'a@b.com' }] });
    const result = await listAccounts('u1');
    expect(result).toEqual([{ id: '1', email_address: 'a@b.com' }]);
    expect(query.mock.calls[0][1]).toEqual(['u1']);
  });
});

describe('listFolders', () => {
  it('filters by accountId when provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await listFolders('u1', 'acc1');
    expect(query.mock.calls[0][0]).toContain('f.account_id');
    expect(query.mock.calls[0][1]).toContain('acc1');
  });

  it('returns all folders when no accountId', async () => {
    query.mockResolvedValueOnce({ rows: [{ path: 'INBOX' }] });
    const result = await listFolders('u1');
    expect(result).toEqual([{ path: 'INBOX' }]);
    // SELECT always has f.account_id; only the WHERE clause should lack a filter
    expect(query.mock.calls[0][0]).not.toMatch(/WHERE.*f\.account_id\s*=/);
  });
});

describe('listMessages', () => {
  it('applies unread filter', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await listMessages('u1', { unreadOnly: true });
    expect(query.mock.calls[0][0]).toContain('is_read = false');
  });

  it('applies folder and accountId filters', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await listMessages('u1', { folder: 'INBOX', accountId: 'acc1' });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('m.folder');
    expect(sql).toContain('m.account_id');
  });

  it('always excludes deleted messages', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await listMessages('u1');
    expect(query.mock.calls[0][0]).toContain('is_deleted = false');
  });
});

describe('getUnreadCounts', () => {
  it('returns total unread rows', async () => {
    const rows = [{ account: 'a@b.com', folder: 'INBOX', unread_count: 3 }];
    query.mockResolvedValueOnce({ rows });
    const result = await getUnreadCounts('u1');
    expect(result).toEqual(rows);
  });

  it('filters by accountId when provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getUnreadCounts('u1', 'acc1');
    expect(query.mock.calls[0][1]).toContain('acc1');
  });
});

describe('getMessage', () => {
  it('returns message row when found', async () => {
    const row = { id: 'm1', subject: 'Hello', account_email: 'a@b.com' };
    query.mockResolvedValueOnce({ rows: [row] });
    const result = await getMessage('m1', 'u1');
    expect(result).toEqual(row);
  });

  it('returns null when not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await getMessage('missing', 'u1');
    expect(result).toBeNull();
  });
});

describe('getThread', () => {
  it('returns empty array when user has no accounts', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await getThread('t1', 'u1');
    expect(result).toEqual([]);
  });

  it('returns messages sorted by date ascending', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acc1' }] });
    const messages = [
      { message_id: 'b', date: '2024-01-02T00:00:00Z' },
      { message_id: 'a', date: '2024-01-01T00:00:00Z' },
    ];
    query.mockResolvedValueOnce({ rows: messages });
    const result = await getThread('t1', 'u1');
    expect(result[0].message_id).toBe('a');
    expect(result[1].message_id).toBe('b');
  });
});

describe('searchMessages', () => {
  it('returns matching rows', async () => {
    const rows = [{ id: 'm1', subject: 'hello world' }];
    query.mockResolvedValueOnce({ rows });
    const result = await searchMessages('u1', 'world');
    expect(result).toEqual(rows);
  });

  it('applies accountId filter when provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await searchMessages('u1', 'test', { accountId: 'acc1' });
    expect(query.mock.calls[0][0]).toContain('m.account_id');
    expect(query.mock.calls[0][1]).toContain('acc1');
  });

  it('uses ILIKE with wildcards around query', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await searchMessages('u1', 'needle');
    const params = query.mock.calls[0][1];
    expect(params).toContain('%needle%');
  });
});
