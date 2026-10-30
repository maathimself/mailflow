import { beforeEach, describe, expect, it, vi } from 'vitest';

// The ownership lookups' SQL contract, for runs without PostgreSQL (ownership.postgres.test.js
// runs the same lookups against a real database): every lookup binds the user into its user_id
// condition, and a miss comes back as null.
vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import {
  findOwnedAccount, findOwnedMessage, findOwnedMessages, findOwnedAlias, findOwnedContact, findOwnedAddressBook,
  findOwnedScheduledMessage, checkColumns, SIBLING_COUNT, CONTACT_READ_ONLY,
} from './ownership.js';

const flat = sql => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [] });
});

describe('ownership lookups', () => {
  it('scopes an account by id and user', async () => {
    query.mockResolvedValue({ rows: [{ id: 'acc' }] });
    expect(await findOwnedAccount('u1', 'acc')).toEqual({ id: 'acc' });
    expect(query).toHaveBeenCalledWith('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', ['acc', 'u1']);
  });

  it('adds the account filters it is asked for', async () => {
    await findOwnedAccount('u1', 'acc', { columns: 'id', enabled: true, protocol: 'imap' });
    expect(query).toHaveBeenCalledWith(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND protocol = $3',
      ['acc', 'u1', 'imap']
    );
  });

  it('scopes a message through its account', async () => {
    expect(await findOwnedMessage('u1', 'msg', { columns: 'm.id, a.user_id', live: true, enabledAccount: true })).toBeNull();
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toBe('SELECT m.id, a.user_id FROM messages m JOIN email_accounts a ON m.account_id = a.id WHERE m.id = $1 AND a.user_id = $2 AND a.enabled = true AND m.is_deleted = false');
    expect(params).toEqual(['msg', 'u1']);
  });

  it('scopes a list of messages through their accounts', async () => {
    query.mockResolvedValue({ rows: [{ id: 'm1' }] });
    expect(await findOwnedMessages('u1', ['m1', 'm2'], { columns: 'm.id' })).toEqual([{ id: 'm1' }]);
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toBe('SELECT m.id FROM messages m JOIN email_accounts a ON m.account_id = a.id WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1');
    expect(params).toEqual(['u1', ['m1', 'm2']]);
  });

  it('scopes an alias by its account and the account owner', async () => {
    await findOwnedAlias('u1', 'acc', 'alias');
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain('WHERE a.id = $1 AND e.user_id = $2 AND e.id = $3');
    expect(params).toEqual(['alias', 'u1', 'acc']);
  });

  it('scopes contacts and address books by user', async () => {
    await findOwnedContact('u1', 'c1', { columns: 'ab.source' });
    await findOwnedAddressBook('u1', 'b1', { columns: 'id' });
    expect(flat(query.mock.calls[0][0])).toBe('SELECT ab.source FROM contacts c JOIN address_books ab ON ab.id = c.address_book_id WHERE c.id = $1 AND c.user_id = $2');
    expect(query.mock.calls[0][1]).toEqual(['c1', 'u1']);
    expect(query.mock.calls[1]).toEqual(['SELECT id FROM address_books WHERE id = $1 AND user_id = $2', ['b1', 'u1']]);
  });

  it('scopes a scheduled message by user, and locks it when asked', async () => {
    await findOwnedScheduledMessage('u1', 's1', { columns: 'id, status' });
    await findOwnedScheduledMessage('u1', 's1', { forUpdate: true });
    expect(query.mock.calls[0]).toEqual(['SELECT id, status FROM scheduled_messages WHERE id = $1 AND user_id = $2', ['s1', 'u1']]);
    expect(query.mock.calls[1]).toEqual(['SELECT * FROM scheduled_messages WHERE id = $1 AND user_id = $2 FOR UPDATE', ['s1', 'u1']]);
    await expect(findOwnedScheduledMessage('u1', 's1', { columns: 'id; DROP TABLE users' })).rejects.toThrow(TypeError);
  });

  it('runs on a transaction client instead of the pool when given one', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'acc' }] }) };
    expect(await findOwnedAccount('u1', 'acc', { columns: 'id', client })).toEqual({ id: 'acc' });
    expect(client.query).toHaveBeenCalledWith('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', ['acc', 'u1']);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the columns a lookup selects', () => {
  it('takes plain column lists and the named computed columns', () => {
    for (const ok of ['*', 'id', 'm.*', 'id, folder_mappings', 'm.*, a.user_id AS owner_id, a.folder_mappings',
      `m.id,\n       m.uid, a.name AS account_name`, `m.*, a.user_id, ${SIBLING_COUNT}`, `c.id, c.uid, ${CONTACT_READ_ONLY}`]) {
      expect(checkColumns(ok)).toBe(ok);
    }
  });

  it('refuses anything that is not a column list, before any query', async () => {
    for (const bad of ['', ' ', 'id; DROP TABLE users', 'id FROM users --', '(SELECT password_hash FROM users)',
      'id, (SELECT 1)', '1', "id || 'x'", 'id AS from', 'a.id AS x y', 'id /* */', 'a.b.c', 'CASE WHEN 1 THEN 2 END AS x',
      `${SIBLING_COUNT} OR 1=1`, 'select', null, ['id']]) {
      expect(() => checkColumns(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
    await expect(findOwnedAccount('u1', 'acc', { columns: 'id FROM users WHERE 1=1 --' })).rejects.toThrow(TypeError);
    await expect(findOwnedMessage('u1', 'm1', { columns: '(SELECT password_hash FROM users LIMIT 1) AS x' })).rejects.toThrow(TypeError);
    await expect(findOwnedMessages('u1', ['m1'], { columns: 'm.id; DELETE FROM messages' })).rejects.toThrow(TypeError);
    await expect(findOwnedContact('u1', 'c1', { columns: 'c.*, (SELECT 1) AS y' })).rejects.toThrow(TypeError);
    await expect(findOwnedAddressBook('u1', 'b1', { columns: 'id UNION SELECT 1' })).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses niladic functions that read like bare column names', () => {
    for (const bad of ['current_user', 'session_user', 'user', 'id, current_schema', 'a.id AS current_user', 'id, localtimestamp']) {
      expect(() => checkColumns(bad), bad).toThrow(TypeError);
    }
  });
});
