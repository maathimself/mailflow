import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adjustFolderCounts: vi.fn(),
    fanOutReadToSiblings: vi.fn(),
    fanOutStarToSiblings: vi.fn(),
    fanOutBulkReadToSiblings: vi.fn(),
  };
});
vi.mock('../gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));

import { query } from '../db.js';
import {
  fanOutBulkReadToSiblings,
  fanOutReadToSiblings,
  fanOutStarToSiblings,
} from '../../utils/mailUtils.js';
import { bulkSetRead, setRead, setStarred } from './flags.js';

const ID = '11111111-1111-4111-8111-111111111111';
const message = {
  id: ID,
  account_id: 'a1',
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@example.test>',
  is_read: false,
  is_starred: false,
  sibling_count: 2,
  gtd_enabled: true,
};
const account = { id: 'a1', gtd_enabled: true };

function manager() {
  return {
    setFlag: vi.fn().mockResolvedValue(undefined),
    _resolveFlagPush: vi.fn(),
    _enqueueFlagPush: vi.fn(),
    broadcast: vi.fn(),
  };
}

beforeEach(() => {
  query.mockReset();
  fanOutReadToSiblings.mockReset();
  fanOutStarToSiblings.mockReset();
  fanOutBulkReadToSiblings.mockReset();
});

describe('setRead', () => {
  it('preserves the single-message read receipt and IMAP flag write', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager();

    const result = await setRead(imap, {
      userId: 'u1',
      accountIds: null,
      id: ID,
      read: true,
    });

    expect(result).toEqual({ ok: true, is_read: true });
    expect(imap.setFlag).toHaveBeenCalledWith(account, 10, 'INBOX', '\\Seen', true);
    expect(fanOutReadToSiblings).toHaveBeenCalledWith('a1', '<m@example.test>', true);
  });

  it('narrows ownership to accountIds before DB mutation or IMAP work', async () => {
    query.mockResolvedValue({ rows: [] });
    const imap = manager();

    const result = await setRead(imap, {
      userId: 'u1',
      accountIds: ['a1'],
      id: ID,
      read: true,
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Message not found' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = ANY($3::uuid[])');
    expect(params).toEqual([ID, 'u1', ['a1']]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(imap.setFlag).not.toHaveBeenCalled();
  });
});

describe('setStarred', () => {
  it('preserves the star receipt and GTD sibling fan-out', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager();

    const result = await setStarred(imap, {
      userId: 'u1',
      accountIds: null,
      id: ID,
      starred: true,
    });

    expect(result).toEqual({ ok: true, is_starred: true, updated: true });
    expect(imap.setFlag).toHaveBeenCalledWith(account, 10, 'INBOX', '\\Flagged', true);
    expect(fanOutStarToSiblings).toHaveBeenCalledWith('a1', '<m@example.test>', true);
  });

  it('reports an already-targeted star state as a no-op', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id')) {
        return { rows: [{ ...message, is_starred: true }] };
      }
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });

    const result = await setStarred(manager(), {
      userId: 'u1',
      accountIds: null,
      id: ID,
      starred: true,
    });

    expect(result).toEqual({ ok: true, is_starred: true, updated: false });
  });
});

describe('bulkSetRead', () => {
  it('returns only ids whose read state changes', async () => {
    const alreadyRead = { ...message, id: '22222222-2222-4222-8222-222222222222', is_read: true };
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.id, m.uid')) return { rows: [message, alreadyRead] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    const imap = manager();

    const result = await bulkSetRead(imap, {
      userId: 'u1',
      accountIds: null,
      ids: [ID, alreadyRead.id],
      read: true,
    });

    expect(result).toEqual({ ok: true, updated: [ID] });
    expect(imap.setFlag).toHaveBeenCalledTimes(1);
    expect(fanOutBulkReadToSiblings).toHaveBeenCalledWith([ID], true);
  });
});
