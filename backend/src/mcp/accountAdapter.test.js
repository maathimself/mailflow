import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));

import { query } from '../services/db.js';
import {
  deleteMessageRow,
  getAccountByEmail,
  getAccountRow,
  getComposeSource,
  getDraftRow,
  getOutboxRowByMessageId,
  getUserPreferences,
  listAliases,
  listDraftRows,
  resolveAlias,
} from './accountAdapter.js';

describe('outbox row lookups', () => {
  beforeEach(() => query.mockReset());

  it('finds a pending outbox row by message id within the caller user scope', async () => {
    const row = {
      id: 'outbox-1',
      user_id: 'user-1',
      message_id: '<queued@example.com>',
      status: 'pending',
    };
    query.mockResolvedValueOnce({ rows: [row] });

    await expect(
      getOutboxRowByMessageId('<queued@example.com>', 'user-1'),
    ).resolves.toBe(row);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/message_id = \$1/);
    expect(sql).toMatch(/user_id = \$2/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(params).toEqual(['<queued@example.com>', 'user-1']);
  });

  it('returns null when no pending row matches that message and user', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      getOutboxRowByMessageId('<missing@example.com>', 'user-1'),
    ).resolves.toBeNull();
  });
});

describe('deleteMessageRow', () => {
  beforeEach(() => query.mockReset());

  it('uses the same account/uid/folder delete tuple as draftService', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(
      deleteMessageRow('account-1', 42, 'Sent'),
    ).resolves.toBe(1);
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
      ['account-1', 42, 'Sent'],
    );
  });
});

