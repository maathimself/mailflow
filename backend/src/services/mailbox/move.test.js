import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, adjustFolderCounts: vi.fn() };
});
vi.mock('../gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));

import { query } from '../db.js';
import { adjustFolderCounts } from '../../utils/mailUtils.js';
import { bulkMoveToFolder, resolveMovedIds } from './move.js';

const ID = '11111111-1111-4111-8111-111111111111';
const message = {
  id: ID,
  account_id: 'a1',
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@example.test>',
  is_read: false,
};
const account = { id: 'a1' };

function manager(result = {
  uidMap: new Map([[10, 110]]),
  succeeded: [10],
  failed: [],
}) {
  return {
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    bulkMoveMessages: vi.fn().mockResolvedValue(result),
    syncFolderOnDemand: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
  };
}

function stubMoveQueries() {
  query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT m.*, a.user_id')) return { rows: [message] };
    if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ exists: 1 }] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  adjustFolderCounts.mockReset();
});

describe('bulkMoveToFolder', () => {
  it('narrows ownership to accountIds before IMAP work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await bulkMoveToFolder(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      ids: [ID],
      folder: 'Archive',
    });

    expect(result).toEqual({
      ok: true,
      moved: [],
      movedDetails: [],
      failed: [],
      skippedAccounts: [],
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($3::uuid[])');
    expect(params).toEqual(['u1', [ID], ['a1']]);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('preserves the guarded UIDPLUS CTE path and signed count deltas', async () => {
    stubMoveQueries();
    const imap = manager();

    const result = await bulkMoveToFolder(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      folder: 'Archive',
    });

    expect(result).toEqual({
      ok: true,
      moved: [ID],
      movedDetails: [{ id: ID, accountId: 'a1', uid: 110 }],
      failed: [],
      skippedAccounts: [],
    });
    expect(imap._guardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
    const cte = query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'));
    expect(cte[1]).toEqual([[ID], [ID], [110], 'Archive']);
    expect(adjustFolderCounts).toHaveBeenNthCalledWith(1, 'a1', 'INBOX', -1, -1);
    expect(adjustFolderCounts).toHaveBeenNthCalledWith(2, 'a1', 'Archive', 1, 1);
  });

  it('keeps the non-UIDPLUS delete-only path and requests a destination resync', async () => {
    stubMoveQueries();
    const imap = manager({ uidMap: new Map(), succeeded: [10], failed: [] });

    const result = await bulkMoveToFolder(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      folder: 'Archive',
    });

    expect(result).toEqual({
      ok: true,
      moved: [ID],
      movedDetails: [{ id: ID, accountId: 'a1', uid: null }],
      failed: [],
      skippedAccounts: [],
    });
    const cte = query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'));
    expect(cte[1]).toEqual([[ID], [], [], 'Archive']);
    expect(imap.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Archive');
  });

  it('releases every source guard when IMAP move throws', async () => {
    stubMoveQueries();
    const imap = manager();
    imap.bulkMoveMessages.mockRejectedValue(new Error('move failed'));

    const result = await bulkMoveToFolder(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      folder: 'Archive',
    });

    expect(result).toEqual({ ok: false, status: 500, error: 'Failed to move messages' });
    expect(imap._guardMoveUid).toHaveBeenCalledTimes(1);
    expect(imap._unguardMoveUid).toHaveBeenCalledTimes(1);
  });

  it('surfaces missing destination accounts and per-message IMAP failures', async () => {
    const failedMessage = {
      ...message,
      id: '22222222-2222-4222-8222-222222222222',
      uid: 11,
    };
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id')) return { rows: [message, failedMessage] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ exists: 1 }] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager({
      uidMap: new Map([[10, 110]]),
      succeeded: [10],
      failed: [11],
    });

    const result = await bulkMoveToFolder(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [message.id, failedMessage.id],
      folder: 'Archive',
    });

    expect(result.failed).toEqual([{
      id: failedMessage.id,
      reason: 'IMAP move failed',
    }]);
  });

  it('returns a skippedAccounts partition when a destination folder is absent', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id')) return { rows: [message] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [] };
      return { rows: [] };
    });

    const result = await bulkMoveToFolder(manager(), {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      folder: 'Missing',
    });

    expect(result).toEqual({
      ok: true,
      moved: [],
      movedDetails: [],
      failed: [],
      skippedAccounts: [{
        account_id: 'a1',
        reason: 'folder_not_found',
      }],
    });
  });
});

describe('resolveMovedIds', () => {
  it('returns destination rows for the supplied account, folder, and UIDs', async () => {
    query.mockResolvedValue({ rows: [{ id: 'new-id', uid: '110' }] });

    const rows = await resolveMovedIds('a1', 'Archive', [110]);

    expect(rows).toEqual([{ id: 'new-id', uid: '110' }]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('account_id = $1'),
      ['a1', 'Archive', [110]],
    );
  });
});
