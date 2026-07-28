import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adjustFolderCounts: vi.fn(),
    resolveArchiveFolder: vi.fn(),
    isAllMailFolder: vi.fn(),
  };
});
vi.mock('../gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));

import { query } from '../db.js';
import {
  adjustFolderCounts,
  isAllMailFolder,
  resolveArchiveFolder,
} from '../../utils/mailUtils.js';
import { bulkArchive } from './archive.js';

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

function stubQueries() {
  query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [message] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  resolveArchiveFolder.mockReset();
  isAllMailFolder.mockReset();
  adjustFolderCounts.mockReset();
  resolveArchiveFolder.mockResolvedValue('Archive');
  isAllMailFolder.mockResolvedValue(false);
});

describe('bulkArchive', () => {
  it('narrows ownership to accountIds before IMAP work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await bulkArchive(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      ids: [ID],
    });

    expect(result).toEqual({
      ok: true,
      archived: [],
      archivedDetails: [],
      failed: [],
      noArchiveFolder: [],
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($3::uuid[])');
    expect(params).toEqual(['u1', [ID], ['a1']]);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
  });

  it('preserves the UIDPLUS reinsert and signed source/destination deltas', async () => {
    stubQueries();
    const imap = manager();

    const result = await bulkArchive(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
    });

    expect(result).toEqual({
      ok: true,
      archived: [ID],
      archivedDetails: [{
        id: ID,
        accountId: 'a1',
        folder: 'Archive',
        uid: 110,
        destinationUntracked: false,
      }],
      failed: [],
      noArchiveFolder: [],
    });
    const cte = query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'));
    expect(cte[1]).toEqual([[ID], [ID], [110], 'Archive']);
    expect(adjustFolderCounts).toHaveBeenCalledWith('a1', 'INBOX', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith('a1', 'Archive', 1, 1);
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
  });

  it('deletes the DB row instead of rehoming it for Gmail All Mail', async () => {
    stubQueries();
    isAllMailFolder.mockResolvedValue(true);
    resolveArchiveFolder.mockResolvedValue('[Gmail]/All Mail');
    const imap = manager();

    const result = await bulkArchive(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
    });

    expect(result).toEqual({
      ok: true,
      archived: [ID],
      archivedDetails: [{
        id: ID,
        accountId: 'a1',
        folder: '[Gmail]/All Mail',
        uid: 110,
        destinationUntracked: true,
      }],
      failed: [],
      noArchiveFolder: [],
    });
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM messages WHERE id = ANY($1::uuid[])',
      [[ID]],
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('WITH deleted AS'))).toBe(false);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(1);
    expect(adjustFolderCounts).toHaveBeenCalledWith('a1', 'INBOX', -1, -1);
  });

  it('keeps the non-UIDPLUS delete-only path and destination resync', async () => {
    stubQueries();
    const imap = manager({ uidMap: new Map(), succeeded: [10], failed: [] });

    const result = await bulkArchive(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
    });

    expect(result).toEqual({
      ok: true,
      archived: [ID],
      archivedDetails: [{
        id: ID,
        accountId: 'a1',
        folder: 'Archive',
        uid: null,
        destinationUntracked: false,
      }],
      failed: [],
      noArchiveFolder: [],
    });
    const cte = query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'));
    expect(cte[1]).toEqual([[ID], [], [], 'Archive']);
    expect(imap.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Archive');
  });

  it('releases the source guard when IMAP archive throws', async () => {
    stubQueries();
    const imap = manager();
    imap.bulkMoveMessages.mockRejectedValue(new Error('archive failed'));

    const result = await bulkArchive(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
    });

    expect(result).toEqual({ ok: false, status: 500, error: 'Failed to archive messages' });
    expect(imap._guardMoveUid).toHaveBeenCalledTimes(1);
    expect(imap._unguardMoveUid).toHaveBeenCalledTimes(1);
  });

  it('surfaces per-message IMAP failures', async () => {
    const failedMessage = {
      ...message,
      id: '22222222-2222-4222-8222-222222222222',
      uid: 11,
    };
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) {
        return { rows: [message, failedMessage] };
      }
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager({
      uidMap: new Map([[10, 110]]),
      succeeded: [10],
      failed: [11],
    });

    const result = await bulkArchive(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [message.id, failedMessage.id],
    });

    expect(result.failed).toEqual([{
      id: failedMessage.id,
      reason: 'IMAP move failed',
    }]);
  });

  it('keeps accounts without archive folders in a named partition', async () => {
    stubQueries();
    resolveArchiveFolder.mockResolvedValue(null);

    const result = await bulkArchive(manager(), {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
    });

    expect(result).toEqual({
      ok: true,
      archived: [],
      archivedDetails: [],
      failed: [],
      noArchiveFolder: ['a1'],
    });
  });
});
