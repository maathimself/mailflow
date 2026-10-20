import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'fs/promises';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn() }));
import { query } from './db.js';
import { getAiStatus } from './aiProvider.js';
import { getUserAiAccess } from './aiAccess.js';
import { aiEnabledForNewUser, setAiEnabledForNewUser } from './aiNewUsers.js';

const MIGRATION = new URL('../../migrations/0067_users_ai_enabled.sql', import.meta.url);

// Migration 0067 and the per-user AI reads (#644) against a real PostgreSQL, on connection-local
// temporary tables shaped like users and system_settings before the migration.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('users.ai_enabled on PostgreSQL', () => {
  let database;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => {
    await database?.end();
  });
  beforeEach(async () => {
    await database.query(`
      DROP TABLE IF EXISTS pg_temp.users, pg_temp.system_settings;
      CREATE TEMP TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username varchar(120) UNIQUE NOT NULL,
        password_hash text, is_admin boolean DEFAULT false);
      CREATE TEMP TABLE system_settings (key varchar(100) PRIMARY KEY, value text NOT NULL, updated_at timestamptz)`);
    getAiStatus.mockReset().mockResolvedValue({ enabled: true, provider: 'api-key', features: { compose: true, summarize: true } });
  });

  it('keeps AI access for existing users, defaults new rows to it, and can run again', async () => {
    const { rows: before } = await database.query(
      "INSERT INTO users (username, is_admin) VALUES ('admin', true), ('maria', false) RETURNING id");
    const sql = await readFile(MIGRATION, 'utf8');
    await database.query(sql);
    await database.query(sql);

    const { rows } = await database.query('SELECT ai_enabled FROM users ORDER BY username');
    expect(rows).toEqual([{ ai_enabled: true }, { ai_enabled: true }]);
    await database.query("INSERT INTO users (username) VALUES ('joao')");
    expect((await database.query("SELECT ai_enabled FROM users WHERE username = 'joao'")).rows[0].ai_enabled).toBe(true);
    await expect(database.query("UPDATE users SET ai_enabled = NULL WHERE username = 'joao'")).rejects.toThrow(/null/i);

    expect((await getUserAiAccess(before[1].id)).allowed).toBe(true);
    await database.query('UPDATE users SET ai_enabled = false WHERE id = $1', [before[1].id]);
    expect(await getUserAiAccess(before[1].id)).toMatchObject({ allowed: false, isAdmin: false });
    expect(await getUserAiAccess(before[0].id)).toMatchObject({ allowed: true, isAdmin: true });
    // A user that does not exist is denied.
    expect((await getUserAiAccess('00000000-0000-4000-8000-000000000000')).allowed).toBe(false);
  });

  it('reads and writes "Allow AI for new users" inside a transaction', async () => {
    await database.query('BEGIN');
    try {
      expect(await aiEnabledForNewUser(database)).toBe(true);
      await setAiEnabledForNewUser(false, database);
      expect(await aiEnabledForNewUser(database)).toBe(false);
      await setAiEnabledForNewUser(true, database);
      expect(await aiEnabledForNewUser(database)).toBe(true);
    } finally {
      await database.query('ROLLBACK');
    }
  });
});
