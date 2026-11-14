import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

let db;
vi.mock('./db.js', () => ({ query: (sql, params) => db.query(sql, params) }));
import { PgSessionStore } from './sessionStore.js';

const DAY = 24 * 60 * 60 * 1000;

// touch() against a real sessions table (D#400): it extends, it shortens for a shorter sign-in,
// and it leaves small differences alone.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('PgSessionStore.touch (PostgreSQL)', () => {
  const schema = `session_store_test_${process.pid}`;
  const store = new PgSessionStore();
  const touch = (sid, expires) => new Promise((resolve, reject) => store.touch(sid, { cookie: { expires } }, err => err ? reject(err) : resolve()));
  const expiry = async sid => (await db.query('SELECT expires_at FROM sessions WHERE sid = $1', [sid])).rows[0].expires_at.getTime();

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    await db.query('CREATE TABLE sessions (sid text PRIMARY KEY, sess jsonb NOT NULL, user_id text, expires_at timestamptz NOT NULL)');
  });
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });
  beforeEach(async () => {
    await db.query('DELETE FROM sessions');
    await db.query("INSERT INTO sessions VALUES ('s', '{}', 'u', $1)", [new Date(Date.now() + 90 * DAY)]);
  });

  it('extends the expiry', async () => {
    const later = new Date(Date.now() + 91 * DAY);
    await touch('s', later);
    expect(await expiry('s')).toBe(later.getTime());
  });

  it('shortens it when the user picked a shorter sign-in', async () => {
    const sooner = new Date(Date.now() + 7 * DAY);
    await touch('s', sooner);
    expect(await expiry('s')).toBe(sooner.getTime());
  });

  it('leaves it alone for differences under a minute either way', async () => {
    const before = await expiry('s');
    await touch('s', new Date(before + 30_000));
    await touch('s', new Date(before - 30_000));
    expect(await expiry('s')).toBe(before);
  });

  it('does not bring an ended session back', async () => {
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    const before = await expiry('s');
    await touch('s', new Date(Date.now() + 7 * DAY));
    expect(await expiry('s')).toBe(before);
  });
});