describe('getAccountRow', () => {
  beforeEach(() => query.mockReset());

  it('returns a full account row only when its id is in the caller account scope', async () => {
    const row = {
      id: 'acc-1',
      email_address: 'owner@example.com',
      smtp_host: 'smtp.example.com',
      auth_pass: 'encrypted-secret',
    };
    query.mockResolvedValueOnce({ rows: [row] });

    await expect(getAccountRow('acc-1', ['acc-1', 'acc-2'])).resolves.toBe(row);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT \* FROM email_accounts/);
    expect(sql).toMatch(/id = \$1 AND id = ANY\(\$2\)/);
    expect(params).toEqual(['acc-1', ['acc-1', 'acc-2']]);
  });

  it('returns null for an out-of-scope account without querying', async () => {
    await expect(getAccountRow('acc-foreign', ['acc-1'])).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('getAccountByEmail', () => {
  beforeEach(() => query.mockReset());

  it('returns the account row matched by email within the caller account scope', async () => {
    const row = { id: 'acc-2', email_address: 'owner@example.com', auth_pass: 'secret' };
    query.mockResolvedValueOnce({ rows: [row] });

    await expect(getAccountByEmail('owner@example.com', ['acc-1', 'acc-2'])).resolves.toBe(row);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/email_address = \$1/);
    expect(sql).toMatch(/id = ANY\(\$2\)/);
    expect(params).toEqual(['owner@example.com', ['acc-1', 'acc-2']]);
  });

  it('returns account_not_found on a scoped lookup miss', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(getAccountByEmail('missing@example.com', ['acc-1'])).resolves.toEqual({
      error: 'account_not_found: missing@example.com',
    });
  });

  it('returns account_not_found for an empty account scope without querying', async () => {
    await expect(getAccountByEmail('owner@example.com', [])).resolves.toEqual({
      error: 'account_not_found: owner@example.com',
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('alias lookups', () => {
  beforeEach(() => query.mockReset());

  it('lists aliases only for the supplied scoped account id', async () => {
    const rows = [{ id: 'alias-1', account_id: 'acc-1', email: 'alias@example.com' }];
    query.mockResolvedValueOnce({ rows });

    await expect(listAliases('acc-1')).resolves.toBe(rows);
    expect(query.mock.calls[0][0]).toMatch(/account_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['acc-1']);
  });

  it('resolves an alias email only within the supplied scoped account id', async () => {
    const alias = { id: 'alias-1', account_id: 'acc-1', email: 'Alias@Example.com' };
    query.mockResolvedValueOnce({ rows: [alias] });

    await expect(resolveAlias('acc-1', 'alias@example.com')).resolves.toBe(alias);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/account_id = \$1/);
    expect(sql).toMatch(/LOWER\(email\) = LOWER\(\$2\)/);
    expect(params).toEqual(['acc-1', 'alias@example.com']);
  });

  it('returns null when the alias email is not configured on that account', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(resolveAlias('acc-1', 'missing@example.com')).resolves.toBeNull();
  });
});

describe('getComposeSource', () => {
  beforeEach(() => query.mockReset());

  it('returns a compose source selected through the caller account scope', async () => {
    const row = {
      id: 'message-1',
      account_id: 'acc-1',
      uid: 42,
      folder: 'INBOX',
      message_id: '<message@example.com>',
      reply_to: [{ email: 'reply@example.com' }],
      in_reply_to: '<parent@example.com>',
      thread_references: '<root@example.com> <parent@example.com>',
      body_text: 'Hello',
      body_html: '<p>Hello</p>',
    };
    query.mockResolvedValueOnce({ rows: [row] });

    await expect(getComposeSource('message-1', ['acc-1'])).resolves.toBe(row);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/m\.account_id = ANY\(\$2\)/);
    for (const column of ['uid', 'reply_to', 'in_reply_to', 'thread_references', 'body_text', 'body_html']) {
      expect(sql).toContain(`m.${column}`);
    }
    expect(params).toEqual(['message-1', ['acc-1']]);
  });

  it('returns null when the message is outside the caller account scope', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(getComposeSource('message-foreign', ['acc-1'])).resolves.toBeNull();
  });

  it('returns null for an empty account scope without querying', async () => {
    await expect(getComposeSource('message-1', [])).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('draft row lookups', () => {
  beforeEach(() => query.mockReset());

  it('lists live draft rows only for the supplied scoped account and folder', async () => {
    const rows = [{ account_id: 'acc-1', folder: 'Drafts', uid: 7 }];
    query.mockResolvedValueOnce({ rows });

    await expect(listDraftRows('acc-1', {
      limit: 20,
      offset: 5,
      folder: 'Drafts',
    })).resolves.toBe(rows);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/account_id = \$1/);
    expect(sql).toMatch(/folder = \$2/);
    expect(sql).toMatch(/is_deleted = false/);
    expect(sql).toMatch(/LIMIT \$3 OFFSET \$4/);
    expect(params).toEqual(['acc-1', 'Drafts', 20, 5]);
  });

  it('lists live draft rows for a scoped account without widening through a folder predicate', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await listDraftRows('acc-1', { limit: 10, offset: 0 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/account_id = \$1/);
    expect(sql).not.toMatch(/folder = \$2/);
    expect(params).toEqual(['acc-1', 10, 0]);
  });

  it('gets a draft row by scoped account, folder, and uid', async () => {
    const row = { account_id: 'acc-1', folder: 'Drafts', uid: 7 };
    query.mockResolvedValueOnce({ rows: [row] });

    await expect(getDraftRow('acc-1', 'Drafts', 7)).resolves.toBe(row);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/account_id = \$1 AND folder = \$2 AND uid = \$3/);
    expect(sql).toMatch(/is_deleted = false/);
    expect(params).toEqual(['acc-1', 'Drafts', 7]);
  });

  it('returns null when a draft lookup misses its scoped account/folder/uid tuple', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(getDraftRow('acc-1', 'Drafts', 999)).resolves.toBeNull();
  });
});

describe('getUserPreferences', () => {
  beforeEach(() => query.mockReset());

  it('returns preferences only for the supplied user id', async () => {
    const preferences = { plaintextEmail: true, undoSendSeconds: 30 };
    query.mockResolvedValueOnce({ rows: [{ preferences }] });

    await expect(getUserPreferences('user-1')).resolves.toBe(preferences);
    expect(query.mock.calls[0]).toEqual([
      'SELECT preferences FROM users WHERE id = $1',
      ['user-1'],
    ]);
  });

  it('returns an empty object when the scoped user row is absent', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(getUserPreferences('user-missing')).resolves.toEqual({});
  });
});
