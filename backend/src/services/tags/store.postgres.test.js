import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

vi.mock('../db.js', () => ({ query: vi.fn() }));
import { query } from '../db.js';
import * as store from './store.js';

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../migrations/0077_tags.sql'), 'utf8');
const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const A1 = '00000000-0000-4000-8000-0000000000a1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const M1 = '00000000-0000-4000-8000-0000000000b1';
const M2 = '00000000-0000-4000-8000-0000000000b2';

// Runs the real migration and the store's SQL in a throwaway schema of an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('tags store (PostgreSQL)', () => {
  let db;
  const schema = `tags_test_${process.pid}`;
  const namesOf = async (userId, id) => ((await store.tagsForMessages(userId, [id]))[id] || []).map((t) => t.name);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public`);
    await db.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id));
      CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES email_accounts(id), folder text, uid bigint,
        message_id text, UNIQUE (account_id, uid, folder));
      INSERT INTO users VALUES ('${U1}'), ('${U2}');
      INSERT INTO email_accounts VALUES ('${A1}', '${U1}'), ('${A2}', '${U2}');
      INSERT INTO messages (id, account_id, folder, uid, message_id) VALUES
        ('${M1}', '${A1}', 'INBOX', 1, '<m1@x.example>'),
        ('${M2}', '${A2}', 'INBOX', 1, '<m2@x.example>')`);
    await db.query(migration);
    await db.query(migration); // idempotent: the runner may replay it
    query.mockImplementation((sql, params) => db.query(sql, params));
  });
  afterAll(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.end();
  });

  it('creates, edits and deletes definitions, scoped to the user, with unique names per user', async () => {
    const a = await store.createDefinition(U1, { name: 'Urgent', color: '#ef4444' });
    const b = await store.createDefinition(U1, { name: 'Travel' });
    expect(b.color).toBe('#6b7280');
    expect((await store.listDefinitions(U1)).map((d) => d.name)).toEqual(['Urgent', 'Travel']);
    expect(await store.listDefinitions(U2)).toEqual([]);
    expect(await store.createDefinition(U1, { name: 'URGENT' })).toBeNull(); // same name, other case
    expect(await store.createDefinition(U2, { name: 'Urgent' })).toMatchObject({ name: 'Urgent' }); // another user's own
    expect(await store.updateDefinition(U1, b.id, { name: 'Trips', color: '#00aa00' })).toMatchObject({ name: 'Trips', color: '#00aa00' });
    expect(await store.updateDefinition(U1, b.id, { name: 'urgent' })).toBe('duplicate');
    expect(await store.updateDefinition(U2, b.id, { name: 'hijack' })).toBeNull();
    expect(await store.updateDefinition(U1, b.id, {})).toBeNull();
    expect(await store.deleteDefinition(U2, b.id)).toBe(false);
    expect(await store.deleteDefinition(U1, b.id)).toBe(true);
    expect(a.name).toBe('Urgent');
  });

  it('adds and removes a tag by hand, and reads are scoped to the owner', async () => {
    const urgent = (await store.listDefinitions(U1)).find((d) => d.name === 'Urgent');
    const others = (await store.listDefinitions(U2))[0];
    expect(await store.setManualTag(U1, M1, urgent.id, true)).toBe(true);
    expect(await store.setManualTag(U1, M1, urgent.id, true)).toBe(true); // again: no duplicate row
    expect(await namesOf(U1, M1)).toEqual(['Urgent']);
    expect(await namesOf(U2, M1)).toEqual([]);
    expect(await store.setManualTag(U2, M1, others.id, true)).toBe(false); // not their message
    expect(await store.setManualTag(U1, M1, others.id, true)).toBe(false); // not their tag
    expect(await store.setManualTag(U1, M2, urgent.id, true)).toBe(false); // not their message
    expect(await store.setManualTag(U1, M1, urgent.id, false)).toBe(true);
    expect(await namesOf(U1, M1)).toEqual([]);
    expect(await store.setManualTag(U1, M1, urgent.id, false)).toBe(true); // nothing left to remove is not an error
  });

  it('deleting a tag removes it from the messages', async () => {
    const t = await store.createDefinition(U1, { name: 'Temp' });
    await store.setManualTag(U1, M1, t.id, true);
    await store.deleteDefinition(U1, t.id);
    expect((await db.query('SELECT 1 FROM message_tags WHERE tag_id = $1', [t.id])).rowCount).toBe(0);
    expect(await namesOf(U1, M1)).toEqual([]);
  });
});

