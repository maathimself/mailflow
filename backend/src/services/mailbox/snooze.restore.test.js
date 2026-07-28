import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, adjustFolderCounts: vi.fn() };
});

import { query } from '../db.js';
import { adjustFolderCounts } from '../../utils/mailUtils.js';
import { ImapManager } from '../imapManager.js';
import { restoreSnoozedRow } from './snooze.js';

const row = {
  snooze_id: 's1',
  user_id: 'u1',
  account_id: 'a1',
  message_id_header: '<m@example.test>',
  original_folder: 'INBOX',
  snoozed_folder: 'Snoozed',
  uid: 10,
  is_read: true,
};
const account = { id: 'a1' };

beforeEach(() => {
  query.mockReset();
  adjustFolderCounts.mockReset();
});

describe('_runSnoozeWakeup watcher characterization', () => {
  it('restores a due UIDPLUS row, marks it unread, removes its record, adjusts counts, and broadcasts', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT sm.id AS snooze_id')) return { rows: [row] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = {
      _guardMoveUid: vi.fn(),
      _unguardMoveUid: vi.fn(),
      moveMessageGetNewUid: vi.fn().mockResolvedValue(110),
      setFlag: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn(),
    };

    await ImapManager.prototype._runSnoozeWakeup.call(imap);

    expect(imap._guardMoveUid).toHaveBeenCalledWith('a1', 'Snoozed', 10);
    expect(imap.moveMessageGetNewUid).toHaveBeenCalledWith(account, 10, 'Snoozed', 'INBOX');
    expect(imap.setFlag).toHaveBeenCalledWith(account, 110, 'INBOX', '\\Seen', false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE messages SET folder = $1, is_read = false'),
      ['INBOX', 'a1', '<m@example.test>', 110, 'Snoozed'],
    );
    expect(query).toHaveBeenCalledWith('DELETE FROM snoozed_messages WHERE id = $1', ['s1']);
    expect(adjustFolderCounts).toHaveBeenNthCalledWith(1, 'a1', 'Snoozed', -1, 0);
    expect(adjustFolderCounts).toHaveBeenNthCalledWith(2, 'a1', 'INBOX', 1, 1);
    expect(imap.broadcast).toHaveBeenCalledWith({ type: 'snooze_wakeup', accountId: 'a1' }, 'u1');
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'Snoozed', 10);
  });
});

describe('restoreSnoozedRow', () => {
  it('owns the UIDPLUS move, unread flag, DB repoint, and guard protocol', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = {
      _guardMoveUid: vi.fn(),
      _unguardMoveUid: vi.fn(),
      moveMessageGetNewUid: vi.fn().mockResolvedValue(110),
      setFlag: vi.fn().mockResolvedValue(undefined),
    };

    await restoreSnoozedRow(imap, row, { markUnread: true });

    expect(imap._guardMoveUid).toHaveBeenCalledWith('a1', 'Snoozed', 10);
    expect(imap.moveMessageGetNewUid).toHaveBeenCalledWith(account, 10, 'Snoozed', 'INBOX');
    expect(imap.setFlag).toHaveBeenCalledWith(account, 110, 'INBOX', '\\Seen', false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('is_read = false'),
      ['INBOX', 'a1', '<m@example.test>', 110, 'Snoozed'],
    );
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'Snoozed', 10);
  });

  it('uses a Message-ID search to mark unread without UIDPLUS', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const lock = { release: vi.fn() };
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue(lock),
      search: vi.fn().mockResolvedValue([210]),
      messageFlagsRemove: vi.fn().mockResolvedValue(true),
    };
    const imap = {
      _guardMoveUid: vi.fn(),
      _unguardMoveUid: vi.fn(),
      moveMessageGetNewUid: vi.fn().mockResolvedValue(null),
      _withFreshClient: vi.fn(async (_account, fn) => fn(client)),
    };

    await restoreSnoozedRow(imap, row, { markUnread: true });

    expect(client.search).toHaveBeenCalledWith(
      { header: ['Message-ID', '<m@example.test>'] },
      { uid: true },
    );
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('210', ['\\Seen'], { uid: true });
    expect(lock.release).toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('is_read = false'),
      ['INBOX', 'a1', '<m@example.test>', 'Snoozed'],
    );
    expect(imap._guardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'Snoozed', 10);
  });
});
