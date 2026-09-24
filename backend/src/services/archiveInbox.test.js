import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(async () => '[Gmail]/All Mail'),
  isAllMailFolder: vi.fn(async () => true),
  adjustFolderCounts: vi.fn(),
  fanOutReadToSiblings: vi.fn(async () => {}),
}));

import { query } from './db.js';
import { adjustFolderCounts, resolveArchiveFolder, isAllMailFolder } from '../utils/mailUtils.js';
import { markThreadRead } from './labels.js';
import { archiveInboxCopy, archiveMessageCopy } from './archiveInbox.js';

const account = { id: 'account-1', folder_mappings: {} };
const inboxCopy = { id: 'message-1', uid: 42, message_id: '<mail@example>' };

describe('archiveInboxCopy Gmail All Mail', () => {
  beforeEach(() => {
    query.mockReset(); adjustFolderCounts.mockReset();
    resolveArchiveFolder.mockResolvedValue('[Gmail]/All Mail');
    isAllMailFolder.mockResolvedValue(true);
  });

  it('uses the Message-ID returned by markThreadRead to find an indexed All Mail copy with another UID', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(),
      moveMessage: vi.fn(async () => 101), setFlag: vi.fn(async () => {}) };
    query.mockResolvedValueOnce({ rows: [{ ...inboxCopy, is_read: false }] })
      .mockResolvedValueOnce({ rows: [{ id: 'all-mail-copy', uid: 202 }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const { inboxCopy: returned } = await markThreadRead(manager, account,
      { account_id: account.id, message_id: inboxCopy.message_id });
    expect((await archiveInboxCopy(manager, account, returned)).archived).toBe(true);
    expect(query.mock.calls[1][1]).toEqual([account.id, '[Gmail]/All Mail', inboxCopy.id, 101, inboxCopy.message_id]);
    expect(query.mock.calls[2][0]).toMatch(/^DELETE FROM messages WHERE id = \$1 AND folder = \$2/);
    expect(query.mock.calls[2][1]).toEqual([inboxCopy.id, 'INBOX']);
  });

  it('repoints the Inbox row to the synced All Mail folder and updates both counts', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(),
      moveMessage: vi.fn(async () => 101) };
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1 });
    const result = await archiveInboxCopy(manager, account, inboxCopy);
    expect(result.archived).toBe(true);
    expect(query.mock.calls[1][0]).toMatch(/^UPDATE messages SET folder = \$1, uid = \$2/);
    expect(query.mock.calls[1][1]).toEqual(['[Gmail]/All Mail', 101, 'message-1', 'INBOX']);
    expect(adjustFolderCounts).toHaveBeenCalledWith('account-1', 'INBOX', -1, 0);
    expect(adjustFolderCounts).toHaveBeenCalledWith('account-1', '[Gmail]/All Mail', 1, 0);
  });

  it('removes only the Inbox copy when All Mail is already indexed', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), moveMessage: vi.fn(async () => 101) };
    query.mockResolvedValueOnce({ rows: [{ id: 'all-mail-copy' }] }).mockResolvedValueOnce({ rowCount: 1 });
    expect((await archiveInboxCopy(manager, account, inboxCopy)).archived).toBe(true);
    expect(query.mock.calls[1][0]).toMatch(/^DELETE FROM messages WHERE id = \$1 AND folder = \$2/);
    expect(query.mock.calls[1][1]).toEqual(['message-1', 'INBOX']);
    expect(adjustFolderCounts).toHaveBeenCalledWith('account-1', 'INBOX', -1, 0);
    expect(adjustFolderCounts).not.toHaveBeenCalledWith('account-1', '[Gmail]/All Mail', 1, 0);
  });

  it('removes the Inbox copy when a destination sync wins after lookup', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), moveMessage: vi.fn(async () => 101) };
    query.mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate copy'), { code: '23505' }))
      .mockResolvedValueOnce({ rowCount: 1 });
    expect((await archiveInboxCopy(manager, account, inboxCopy)).archived).toBe(true);
    expect(query.mock.calls[2][0]).toMatch(/^DELETE FROM messages WHERE id = \$1 AND folder = \$2/);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(1);
  });
});

