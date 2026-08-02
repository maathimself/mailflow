import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});
vi.mock('../archiveInbox.js', () => ({ archiveInboxCopy: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fanOutReadToSiblings: vi.fn() };
});

import { query } from '../db.js';
import { archiveInboxCopy } from '../archiveInbox.js';
import { DEFAULT_GTD_FOLDERS, getGtdConfig } from '../gtdConfig.js';
import {
  gtdClassify,
  gtdDone,
  gtdUnclassify,
} from './actions.js';

const ID = '11111111-1111-4111-8111-111111111111';
const msg = {
  id: ID,
  account_id: 'a1',
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@example.test>',
  is_read: true,
};
const account = { id: 'a1', user_id: 'u1' };

function manager() {
  return {
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    copyMessage: vi.fn().mockResolvedValue(undefined),
    removeMessageCopy: vi.fn().mockResolvedValue(undefined),
    setFlag: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
  };
}

beforeEach(() => {
  query.mockReset();
  getGtdConfig.mockReset();
  archiveInboxCopy.mockReset();
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
});

describe('gtdClassify', () => {
  it('narrows message ownership to accountIds before IMAP work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await gtdClassify(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      messageId: ID,
      state: 'todo',
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Message not found' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($3::uuid[])');
    expect(params).toEqual([ID, 'u1', ['a1']]);
    expect(imap.copyMessage).not.toHaveBeenCalled();
  });

  it('preserves the ensure-and-copy receipt', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages m')) return { rows: [msg] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager();

    const result = await gtdClassify(imap, {
      userId: 'u1',
      accountIds: null,
      messageId: ID,
      state: 'todo',
    });

    expect(result).toEqual({ ok: true, folder: 'Todo' });
    expect(imap.ensureFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(imap.copyMessage).toHaveBeenCalledWith('a1', 10, 'INBOX', 'Todo');
  });
});

describe('gtdUnclassify', () => {
  it('removes the resolved label-folder copy', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages m')) return { rows: [msg] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 42 }] };
      return { rows: [] };
    });
    const imap = manager();

    const result = await gtdUnclassify(imap, {
      userId: 'u1',
      accountIds: null,
      messageId: ID,
      state: 'todo',
    });

    expect(result).toEqual({ ok: true, removed: true, folder: 'Todo' });
    expect(imap.removeMessageCopy).toHaveBeenCalledWith('a1', 42, 'Todo');
  });
});

describe('gtdDone', () => {
  it('keeps strip-success/archive-failure as a 200-shaped partial success', async () => {
    const watchMsg = { ...msg, folder: 'Watch' };
    const inboxCopy = { id: 'inbox-id', uid: 77, is_read: true };
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: [watchMsg] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: [inboxCopy] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
      return { rows: [] };
    });
    archiveInboxCopy.mockRejectedValue(new Error('archive failed'));
    const imap = manager();

    const result = await gtdDone(imap, {
      userId: 'u1',
      accountIds: null,
      id: ID,
      states: ['watch'],
    });

    expect(result).toEqual({
      ok: true,
      removed: ['Watch'],
      archived: false,
      noArchiveFolder: false,
      archiveFailed: true,
    });
    expect(imap.removeMessageCopy).toHaveBeenCalled();
    expect(imap.broadcast).toHaveBeenCalledWith(
      { type: 'gtd_sections_updated', accountId: 'a1' },
      'u1',
    );
  });
});
