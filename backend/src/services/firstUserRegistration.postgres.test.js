import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { closeRegistrationBeforeFirstUser } from './firstUserRegistration.js';

// FIRST_USER_REGISTRATION=false closes registration at startup, and only on an install that has no
// account yet. An existing install that sets it later must see no change at all. Uses only
// connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('closeRegistrationBeforeFirstUser on PostgreSQL', () => {
  let database;
  const OFF = { FIRST_USER_REGISTRATION: 'false' };
  const STAMP = '2026-01-02T03:04:05Z';
  const close = env => closeRegistrationBeforeFirstUser({ env, queryFn: (sql, params) => database.query(sql, params) });
  const setting = async () => (await database.query(
    "SELECT value, updated_at FROM system_settings WHERE key = 'registration_open'"
  )).rows[0];
  const given = async ({ users, open }) => {
    for (let i = 0; i < users; i++) await database.query("INSERT INTO users (username) VALUES ($1)", [`user${i}`]);
    await database.query("INSERT INTO system_settings (key, value, updated_at) VALUES ('registration_open', $1, $2)", [open, STAMP]);
  };

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query('CREATE TEMP TABLE users (id serial PRIMARY KEY, username text NOT NULL)');
    await database.query('CREATE TEMP TABLE system_settings (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz)');
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => { await database.query('TRUNCATE users, system_settings'); });

  it.each(['true', 'false'])('leaves an existing install with registration_open=%s untouched', async open => {
    await given({ users: 2, open });
    expect(await close(OFF)).toBe(false);
    expect(await setting()).toEqual({ value: open, updated_at: new Date(STAMP) });
  });

  it('closes registration on an install that has no account yet', async () => {
    await given({ users: 0, open: 'true' });
    expect(await close(OFF)).toBe(true);
    expect((await setting()).value).toBe('false');
  });

  it('changes nothing without FIRST_USER_REGISTRATION=false, even on a new install', async () => {
    await given({ users: 0, open: 'true' });
    expect(await close({})).toBe(false);
    expect(await setting()).toEqual({ value: 'true', updated_at: new Date(STAMP) });
  });
});
