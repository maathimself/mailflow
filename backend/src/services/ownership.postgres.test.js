import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

// The ownership lookups against real PostgreSQL: the owner gets the row, another user gets
// nothing, and each optional filter narrows as its name says. Temporary tables only.
const database = vi.hoisted(() => ({ client: null }));
vi.mock('./db.js', () => ({ query: (text, params) => database.client.query(text, params) }));

import {
  findOwnedAccount, findOwnedMessage, findOwnedMessages, findOwnedAlias, findOwnedContact, findOwnedAddressBook,
  findOwnedScheduledMessage,
} from './ownership.js';
import { getOwnedAccount, loadOwnedMessage } from './mailAccess.js';

const OWNER = 'owner';
const OTHER = 'other';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const DISABLED_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const OTHER_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const MESSAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DELETED_MESSAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DISABLED_MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MESSAGE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ALIAS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BOOK = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const SCHEDULED = '55555555-5555-4555-8555-555555555555';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('ownership lookups PostgreSQL', () => {
  beforeAll(async () => {
    database.client = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.client.connect();
    await database.client.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean,
        protocol text, email_address text, folder_mappings jsonb);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, subject text,
        is_deleted boolean DEFAULT false);
      CREATE TEMP TABLE account_aliases (id uuid PRIMARY KEY, account_id uuid, email text);
      CREATE TEMP TABLE address_books (id uuid PRIMARY KEY, user_id text, source text);
      CREATE TEMP TABLE contacts (id uuid PRIMARY KEY, user_id text, address_book_id uuid,
        display_name text);
      CREATE TEMP TABLE scheduled_messages (id uuid PRIMARY KEY, user_id text, status text)`);
    await database.client.query(`
      INSERT INTO email_accounts VALUES
        ('${ACCOUNT}', '${OWNER}', true, 'imap', 'me@example.com', '{"archive":"Archive"}'),
        ('${DISABLED_ACCOUNT}', '${OWNER}', false, 'imap', 'old@example.com', NULL),
        ('${OTHER_ACCOUNT}', '${OTHER}', true, 'imap', 'them@example.com', NULL);
      INSERT INTO messages VALUES
        ('${MESSAGE}', '${ACCOUNT}', 'Hello', false),
        ('${DELETED_MESSAGE}', '${ACCOUNT}', 'Gone', true),
        ('${DISABLED_MESSAGE}', '${DISABLED_ACCOUNT}', 'Old', false),
        ('${OTHER_MESSAGE}', '${OTHER_ACCOUNT}', 'Theirs', false);
      INSERT INTO account_aliases VALUES ('${ALIAS}', '${ACCOUNT}', 'alias@example.com');
      INSERT INTO address_books VALUES ('${BOOK}', '${OWNER}', 'local');
      INSERT INTO contacts VALUES ('${CONTACT}', '${OWNER}', '${BOOK}', 'Ann');
      INSERT INTO scheduled_messages VALUES ('${SCHEDULED}', '${OWNER}', 'scheduled')`);
  });
  afterAll(async () => { await database.client?.end(); });

  it('finds an account for its owner only', async () => {
    expect(await findOwnedAccount(OWNER, ACCOUNT)).toMatchObject({ id: ACCOUNT, email_address: 'me@example.com' });
    expect(await findOwnedAccount(OTHER, ACCOUNT)).toBeNull();
    expect(await findOwnedAccount(OWNER, OTHER_ACCOUNT)).toBeNull();
  });

  it('selects only the requested account columns', async () => {
    expect(await findOwnedAccount(OWNER, ACCOUNT, { columns: 'id, folder_mappings' }))
      .toEqual({ id: ACCOUNT, folder_mappings: { archive: 'Archive' } });
  });

  it('narrows an account by enabled and protocol', async () => {
    expect(await findOwnedAccount(OWNER, DISABLED_ACCOUNT, { enabled: true })).toBeNull();
    expect(await findOwnedAccount(OWNER, DISABLED_ACCOUNT)).not.toBeNull();
    expect(await findOwnedAccount(OWNER, ACCOUNT, { enabled: true, protocol: 'imap' })).not.toBeNull();
    expect(await findOwnedAccount(OWNER, ACCOUNT, { protocol: 'pop3' })).toBeNull();
  });

  it('runs on the transaction client it is given', async () => {
    const client = { query: vi.fn((text, params) => database.client.query(text, params)) };
    expect(await findOwnedAccount(OWNER, ACCOUNT, { columns: 'id', client })).toEqual({ id: ACCOUNT });
    expect(await findOwnedMessage(OWNER, MESSAGE, { columns: 'm.id', client })).toEqual({ id: MESSAGE });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('finds a message for its owner only, with account columns on request', async () => {
    expect(await findOwnedMessage(OWNER, MESSAGE)).toMatchObject({ id: MESSAGE, subject: 'Hello' });
    expect(await findOwnedMessage(OTHER, MESSAGE)).toBeNull();
    expect(await findOwnedMessage(OWNER, OTHER_MESSAGE)).toBeNull();
    expect(await findOwnedMessage(OWNER, MESSAGE, { columns: 'm.subject, a.user_id, a.folder_mappings' }))
      .toEqual({ subject: 'Hello', user_id: OWNER, folder_mappings: { archive: 'Archive' } });
  });

  it('skips deleted messages and disabled accounts only when asked', async () => {
    expect(await findOwnedMessage(OWNER, DELETED_MESSAGE)).not.toBeNull();
    expect(await findOwnedMessage(OWNER, DELETED_MESSAGE, { live: true })).toBeNull();
    expect(await findOwnedMessage(OWNER, DISABLED_MESSAGE)).not.toBeNull();
    expect(await findOwnedMessage(OWNER, DISABLED_MESSAGE, { enabledAccount: true })).toBeNull();
  });

  it('keeps only the owned messages of a list', async () => {
    const rows = await findOwnedMessages(OWNER, [MESSAGE, DELETED_MESSAGE, OTHER_MESSAGE], { columns: 'm.id' });
    expect(rows.map(r => r.id).sort()).toEqual([MESSAGE, DELETED_MESSAGE].sort());
    expect(await findOwnedMessages(OTHER, [MESSAGE])).toEqual([]);
    expect((await findOwnedMessages(OWNER, [MESSAGE, DELETED_MESSAGE], { live: true })).map(r => r.id)).toEqual([MESSAGE]);
  });

  it('finds an alias only through its own account and owner', async () => {
    expect(await findOwnedAlias(OWNER, ACCOUNT, ALIAS)).toEqual({ id: ALIAS, account_id: ACCOUNT });
    expect(await findOwnedAlias(OTHER, ACCOUNT, ALIAS)).toBeNull();
    expect(await findOwnedAlias(OWNER, DISABLED_ACCOUNT, ALIAS)).toBeNull();
  });

  it('finds a scheduled message for its owner only, locked inside a transaction when asked', async () => {
    expect(await findOwnedScheduledMessage(OWNER, SCHEDULED, { columns: 'status' })).toEqual({ status: 'scheduled' });
    expect(await findOwnedScheduledMessage(OTHER, SCHEDULED)).toBeNull();
    await database.client.query('BEGIN');
    try {
      expect(await findOwnedScheduledMessage(OWNER, SCHEDULED, { columns: 'id', forUpdate: true })).toEqual({ id: SCHEDULED });
      const { rows } = await database.client.query(
        "SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'transactionid' AND mode = 'ExclusiveLock'");
      expect(rows).toHaveLength(1);
    } finally {
      await database.client.query('ROLLBACK');
    }
  });

  it('finds contacts and address books for their owner only', async () => {
    expect(await findOwnedContact(OWNER, CONTACT, { columns: 'c.display_name, ab.source' }))
      .toEqual({ display_name: 'Ann', source: 'local' });
    expect(await findOwnedContact(OTHER, CONTACT)).toBeNull();
    expect(await findOwnedAddressBook(OWNER, BOOK, { columns: 'id' })).toEqual({ id: BOOK });
    expect(await findOwnedAddressBook(OTHER, BOOK)).toBeNull();
  });

  it('backs the plugin API lookups with the same scoping', async () => {
    expect(await getOwnedAccount(OWNER, ACCOUNT)).toMatchObject({ id: ACCOUNT });
    expect(await getOwnedAccount(OTHER, ACCOUNT)).toBeNull();
    expect(await loadOwnedMessage(OWNER, MESSAGE)).toMatchObject({ id: MESSAGE, account_id: ACCOUNT });
    expect(await loadOwnedMessage(OTHER, MESSAGE)).toBeNull();
  });

  it('ignores options a plugin passes to the plugin API lookups', async () => {
    expect(await getOwnedAccount(OWNER, ACCOUNT, { columns: 'id' })).toHaveProperty('email_address');
    expect(await loadOwnedMessage(OWNER, MESSAGE, { columns: 'm.id' })).toHaveProperty('subject');
  });
});
