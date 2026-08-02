import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adjustFolderCounts: vi.fn(),
    resolveTrashFolder: vi.fn(),
    resolveAllTrashPaths: vi.fn(),
    resolveAllDraftsPaths: vi.fn(),
  };
});
vi.mock('../gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));

import { query } from '../db.js';
import {
  resolveAllDraftsPaths,
  resolveAllTrashPaths,
  resolveTrashFolder,
} from '../../utils/mailUtils.js';
import { bulkTrash } from './trash.js';

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

function manager() {
  return {
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    bulkMoveMessages: vi.fn().mockResolvedValue({
      uidMap: new Map([[10, 110]]),
      succeeded: [10],
      failed: [],
    }),
    bulkPermanentDelete: vi.fn().mockResolvedValue({ succeeded: [10], failed: [] }),
    syncFolderOnDemand: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
  };
}

function stubQueries(row = message) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [row] };
    if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  resolveTrashFolder.mockReset();
  resolveAllTrashPaths.mockReset();
  resolveAllDraftsPaths.mockReset();
  resolveTrashFolder.mockResolvedValue('Trash');
  resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
  resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
});

describe('bulkTrash', () => {
  it('narrows ownership to accountIds before IMAP work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await bulkTrash(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      ids: [ID],
      allowPermanent: true,
    });

    expect(result).toEqual({ ok: true, deleted: [] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($3::uuid[])');
    expect(params).toEqual(['u1', [ID], ['a1']]);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(imap.bulkPermanentDelete).not.toHaveBeenCalled();
  });

  it('refuses an already-trash message when permanent deletion is not allowed', async () => {
    stubQueries({ ...message, folder: 'Trash' });
    const imap = manager();

    const result = await bulkTrash(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      allowPermanent: false,
    });

    expect(result).toEqual({
      ok: true,
      deleted: [],
      trashedDetails: [],
      failed: [],
      refused: [{
        id: ID,
        folder: 'Trash',
        reason: 'already_in_trash_permanent_delete_required',
      }],
    });
    expect(imap.bulkPermanentDelete).not.toHaveBeenCalled();
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(imap._guardMoveUid).not.toHaveBeenCalled();
  });

  it('returns destination metadata for the non-permanent tool path', async () => {
    stubQueries();

    const result = await bulkTrash(manager(), {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      allowPermanent: false,
    });

    expect(result).toEqual({
      ok: true,
      deleted: [ID],
      trashedDetails: [{
        id: ID,
        accountId: 'a1',
        folder: 'Trash',
        uid: 110,
      }],
      failed: [],
      refused: [],
    });
  });

  it('surfaces per-message move failures for the non-permanent tool path', async () => {
    stubQueries();
    const imap = manager();
    imap.bulkMoveMessages.mockResolvedValue({
      uidMap: new Map(),
      succeeded: [],
      failed: [10],
    });

    const result = await bulkTrash(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      allowPermanent: false,
    });

    expect(result.failed).toEqual([{ id: ID, reason: 'IMAP move failed' }]);
  });

  it('preserves permanent expunge for the REST-compatible allowPermanent path', async () => {
    stubQueries({ ...message, folder: 'Trash' });
    const imap = manager();

    const result = await bulkTrash(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      allowPermanent: true,
    });

    expect(result).toEqual({ ok: true, deleted: [ID] });
    expect(imap.bulkPermanentDelete).toHaveBeenCalledWith(account, [10], 'Trash');
    expect(query).toHaveBeenCalledWith('DELETE FROM messages WHERE id = ANY($1::uuid[])', [[ID]]);
  });

  it('preserves the guarded move-to-trash UIDPLUS path', async () => {
    stubQueries();
    const imap = manager();

    const result = await bulkTrash(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      allowPermanent: true,
    });

    expect(result).toEqual({ ok: true, deleted: [ID] });
    expect(imap.bulkMoveMessages).toHaveBeenCalledWith(account, [10], 'INBOX', 'Trash');
    expect(imap._guardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
  });

  it('keeps the non-UIDPLUS delete-only path and trash-folder resync', async () => {
    stubQueries();
    const imap = manager();
    imap.bulkMoveMessages.mockResolvedValue({
      uidMap: new Map(),
      succeeded: [10],
      failed: [],
    });

    const result = await bulkTrash(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      allowPermanent: true,
    });

    expect(result).toEqual({ ok: true, deleted: [ID] });
    const cte = query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'));
    expect(cte[1]).toEqual([[ID], [], [], 'Trash']);
    expect(imap.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Trash');
  });

  it('releases the source guard when a trash move throws', async () => {
    stubQueries();
    const imap = manager();
    imap.bulkMoveMessages.mockRejectedValue(new Error('trash failed'));

    const result = await bulkTrash(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID],
      allowPermanent: true,
    });

    expect(result).toEqual({ ok: false, status: 500, error: 'Failed to delete messages' });
    expect(imap._guardMoveUid).toHaveBeenCalledTimes(1);
    expect(imap._unguardMoveUid).toHaveBeenCalledTimes(1);
  });
});
