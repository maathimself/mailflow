import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

// The ownership lookups whose filters and columns decide more than who owns the row, run through
// the real routes against PostgreSQL: a CardDAV contact stays read-only, a deleted message or one
// in a disabled account is not served, and only an enabled IMAP account is reindexed. Temporary
// tables only.
const database = vi.hoisted(() => ({ client: null }));
const session = vi.hoisted(() => ({ userId: 'owner' }));
const imap = vi.hoisted(() => ({
  broadcast: vi.fn(),
  copyMessage: vi.fn(async () => 31),
  backfillAllRunning: new Set(),
  backfillAllFolders: vi.fn(async () => {}),
}));
vi.mock('../services/db.js', () => ({ query: (text, params) => database.client.query(text, params) }));
vi.mock('../middleware/auth.js', () => {
  const signIn = (req, _res, next) => { req.session = { userId: session.userId }; next(); };
  return { requireAuth: signIn, requireAdmin: signIn };
});
vi.mock('../index.js', () => ({ imapManager: imap }));
vi.mock('../services/aiAccess.js', () => ({ getUserAiAccess: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../services/categorizer.js', () => ({
  invalidateSocialDomainCache: vi.fn(), backfillCategories: vi.fn(async () => {}),
  aiClassifyMessage: vi.fn(async () => 'newsletter'), BUILTIN_SETS: {},
}));

