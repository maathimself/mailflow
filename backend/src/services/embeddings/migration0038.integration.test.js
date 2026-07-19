import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from './testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

d('0038 last_modified trigger', () => {
  let client;
  let acctId, userId;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    ({ accountId: acctId, userId } = await seedAccount(client, 'mig'));
  });
  afterAll(async () => {
    await cleanupAccount(client, userId);
    await client.end();
  });

  async function insertMsg(uid) {
    const r = await client.query(
      `INSERT INTO messages (account_id, uid, folder, subject, body_text)
       VALUES ($1, $2, 'INBOX', 'orig subject', NULL) RETURNING id, last_modified`,
      [acctId, uid]
    );
    return r.rows[0];
  }

  it('does NOT bump last_modified on a flag-only UPDATE', async () => {
    const m = await insertMsg(90001);
    await client.query('UPDATE messages SET is_read = true WHERE id = $1', [m.id]);
    const after = await client.query('SELECT last_modified FROM messages WHERE id = $1', [m.id]);
    expect(after.rows[0].last_modified.getTime()).toBe(m.last_modified.getTime());
  });

  it('bumps last_modified when body_text changes', async () => {
    const m = await insertMsg(90002);
    await new Promise(r => setTimeout(r, 5));
    await client.query("UPDATE messages SET body_text = 'a late body arrived' WHERE id = $1", [m.id]);
    const after = await client.query('SELECT last_modified FROM messages WHERE id = $1', [m.id]);
    expect(after.rows[0].last_modified.getTime()).toBeGreaterThan(m.last_modified.getTime());
  });

  it('embed_gen defaults to NULL', async () => {
    const m = await insertMsg(90003);
    const r = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [m.id]);
    expect(r.rows[0].embed_gen).toBeNull();
  });

  it('clears embed_gen (re-surfaces for embedding) when body_text changes post-stamp', async () => {
    const m = await insertMsg(90004);
    await client.query('UPDATE messages SET embed_gen = 12345 WHERE id = $1', [m.id]); // embedded + stamped
    await client.query("UPDATE messages SET body_text = 'a late body arrived' WHERE id = $1", [m.id]); // late body
    const r = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [m.id]);
    expect(r.rows[0].embed_gen).toBeNull(); // the stale subject-only embedding must be re-done
  });

  it('does NOT clear embed_gen on a stamp-only UPDATE (worker stamp) — trigger does not fire', async () => {
    const m = await insertMsg(90005);
    const before = await client.query('SELECT last_modified FROM messages WHERE id = $1', [m.id]);
    await client.query('UPDATE messages SET embed_gen = 777 WHERE id = $1', [m.id]);
    const after = await client.query('SELECT embed_gen, last_modified FROM messages WHERE id = $1', [m.id]);
    expect(String(after.rows[0].embed_gen)).toBe('777');                                   // stamp persists
    expect(after.rows[0].last_modified.getTime()).toBe(before.rows[0].last_modified.getTime()); // trigger didn't fire
  });

  it('does NOT clear embed_gen on an identical-content UPSERT (unchanged re-sync)', async () => {
    const m = await insertMsg(90006);
    await client.query('UPDATE messages SET embed_gen = 888 WHERE id = $1', [m.id]);
    await client.query(
      `INSERT INTO messages (account_id, uid, folder, subject, body_text)
       VALUES ($1, 90006, 'INBOX', 'orig subject', NULL)
       ON CONFLICT (account_id, uid, folder)
       DO UPDATE SET subject = EXCLUDED.subject, body_text = EXCLUDED.body_text`,
      [acctId]
    );
    const r = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [m.id]);
    expect(String(r.rows[0].embed_gen)).toBe('888'); // unchanged content → trigger no-op → stamp survives
  });
});
