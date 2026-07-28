import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import {
  countMessagesIn,
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
} from './folders.js';

const account = { id: 'a1', user_id: 'u1' };

function manager() {
  return {
    createFolder: vi.fn().mockResolvedValue(undefined),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    renameFolder: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => query.mockReset());

describe('listFolders', () => {
  it('returns folders only after a scope-checked account lookup', async () => {
    const folders = [{ account_id: 'a1', path: 'INBOX' }];
    query.mockResolvedValueOnce({ rows: [account] }).mockResolvedValueOnce({ rows: folders });

    const result = await listFolders(null, {
      userId: 'u1',
      accountIds: ['a1'],
      accountId: 'a1',
    });

    expect(result).toEqual({ ok: true, folders });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('id = ANY($3::uuid[])');
    expect(params).toEqual(['a1', 'u1', ['a1']]);
  });
});

describe('createFolder', () => {
  it('prevents an out-of-scope account from reaching IMAP', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await createFolder(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      accountId: 'a2',
      name: 'Projects',
      parentPath: null,
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Account not found' });
    expect(query.mock.calls[0][0]).toContain('id = ANY($3::uuid[])');
    expect(imap.createFolder).not.toHaveBeenCalled();
  });

  it('preserves delimiter-based child path creation', async () => {
    query
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({ rows: [{ delimiter: '.' }] })
      .mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await createFolder(imap, {
      userId: 'u1',
      accountIds: null,
      accountId: 'a1',
      name: 'Child',
      parentPath: 'Parent',
    });

    expect(result).toEqual({ ok: true, path: 'Parent.Child' });
    expect(imap.createFolder).toHaveBeenCalledWith(account, 'Parent.Child');
  });
});

describe('renameFolder', () => {
  it('renames only the last path component and updates folder/message rows', async () => {
    query
      .mockResolvedValueOnce({ rows: [account] })
      .mockResolvedValueOnce({ rows: [{ delimiter: '/' }] })
      .mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await renameFolder(imap, {
      userId: 'u1',
      accountIds: null,
      accountId: 'a1',
      oldPath: 'Parent/Old',
      newName: 'New',
    });

    expect(result).toEqual({ ok: true, newPath: 'Parent/New' });
    expect(imap.renameFolder).toHaveBeenCalledWith(account, 'Parent/Old', 'Parent/New');
  });
});

describe('deleteFolder', () => {
  it('deletes the IMAP folder before local folder and message rows', async () => {
    query.mockResolvedValueOnce({ rows: [account] }).mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await deleteFolder(imap, {
      userId: 'u1',
      accountIds: null,
      accountId: 'a1',
      path: 'Projects',
    });

    expect(result).toEqual({ ok: true });
    expect(imap.deleteFolder).toHaveBeenCalledWith(account, 'Projects');
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM messages WHERE account_id = $1 AND folder = $2',
      ['a1', 'Projects'],
    );
  });
});

describe('countMessagesIn', () => {
  it('returns the live message count for an account and path', async () => {
    query.mockResolvedValue({ rows: [{ count: '7' }] });

    const count = await countMessagesIn('a1', 'Projects');

    expect(count).toBe(7);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('COUNT(*)'),
      ['a1', 'Projects'],
    );
  });
});