import express from 'express';
import mailRoutes from './mail.js';
import accountRoutes from './accounts.js';
import categoriesRoutes from './categories.js';
import contactsRoutes from './contacts.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const DISABLED_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const POP_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const LIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DELETED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IN_DISABLED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOCAL_BOOK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SYNCED_BOOK = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LOCAL_CONTACT = '44444444-4444-4444-8444-444444444444';
const SYNCED_CONTACT = '55555555-5555-4555-8555-555555555555';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('ownership lookups through the routes on PostgreSQL', () => {
  let server, base;
  beforeAll(async () => {
    database.client = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.client.connect();
    await database.client.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean, protocol text,
        name text, email_address text, color text, folder_mappings jsonb);
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, special_use text, no_select boolean DEFAULT false);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, uid bigint, folder text, message_id text,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb, reply_to jsonb,
        in_reply_to text, thread_references text, date timestamptz, snippet text, is_read boolean DEFAULT false,
        is_starred boolean DEFAULT false, has_attachments boolean DEFAULT false, category text,
        list_unsubscribe text, list_unsubscribe_post text, unsubscribed_at timestamptz, delivery_addresses jsonb,
        spam_verdict text, spam_user_override text, spam_score_ml real, is_deleted boolean DEFAULT false);
      CREATE TEMP TABLE address_books (id uuid PRIMARY KEY, user_id text, source text, sync_token text, updated_at timestamptz);
      CREATE TEMP TABLE contacts (id uuid PRIMARY KEY, user_id text, address_book_id uuid, uid text,
        display_name text, first_name text, last_name text, primary_email text, emails jsonb, phones jsonb,
        organization text, notes text, photo_data text, is_auto boolean DEFAULT false, send_count int DEFAULT 0,
        last_sent timestamptz, etag text, vcard text, created_at timestamptz DEFAULT NOW(), updated_at timestamptz)`);
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    app.use('/api/accounts', accountRoutes);
    app.use('/api/contacts', contactsRoutes);
    app.use('/api', categoriesRoutes);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterAll(async () => {
    await new Promise(r => server?.close(r));
    await database.client?.end();
  });
  beforeEach(async () => {
    session.userId = 'owner';
    imap.copyMessage.mockClear();
    imap.backfillAllFolders.mockClear();
    await database.client.query(`
      TRUNCATE email_accounts, folders, messages, address_books, contacts;
      INSERT INTO email_accounts (id, user_id, enabled, protocol, name, folder_mappings) VALUES
        ('${ACCOUNT}', 'owner', true, 'imap', 'Mine', '{}'),
        ('${DISABLED_ACCOUNT}', 'owner', false, 'imap', 'Old', '{}'),
        ('${POP_ACCOUNT}', 'owner', true, 'pop3', 'Pop', '{}');
      INSERT INTO folders (account_id, path, name) VALUES ('${ACCOUNT}', 'Label', 'Label'), ('${DISABLED_ACCOUNT}', 'Label', 'Label');
      INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_email, snippet, is_deleted) VALUES
        ('${LIVE}', '${ACCOUNT}', 1, 'INBOX', '<1@x>', 'Live', 'a@example.com', 'hi', false),
        ('${DELETED}', '${ACCOUNT}', 2, 'INBOX', '<2@x>', 'Gone', 'a@example.com', 'hi', true),
        ('${IN_DISABLED}', '${DISABLED_ACCOUNT}', 3, 'INBOX', '<3@x>', 'Old', 'a@example.com', 'hi', false);
      INSERT INTO address_books (id, user_id, source) VALUES ('${LOCAL_BOOK}', 'owner', 'local'), ('${SYNCED_BOOK}', 'owner', 'carddav');
      INSERT INTO contacts (id, user_id, address_book_id, uid, display_name, emails, phones) VALUES
        ('${LOCAL_CONTACT}', 'owner', '${LOCAL_BOOK}', 'l1', 'Local', '[]', '[]'),
        ('${SYNCED_CONTACT}', 'owner', '${SYNCED_BOOK}', 's1', 'Synced', '[]', '[]')`);
  });

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const notFound = { status: 404, json: { error: 'Message not found' } };
  const readOnly = { status: 403, json: { error: 'This contact is synced from CardDAV and is read-only' } };

  it('serves a message, but not a deleted one', async () => {
    expect((await call('GET', `/mail/messages/${LIVE}`)).json).toMatchObject({ id: LIVE, subject: 'Live', account_name: 'Mine' });
    expect(await call('GET', `/mail/messages/${DELETED}`)).toEqual(notFound);
  });

  it('copies a live message of an enabled account only', async () => {
    expect(await call('POST', `/mail/messages/${LIVE}/copy`, { folder: 'Label' })).toEqual({ status: 200, json: { ok: true, uid: 31 } });
    expect(await call('POST', `/mail/messages/${DELETED}/copy`, { folder: 'Label' })).toEqual(notFound);
    expect(await call('POST', `/mail/messages/${IN_DISABLED}/copy`, { folder: 'Label' })).toEqual(notFound);
    expect(imap.copyMessage).toHaveBeenCalledTimes(1);
  });

  it('does not unsubscribe from or classify a deleted message', async () => {
    expect(await call('POST', `/mail/messages/${LIVE}/unsubscribe`)).toEqual({ status: 400, json: { error: 'No unsubscribe header' } });
    expect(await call('POST', `/mail/messages/${DELETED}/unsubscribe`)).toEqual(notFound);
    expect(await call('POST', `/categories/ai-classify/${LIVE}`)).toEqual({ status: 200, json: { ok: true, category: 'newsletter' } });
    expect(await call('POST', `/categories/ai-classify/${DELETED}`)).toEqual(notFound);
  });

  it('reindexes an enabled IMAP account only', async () => {
    expect(await call('POST', `/accounts/${ACCOUNT}/reindex`)).toEqual({ status: 200, json: { ok: true, alreadyRunning: false } });
    for (const id of [DISABLED_ACCOUNT, POP_ACCOUNT]) {
      expect(await call('POST', `/accounts/${id}/reindex`)).toEqual({ status: 404, json: { error: 'Account not found' } });
    }
    expect(imap.backfillAllFolders).toHaveBeenCalledTimes(1);
  });

  it('keeps a CardDAV contact read-only and lets a local one be edited and deleted', async () => {
    expect((await call('GET', `/contacts/${SYNCED_CONTACT}`)).json).toMatchObject({ display_name: 'Synced', read_only: true });
    expect((await call('GET', `/contacts/${LOCAL_CONTACT}`)).json).toMatchObject({ display_name: 'Local', read_only: false });
    expect(await call('PATCH', `/contacts/${SYNCED_CONTACT}`, { displayName: 'Changed' })).toEqual(readOnly);
    expect(await call('DELETE', `/contacts/${SYNCED_CONTACT}`)).toEqual(readOnly);
    const { rows: [synced] } = await database.client.query('SELECT display_name FROM contacts WHERE id = $1', [SYNCED_CONTACT]);
    expect(synced).toEqual({ display_name: 'Synced' });

    expect(await call('PATCH', `/contacts/${LOCAL_CONTACT}`, { displayName: 'Changed' })).toMatchObject({ status: 200, json: { display_name: 'Changed' } });
    expect(await call('DELETE', `/contacts/${LOCAL_CONTACT}`)).toEqual({ status: 200, json: { ok: true } });
  });

  it('refuses all of it to another user', async () => {
    session.userId = 'stranger';
    expect(await call('GET', `/mail/messages/${LIVE}`)).toEqual(notFound);
    expect(await call('POST', `/mail/messages/${LIVE}/copy`, { folder: 'Label' })).toEqual(notFound);
    expect(await call('POST', `/accounts/${ACCOUNT}/reindex`)).toEqual({ status: 404, json: { error: 'Account not found' } });
    expect(await call('PATCH', `/contacts/${LOCAL_CONTACT}`, { displayName: 'Mine now' })).toEqual({ status: 404, json: { error: 'Contact not found' } });
    expect(await call('DELETE', `/contacts/${LOCAL_CONTACT}`)).toEqual({ status: 404, json: { error: 'Contact not found' } });
  });
});