// The statements MailFlow runs when a message is trashed, moved or resynced, replayed against real tables:
// tags keyed by the message row id used to fail (foreign key) or silently disappear.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('tags follow the email (PostgreSQL)', () => {
  let db;
  const schema = `tags_follow_test_${process.pid}`;
  const E1 = '00000000-0000-4000-8000-0000000000e1';
  const E2 = '00000000-0000-4000-8000-0000000000e2';
  const E3 = '00000000-0000-4000-8000-0000000000e3';
  const namesOf = async (id) => ((await store.tagsForMessages(U1, [id]))[id] || []).map((t) => t.name).sort();
  const idOf = async (messageId) => (await db.query('SELECT id FROM messages WHERE message_id = $1', [messageId])).rows[0].id;
  let urgent;
  let important;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public`);
    await db.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id));
      CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES email_accounts(id), folder text, uid bigint,
        message_id text, UNIQUE (account_id, uid, folder));
      INSERT INTO users VALUES ('${U1}');
      INSERT INTO email_accounts VALUES ('${A1}', '${U1}');`);
    await db.query(migration);
    query.mockImplementation((sql, params) => db.query(sql, params));
    urgent = await store.createDefinition(U1, { name: 'Urgent' });
    important = await store.createDefinition(U1, { name: 'Important' });
  });
  afterAll(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.end();
  });

  it('keeps the tags when a message is trashed (the row gets a new id, as in routes/mail.js)', async () => {
    await db.query(`INSERT INTO messages (id, account_id, folder, uid, message_id) VALUES ('${E1}', '${A1}', 'INBOX', 10, '<e1@x.example>')`);
    await store.setManualTag(U1, E1, urgent.id, true);
    // exactly the statement of the "move to Trash" delete
    await db.query('UPDATE messages SET folder = $1, uid = $2, id = gen_random_uuid() WHERE id = $3', ['Trash', 99, E1]);
    const moved = await idOf('<e1@x.example>');
    expect(moved).not.toBe(E1);
    expect(await namesOf(moved)).toEqual(['Urgent']);
  });

  it('keeps the tags through a bulk move (delete + reinsert with a new id) and a resync', async () => {
    await db.query(`INSERT INTO messages (id, account_id, folder, uid, message_id) VALUES ('${E2}', '${A1}', 'INBOX', 20, '<e2@x.example>')`);
    await store.setManualTag(U1, E2, important.id, true);
    // the bulk relocate: DELETE ... RETURNING then INSERT into the destination folder, id left to its default
    const { rows: [old] } = await db.query(`DELETE FROM messages WHERE id = '${E2}' RETURNING *`);
    await db.query('INSERT INTO messages (account_id, folder, uid, message_id) VALUES ($1, $2, $3, $4)', [old.account_id, 'Archive', 55, old.message_id]);
    const archived = await idOf('<e2@x.example>');
    expect(await namesOf(archived)).toEqual(['Important']);
    // the tag can still be changed from the new row
    await store.setManualTag(U1, archived, important.id, false);
    expect(await namesOf(archived)).toEqual([]);
  });

  it('deleting a message permanently does not fail, and its tags are pruned after a grace period', async () => {
    await db.query(`INSERT INTO messages (id, account_id, folder, uid, message_id) VALUES ('${E3}', '${A1}', 'Trash', 30, '<e3@x.example>')`);
    await store.setManualTag(U1, E3, urgent.id, true);
    await db.query(`DELETE FROM messages WHERE id = '${E3}'`); // the permanent delete (message already in Trash)
    const count = async () => Number((await db.query("SELECT count(*) FROM message_tags WHERE email_key = '<e3@x.example>'")).rows[0].count);
    expect(await count()).toBe(1); // kept for now: a moved message is also a delete followed by an insert
    await store.pruneOrphanTags();
    expect(await count()).toBe(1); // marked, within the grace period
    expect((await db.query("SELECT orphaned_at FROM message_tags WHERE email_key = '<e3@x.example>'")).rows[0].orphaned_at).not.toBeNull();
    await db.query("UPDATE message_tags SET orphaned_at = NOW() - interval '8 days' WHERE email_key = '<e3@x.example>'");
    await store.pruneOrphanTags();
    expect(await count()).toBe(0);
  });

  it('a mark is cleared when the email comes back before the grace period ends, and a live email is never pruned', async () => {
    const key = '<e4@x.example>';
    await db.query('INSERT INTO messages (account_id, folder, uid, message_id) VALUES ($1, $2, $3, $4)', [A1, 'INBOX', 40, key]);
    await store.setManualTag(U1, await idOf(key), urgent.id, true);
    await db.query('DELETE FROM messages WHERE message_id = $1', [key]);
    await store.pruneOrphanTags(); // marked
    await db.query('INSERT INTO messages (account_id, folder, uid, message_id) VALUES ($1, $2, $3, $4)', [A1, 'Archive', 41, key]);
    await store.pruneOrphanTags(); // unmarked
    expect((await db.query('SELECT orphaned_at FROM message_tags WHERE email_key = $1', [key])).rows[0].orphaned_at).toBeNull();
    await db.query("UPDATE message_tags SET orphaned_at = NOW() - interval '30 days' WHERE email_key = $1", [key]);
    await store.pruneOrphanTags();
    expect((await db.query('SELECT 1 FROM message_tags WHERE email_key = $1', [key])).rowCount).toBe(1);
  });

  it('setting a tag on a message again clears an orphan mark on it', async () => {
    const key = '<e5@x.example>';
    await db.query('INSERT INTO messages (account_id, folder, uid, message_id) VALUES ($1, $2, $3, $4)', [A1, 'INBOX', 45, key]);
    const id = await idOf(key);
    await store.setManualTag(U1, id, urgent.id, true);
    await db.query("UPDATE message_tags SET orphaned_at = NOW() - interval '30 days' WHERE email_key = $1", [key]);
    await store.setManualTag(U1, id, urgent.id, true);
    expect((await db.query('SELECT orphaned_at FROM message_tags WHERE email_key = $1', [key])).rows[0].orphaned_at).toBeNull();
  });

  it('two copies of an email (e.g. a label folder) share its tags', async () => {
    await db.query(`INSERT INTO messages (account_id, folder, uid, message_id) VALUES ('${A1}', 'INBOX', 50, '<copy@x.example>'), ('${A1}', 'Todo', 7, '<copy@x.example>')`);
    const ids = (await db.query("SELECT id FROM messages WHERE message_id = '<copy@x.example>' ORDER BY uid")).rows.map((r) => r.id);
    await store.setManualTag(U1, ids[0], important.id, true);
    expect(await namesOf(ids[1])).toEqual(['Important']);
    expect((await db.query("SELECT count(*) FROM message_tags WHERE email_key = '<copy@x.example>'")).rows[0].count).toBe('1');
  });

  it('a message without a Message-ID is tagged by its row id', async () => {
    await db.query("INSERT INTO messages (account_id, folder, uid, message_id) VALUES ($1, 'INBOX', 60, NULL)", [A1]);
    const id = (await db.query('SELECT id FROM messages WHERE uid = 60')).rows[0].id;
    expect(await store.setManualTag(U1, id, urgent.id, true)).toBe(true);
    expect(await namesOf(id)).toEqual(['Urgent']);
  });

  it('copiesOfMessage lists every row of the email, scoped to the owner', async () => {
    await db.query(`INSERT INTO messages (account_id, folder, uid, message_id) VALUES ('${A1}', 'INBOX', 70, '<c2@x.example>'), ('${A1}', 'Todo', 8, '<c2@x.example>'), ('${A1}', 'INBOX', 71, '<other@x.example>')`);
    const ids = (await db.query("SELECT id FROM messages WHERE message_id = '<c2@x.example>'")).rows.map((r) => r.id).sort();
    expect((await store.copiesOfMessage(U1, ids[0])).sort()).toEqual(ids);
    expect(await store.copiesOfMessage(U2, ids[0])).toEqual([]);
    // without a Message-ID the email is the row itself
    const bare = (await db.query("SELECT id FROM messages WHERE uid = 60")).rows[0].id;
    expect(await store.copiesOfMessage(U1, bare)).toEqual([bare]);
  });

  it('a message without a Message-ID loses its tags when its row id changes (documented limit)', async () => {
    await db.query("INSERT INTO messages (account_id, folder, uid, message_id) VALUES ($1, 'INBOX', 80, NULL)", [A1]);
    const id = (await db.query('SELECT id FROM messages WHERE uid = 80')).rows[0].id;
    await store.setManualTag(U1, id, urgent.id, true);
    await db.query('UPDATE messages SET folder = $1, uid = $2, id = gen_random_uuid() WHERE id = $3', ['Trash', 81, id]);
    const moved = (await db.query('SELECT id FROM messages WHERE uid = 81')).rows[0].id;
    expect(await namesOf(moved)).toEqual([]);
  });

  it('the orphan prune keeps row-keyed and Message-ID-keyed tags of live mail and never casts a Message-ID', async () => {
    const bare = (await db.query('SELECT id FROM messages WHERE uid = 60')).rows[0].id;
    await store.setManualTag(U1, bare, urgent.id, true);
    await store.pruneOrphanTags();
    expect((await db.query("SELECT count(*) FROM message_tags WHERE email_key = $1 AND orphaned_at IS NOT NULL", [`row:${bare}`])).rows[0].count).toBe('0');
    expect(await namesOf(bare)).toEqual(['Urgent']);
  });
});

