import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adjustFolderCounts: vi.fn(),
    resolveSpamFolder: vi.fn(),
    resolveAllSpamPaths: vi.fn(),
  };
});
vi.mock('../gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));

import { query } from '../db.js';
import { resolveAllSpamPaths, resolveSpamFolder } from '../../utils/mailUtils.js';
import { markNotSpam, markSpam } from './spamLabel.js';

const ID = '11111111-1111-4111-8111-111111111111';
const message = {
  id: ID,
  account_id: 'a1',
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@example.test>',
  is_read: false,
  folder_mappings: {},
};
const account = { id: 'a1', user_id: 'u1', folder_mappings: {} };

function manager() {
  return {
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    moveMessage: vi.fn().mockResolvedValue(110),
    broadcast: vi.fn(),
  };
}

beforeEach(() => {
  query.mockReset();
  resolveSpamFolder.mockReset();
  resolveAllSpamPaths.mockReset();
});

describe('markSpam', () => {
  it('preserves the REST path when accountIds is null', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.account_id, a.folder_mappings')) {
        return { rows: [{ account_id: 'a1', folder_mappings: {} }] };
      }
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    resolveSpamFolder.mockResolvedValue('Junk');
    const imap = manager();

    const result = await markSpam(imap, { userId: 'u1', accountIds: null, id: ID });

    expect(result).toEqual({ ok: true, status: 200, body: { ok: true, folder: 'Junk', newUid: 110 } });
    expect(imap.moveMessage).toHaveBeenCalledWith(account, 10, 'INBOX', 'Junk');
    expect(imap._guardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
  });

  it('narrows ownership to non-null accountIds before any IMAP work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await markSpam(imap, { userId: 'u1', accountIds: ['a1'], id: ID });

    expect(result).toEqual({ ok: false, status: 404, error: 'Message not found' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($3::uuid[])');
    expect(params).toEqual([ID, 'u1', ['a1']]);
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });

  it('releases the source UID guard when the IMAP move fails', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.account_id, a.folder_mappings')) {
        return { rows: [{ account_id: 'a1', folder_mappings: {} }] };
      }
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    resolveSpamFolder.mockResolvedValue('Junk');
    const imap = manager();
    imap.moveMessage.mockRejectedValue(new Error('move failed'));

    const result = await markSpam(imap, { userId: 'u1', accountIds: null, id: ID });

    expect(result).toEqual({ ok: false, status: 502, error: 'IMAP move failed: move failed' });
    expect(imap._guardMoveUid).toHaveBeenCalledTimes(1);
    expect(imap._unguardMoveUid).toHaveBeenCalledTimes(1);
  });
});

describe('markNotSpam', () => {
  it('rejects a message outside all spam-like folders without moving it', async () => {
    query.mockResolvedValue({
      rows: [{ account_id: 'a1', folder: 'INBOX', folder_mappings: {} }],
    });
    resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
    const imap = manager();

    const result = await markNotSpam(imap, { userId: 'u1', accountIds: null, id: ID });

    expect(result).toEqual({ ok: false, status: 400, error: 'Message is not in the spam folder' });
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });
});
