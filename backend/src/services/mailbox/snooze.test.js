import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, adjustFolderCounts: vi.fn() };
});
vi.mock('../gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));

import { query } from '../db.js';
import {
  gatherSnoozeConversation,
  snoozeConversation,
  unsnoozeConversation,
} from './snooze.js';

const ID = '11111111-1111-4111-8111-111111111111';
const message = {
  id: ID,
  account_id: 'a1',
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@example.test>',
  thread_id: null,
  is_read: false,
};
const account = { id: 'a1' };

function manager() {
  return {
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    moveMessage: vi.fn().mockResolvedValue(110),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
  };
}

beforeEach(() => {
  query.mockReset();
});

describe('gatherSnoozeConversation', () => {
  it('returns an unthreaded message without querying', async () => {
    await expect(gatherSnoozeConversation(message)).resolves.toEqual([message]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('snoozeConversation', () => {
  it('narrows ownership to accountIds before IMAP work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await snoozeConversation(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      id: ID,
      until: new Date(Date.now() + 60_000),
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Message not found' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($3::uuid[])');
    expect(params).toEqual([ID, 'u1', ['a1']]);
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });

  it('moves, records, and unguards the acted message', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) return { rows: [message] };
      if (sql.includes('SELECT id FROM snoozed_messages')) return { rows: [] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager();
    const until = new Date(Date.now() + 60_000);

    const result = await snoozeConversation(imap, {
      userId: 'u1',
      accountIds: null,
      id: ID,
      until,
    });

    expect(result).toEqual({
      ok: true,
      movedCount: 1,
      movedIds: [ID],
      folder: 'Snoozed',
    });
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Snoozed');
    expect(imap.moveMessage).toHaveBeenCalledWith(account, 10, 'INBOX', 'Snoozed');
    expect(imap._guardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
    expect(imap._unguardMoveUid).toHaveBeenCalledWith('a1', 'INBOX', 10);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO snoozed_messages'),
      ['u1', 'a1', '<m@example.test>', 'INBOX', until.toISOString(), 'Snoozed'],
    );
  });

  it('maps an acted-message IMAP failure while still releasing its guard', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) return { rows: [message] };
      if (sql.includes('SELECT id FROM snoozed_messages')) return { rows: [] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager();
    imap.moveMessage.mockRejectedValue(new Error('move failed'));

    const result = await snoozeConversation(imap, {
      userId: 'u1',
      accountIds: null,
      id: ID,
      until: new Date(Date.now() + 60_000),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: 'Failed to move message to Snoozed folder',
    });
    expect(imap._unguardMoveUid).toHaveBeenCalledTimes(1);
  });
});

describe('unsnoozeConversation', () => {
  it('narrows ownership to accountIds before restore work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await unsnoozeConversation(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      id: ID,
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Message not found' });
    expect(query.mock.calls[0][0]).toContain('m.account_id = ANY($3::uuid[])');
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });

  it('returns 400 when the acted message has no snooze record', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) return { rows: [message] };
      if (sql.includes('FROM snoozed_messages sm')) return { rows: [] };
      return { rows: [] };
    });

    const result = await unsnoozeConversation(manager(), {
      userId: 'u1',
      accountIds: null,
      id: ID,
    });

    expect(result).toEqual({ ok: false, status: 400, error: 'Message is not currently snoozed' });
  });

  it('restores the whole reply chain without marking read messages unread', async () => {
    const root = { ...message, thread_id: 't', folder: 'Snoozed', is_read: true };
    const reply = {
      ...root,
      id: '22222222-2222-4222-8222-222222222222',
      uid: 11,
      message_id: '<r@example.test>',
      in_reply_to: '<m@example.test>',
      thread_references: '<m@example.test>',
      is_read: false,
    };
    const snoozedRows = [
      {
        snooze_id: 's1',
        user_id: 'u1',
        account_id: 'a1',
        message_id_header: root.message_id,
        original_folder: 'INBOX',
        snoozed_folder: 'Snoozed',
        uid: 10,
        is_read: true,
      },
      {
        snooze_id: 's2',
        user_id: 'u1',
        account_id: 'a1',
        message_id_header: reply.message_id,
        original_folder: 'INBOX',
        snoozed_folder: 'Snoozed',
        uid: 11,
        is_read: false,
      },
    ];
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) return { rows: [root] };
      if (sql.includes('WHERE account_id = $1 AND thread_id = $2')) return { rows: [root, reply] };
      if (sql.includes('FROM snoozed_messages sm')) return { rows: snoozedRows };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = {
      _guardMoveUid: vi.fn(),
      _unguardMoveUid: vi.fn(),
      moveMessageGetNewUid: vi.fn()
        .mockResolvedValueOnce(110)
        .mockResolvedValueOnce(111),
      setFlag: vi.fn(),
      broadcast: vi.fn(),
    };

    const result = await unsnoozeConversation(imap, {
      userId: 'u1',
      accountIds: null,
      id: ID,
    });

    expect(result).toEqual({ ok: true, restored: 2, folder: 'INBOX' });
    expect(imap.moveMessageGetNewUid).toHaveBeenCalledTimes(2);
    expect(imap.setFlag).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([sql]) => sql === 'DELETE FROM snoozed_messages WHERE id = $1')).toHaveLength(2);
    const repoints = query.mock.calls.filter(([sql]) => sql.includes('UPDATE messages SET folder'));
    expect(repoints.every(([sql]) => !sql.includes('is_read = false'))).toBe(true);
  });

  it('marks restored messages unread when explicitly requested', async () => {
    const root = { ...message, folder: 'Snoozed', is_read: true };
    const snoozedRow = {
      snooze_id: 's1',
      user_id: 'u1',
      account_id: 'a1',
      message_id_header: root.message_id,
      original_folder: 'INBOX',
      snoozed_folder: 'Snoozed',
      uid: 10,
      is_read: true,
    };
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) return { rows: [root] };
      if (sql.includes('FROM snoozed_messages sm')) return { rows: [snoozedRow] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = {
      _guardMoveUid: vi.fn(),
      _unguardMoveUid: vi.fn(),
      moveMessageGetNewUid: vi.fn().mockResolvedValue(110),
      setFlag: vi.fn(),
      broadcast: vi.fn(),
    };

    const result = await unsnoozeConversation(imap, {
      userId: 'u1',
      accountIds: null,
      id: ID,
      markUnread: true,
    });

    expect(result).toEqual({ ok: true, restored: 1, folder: 'INBOX' });
    expect(imap.setFlag).toHaveBeenCalledWith(
      account,
      110,
      'INBOX',
      '\\Seen',
      false,
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('is_read = false'),
      ['INBOX', 'a1', '<m@example.test>', 110, 'Snoozed'],
    );
  });
});