describe('archiveInboxCopy ordinary Archive', () => {
  beforeEach(() => {
    query.mockReset(); adjustFolderCounts.mockReset();
    resolveArchiveFolder.mockResolvedValue('Archive');
    isAllMailFolder.mockResolvedValue(false);
  });

  it('repoints the moved Inbox row even when Archive already holds a copy of its Message-ID', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), moveMessage: vi.fn(async () => 101) };
    query.mockResolvedValueOnce({ rowCount: 1 });
    expect(await archiveInboxCopy(manager, account, inboxCopy)).toEqual({ archived: true, noArchiveFolder: false });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^UPDATE messages SET folder = \$1, uid = \$2/);
    expect(adjustFolderCounts).toHaveBeenCalledWith(account.id, 'INBOX', -1, 0);
    expect(adjustFolderCounts).toHaveBeenCalledWith(account.id, 'Archive', 1, 0);
    expect(manager._guardMoveUid).toHaveBeenCalledWith(account.id, 'INBOX', inboxCopy.uid);
    expect(manager._unguardMoveUid).toHaveBeenCalledWith(account.id, 'INBOX', inboxCopy.uid);
  });

  it('does not delete the Inbox row after an ordinary Archive UID conflict', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), moveMessage: vi.fn(async () => 101) };
    query.mockRejectedValueOnce(Object.assign(new Error('destination conflict'), { code: '23505' }));
    await expect(archiveInboxCopy(manager, account, inboxCopy)).rejects.toThrow('destination conflict');
    expect(query).toHaveBeenCalledTimes(1);
    expect(adjustFolderCounts).not.toHaveBeenCalled();
    expect(manager._unguardMoveUid).toHaveBeenCalledWith(account.id, 'INBOX', inboxCopy.uid);
  });

  it('holds the ordinary Archive destination guard until non-UIDPLUS sync can learn the UID', async () => {
    vi.useFakeTimers();
    try {
      const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn(), moveMessage: vi.fn(async () => null) };
      query.mockResolvedValueOnce({ rowCount: 1 });
      expect((await archiveInboxCopy(manager, account, inboxCopy)).archived).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(manager._guardMoveUid).toHaveBeenCalledWith(account.id, 'Archive', inboxCopy.uid);
      expect(manager._unguardMoveUid).toHaveBeenCalledWith(account.id, 'INBOX', inboxCopy.uid);
      expect(manager._unguardMoveUid).not.toHaveBeenCalledWith(account.id, 'Archive', inboxCopy.uid);
      vi.advanceTimersByTime(10_000);
      expect(manager._unguardMoveUid).toHaveBeenCalledWith(account.id, 'Archive', inboxCopy.uid);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('archiveMessageCopy options for inbox rules', () => {
  beforeEach(() => { query.mockReset(); adjustFolderCounts.mockReset(); });

  it('uses the caller source folder, move adapter, and unread count', async () => {
    const manager = { _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn() };
    const moveUid = vi.fn(async () => 301);
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await archiveMessageCopy(manager, account, inboxCopy, {
      sourceFolder: 'Rules', archiveFolder: 'Archive', archiveIsAllMail: false,
      unreadDelta: 1, moveUid,
    });
    expect(result).toEqual({ archived: true, noArchiveFolder: false, newUid: 301 });
    expect(moveUid).toHaveBeenCalledWith('Archive');
    expect(query.mock.calls[0][1]).toEqual(['Archive', 301, inboxCopy.id, 'Rules']);
    expect(manager._guardMoveUid).toHaveBeenCalledWith(account.id, 'Rules', inboxCopy.uid);
    expect(adjustFolderCounts).toHaveBeenCalledWith(account.id, 'Rules', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(account.id, 'Archive', 1, 1);
  });
});
