import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'fs';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query, withTransaction } from './db.js';
import {
  createToken, deleteToken, findTokenByHash, generateToken, hashToken, invalidateApiTokenSettingsCache,
  listTokens, MAX_TOKENS_PER_USER, revokeProviderTokens, revokeTokensForPolicy, tokenStillValid,
} from './apiTokens.js';

// #617: the API token SQL, migration 0072 as it ships included, with expiry decided by the
// database clock. CI does not run this, so apiTokens.test.js pins the expiry expressions too.
// Uses only connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('API tokens PostgreSQL', () => {
  let database;
  let migratedSwitch;
  const OWNER = '00000000-0000-4000-8000-000000000001';
  const OTHER = '00000000-0000-4000-8000-000000000002';
  const CORP = 'c0c0c0c0-0000-4000-8000-000000000001';
  const OTHER_IDP = 'c0c0c0c0-0000-4000-8000-000000000002';
  // Each statement of a migration, comments dropped, refused unless it only reaches api_tokens and
  // system_settings, which are temporary here.
  const statementsOf = (file, allowed) => readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8')
    .replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)
    .map(statement => {
      if (!allowed.test(statement)) throw new Error(`${file} has a statement this test cannot keep to temporary tables: ${statement.slice(0, 80)}`);
      return statement;
    });

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    // What the migration refers to, as temporary tables, made first so that it reaches nothing else.
    await database.query(`
      CREATE TEMP TABLE users (id uuid PRIMARY KEY, username text NOT NULL);
      CREATE TEMP TABLE oidc_providers (id uuid PRIMARY KEY);
      CREATE TEMP TABLE system_settings (key varchar(100) PRIMARY KEY, value text, updated_at timestamptz DEFAULT NOW())`);
    const tableAndSwitch = /^(CREATE TABLE IF NOT EXISTS api_tokens |CREATE (UNIQUE )?INDEX IF NOT EXISTS \w+ ON api_tokens\(|INSERT INTO system_settings )/;
    for (const statement of statementsOf('0072_api_tokens.sql', tableAndSwitch)) {
      await database.query(statement.replace(/^CREATE TABLE/, 'CREATE TEMP TABLE'));
    }
    migratedSwitch = (await database.query("SELECT value FROM system_settings WHERE key = 'api_tokens_enabled'")).rows[0]?.value;
    query.mockImplementation((sql, values) => database.query(sql, values));
    withTransaction.mockImplementation(async (fn) => {
      await database.query('BEGIN');
      try {
        const result = await fn(database);
        await database.query('COMMIT');
        return result;
      } catch (err) {
        await database.query('ROLLBACK');
        throw err;
      }
    });
  });
  afterAll(async () => {
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE api_tokens, users, oidc_providers');
    await database.query("INSERT INTO users VALUES ($1, 'maria'), ($2, 'olga')", [OWNER, OTHER]);
    await database.query('INSERT INTO oidc_providers VALUES ($1), ($2)', [CORP, OTHER_IDP]);
    await database.query("UPDATE system_settings SET value = 'true' WHERE key = 'api_tokens_enabled'");
    // The sign-in policy rows, as migrations 0004 and 0020 seed them.
    await database.query(`INSERT INTO system_settings (key, value) VALUES ('mfa_enforcement', 'off'), ('internal_auth_disabled', 'false')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    invalidateApiTokenSettingsCache();
  });

  // expires: SQL for expires_at, written here, never from input.
  const insertToken = async (userId, expires, name = 'tool', { confirmedWith = 'password', providerId = null } = {}) => {
    const secret = generateToken();
    const { rows: [row] } = await database.query(
      `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at, confirmed_with, oidc_provider_id)
       VALUES ($1, $2, $3, '["read","organize"]', ${expires}, $4, $5) RETURNING id`,
      [userId, name, hashToken(secret), confirmedWith, providerId],
    );
    return { secret, id: row.id };
  };
  const names = async () => (await database.query('SELECT name FROM api_tokens ORDER BY name')).rows.map(r => r.name);
  const PAST = "NOW() - interval '1 minute'";
  const FUTURE = "NOW() + interval '1 day'";

  it('leaves tokens turned off after the migration', () => {
    expect(migratedSwitch).toBe('false');
  });

  it('gives every token an expiry and one of the three confirmations', async () => {
    // expires: SQL, written here.
    const insert = (expires, confirmedWith) => database.query(
      `INSERT INTO api_tokens (user_id, name, token_hash, expires_at, confirmed_with) VALUES ($1, 'x', $2, ${expires}, $3)`,
      [OWNER, hashToken(generateToken()), confirmedWith],
    );
    await expect(insert('NULL', 'password')).rejects.toMatchObject({ code: '23502' });
    await expect(insert('NOW()', null)).rejects.toMatchObject({ code: '23502' });
    await expect(insert('NOW()', 'magic')).rejects.toMatchObject({ code: '23514' });
    for (const confirmedWith of ['password', 'totp', 'oidc']) await insert('NOW()', confirmedWith);
  });

  it('looks a token up by its hash, expired once the database clock has reached its expiry', async () => {
    const past = await insertToken(OWNER, PAST);
    const future = await insertToken(OWNER, FUTURE);
    expect(await findTokenByHash(hashToken(past.secret)))
      .toMatchObject({ id: past.id, user_id: OWNER, username: 'maria', scopes: ['read', 'organize'], expired: true });
    expect(await findTokenByHash(hashToken(future.secret))).toMatchObject({ id: future.id, expired: false });
    expect(await findTokenByHash(hashToken(generateToken()))).toBe(null);
  });

  it('holds a token valid mid-request only while it is unexpired, unrevoked and tokens are on', async () => {
    const past = await insertToken(OWNER, PAST);
    const future = await insertToken(OWNER, FUTURE);
    const later = await insertToken(OWNER, FUTURE, 'later');
    expect(await tokenStillValid(past.id)).toBe(false);
    expect(await tokenStillValid(future.id)).toBe(true);
    await database.query('DELETE FROM api_tokens WHERE id = $1', [future.id]);
    expect(await tokenStillValid(future.id)).toBe(false);
    await database.query("UPDATE system_settings SET value = 'false' WHERE key = 'api_tokens_enabled'");
    invalidateApiTokenSettingsCache();
    expect(await tokenStillValid(later.id)).toBe(false);
  });

  it('lists only the user\'s own tokens, newest first, each marked expired or not', async () => {
    const older = await insertToken(OWNER, PAST, 'older');
    await database.query("UPDATE api_tokens SET created_at = NOW() - interval '1 hour' WHERE id = $1", [older.id]);
    await insertToken(OWNER, FUTURE, 'newer');
    await insertToken(OTHER, FUTURE, 'not hers');
    expect((await listTokens(OWNER)).map(t => [t.name, t.expired])).toEqual([['newer', false], ['older', true]]);
  });

  it('creates a token storing only its hash, and stops at the limit', async () => {
    const created = await createToken(OWNER, {
      name: 'Claude', scopes: ['read', 'draft'], expiresAt: new Date(Date.now() + 86_400_000), confirmedWith: 'oidc', oidcProviderId: CORP,
    });
    expect(created.apiToken).toMatchObject({ name: 'Claude', scopes: ['read', 'draft'], lastUsedAt: null, expired: false });
    const { rows: [stored] } = await database.query(
      'SELECT token_hash, scopes, confirmed_with, oidc_provider_id FROM api_tokens WHERE id = $1', [created.apiToken.id],
    );
    expect(stored).toEqual({ token_hash: hashToken(created.token), scopes: ['read', 'draft'], confirmed_with: 'oidc', oidc_provider_id: CORP });

    for (let i = 1; i < MAX_TOKENS_PER_USER; i++) await insertToken(OWNER, PAST, `t${i}`);
    expect(await createToken(OWNER, { name: 'one too many', scopes: ['read'], expiresAt: new Date(), confirmedWith: 'password' })).toBe(null);
    const { rows: [{ count }] } = await database.query('SELECT COUNT(*)::int AS count FROM api_tokens WHERE user_id = $1', [OWNER]);
    expect(count).toBe(MAX_TOKENS_PER_USER);
    // Another user's limit is their own.
    expect(await createToken(OTHER, { name: 'hers', scopes: ['read'], expiresAt: new Date(), confirmedWith: 'password' })).not.toBe(null);
  });

  it('refuses, inside its transaction, a token the sign-in policy no longer allows', async () => {
    const create = (confirmedWith, providerId = null) => createToken(OWNER, {
      name: confirmedWith, scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000), confirmedWith, oidcProviderId: providerId,
    });
    await database.query("UPDATE system_settings SET value = 'required' WHERE key = 'mfa_enforcement'");
    expect(await create('password')).toEqual({ policyChanged: true });
    expect(await names()).toEqual([]);
    expect(await create('totp')).toMatchObject({ apiToken: { name: 'totp' } });
    await database.query("UPDATE system_settings SET value = 'true' WHERE key = 'internal_auth_disabled'");
    expect(await create('totp')).toEqual({ policyChanged: true });
    expect(await create('oidc', CORP)).toMatchObject({ apiToken: { name: 'oidc' } });
    expect(await names()).toEqual(['oidc', 'totp']);
  });

  it('revokes only the user\'s own token, and a deleted user takes theirs along', async () => {
    const mine = await insertToken(OWNER, FUTURE, 'mine');
    expect(await deleteToken(OTHER, mine.id)).toBe(null);
    expect(await deleteToken(OWNER, mine.id)).toBe('mine');
    expect(await findTokenByHash(hashToken(mine.secret))).toBe(null);
    const hers = await insertToken(OTHER, FUTURE);
    await database.query('DELETE FROM users WHERE id = $1', [OTHER]);
    expect(await findTokenByHash(hashToken(hers.secret))).toBe(null);
  });

  it('keeps one token per hash', async () => {
    const { secret } = await insertToken(OWNER, FUTURE);
    await expect(database.query(
      "INSERT INTO api_tokens (user_id, name, token_hash, expires_at, confirmed_with) VALUES ($1, 'copy', $2, NOW(), 'password')", [OWNER, hashToken(secret)],
    ))
      .rejects.toMatchObject({ code: '23505' });
  });

  describe('a change of sign-in policy', () => {
    beforeEach(async () => {
      await insertToken(OWNER, FUTURE, 'password', { confirmedWith: 'password' });
      await insertToken(OTHER, FUTURE, 'totp', { confirmedWith: 'totp' });
      await insertToken(OTHER, FUTURE, 'sso', { confirmedWith: 'oidc', providerId: CORP });
    });

    it('password sign-in off: leaves only tokens confirmed through single sign-on', async () => {
      expect(await revokeTokensForPolicy(database, 'ssoOnly')).toBe(2);
      expect(await names()).toEqual(['sso']);
    });

    it('two-factor required: deletes the tokens confirmed with only a password', async () => {
      expect(await revokeTokensForPolicy(database, 'mfaRequired')).toBe(1);
      expect(await names()).toEqual(['sso', 'totp']);
    });

    it('a provider turned off or deleted: deletes the tokens confirmed through it', async () => {
      await insertToken(OWNER, FUTURE, 'sso elsewhere', { confirmedWith: 'oidc', providerId: OTHER_IDP });
      expect(await revokeProviderTokens(database, CORP)).toBe(1);
      expect(await names()).toEqual(['password', 'sso elsewhere', 'totp']);
      await database.query('DELETE FROM oidc_providers WHERE id = $1', [OTHER_IDP]);
      expect(await names()).toEqual(['password', 'totp']);
    });
  });
});
