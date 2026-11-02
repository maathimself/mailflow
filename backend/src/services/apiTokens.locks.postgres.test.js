import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { withTransaction } from './db.js';
import { createToken, revokeProviderTokens, revokeTokensForPolicy } from './apiTokens.js';
import { unlinkUserIdentity } from './userIdentities.js';

// #617: a revocation and a token creation at the same moment. createToken holds the users row, the
// provider, the identities there and the policy rows until it commits, and each revocation takes
// the same rows first, so whichever is blocked behind the other sees its result: a revocation that
// waited deletes the new token, a creation that waited is refused. Two connections are needed, so
// the tables are ordinary ones in a schema of this test's own, dropped at the end, in an explicitly
// supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('API tokens and revocations at the same moment', () => {
  const SCHEMA = `api_tokens_locks_${process.pid}_${Date.now()}`;
  const USER = '00000000-0000-4000-8000-000000000001';
  const CORP = 'c0c0c0c0-0000-4000-8000-000000000001';
  const AT_CORP = { id: CORP, issuerUrl: 'https://idp.example.com', clientId: 'mailflow' };
  const MARIA = { id: USER, password_hash: 'hash-maria', totp_enabled: false, totp_secret: null };
  let creating, revoking;

  beforeAll(async () => {
    creating = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    revoking = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await Promise.all([creating.connect(), revoking.connect()]);
    await creating.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const client of [creating, revoking]) await client.query(`SET search_path TO ${SCHEMA}`);
    await creating.query(`
      CREATE TABLE users (id uuid PRIMARY KEY, username text NOT NULL, password_hash text,
        totp_enabled boolean NOT NULL DEFAULT false, totp_secret text);
      CREATE TABLE oidc_providers (id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL,
        enabled boolean NOT NULL DEFAULT true, issuer_url text NOT NULL, client_id text NOT NULL);
      CREATE TABLE user_identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id uuid NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
        issuer text NOT NULL, email text, created_at timestamptz DEFAULT now(), last_used_at timestamptz);
      CREATE TABLE system_settings (key varchar(100) PRIMARY KEY, value text, updated_at timestamptz DEFAULT now());
      CREATE TABLE api_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, name varchar(60) NOT NULL,
        token_hash char(64) NOT NULL UNIQUE, scopes jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
        last_used_at timestamptz, last_used_ip varchar(45), confirmed_with varchar(10) NOT NULL,
        oidc_provider_id uuid REFERENCES oidc_providers(id) ON DELETE CASCADE)`);
  });
  afterAll(async () => {
    await creating?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await Promise.all([creating?.end(), revoking?.end()]);
  });
  beforeEach(async () => {
    await creating.query('TRUNCATE api_tokens, user_identities, users, oidc_providers, system_settings');
    await creating.query("INSERT INTO users (id, username, password_hash) VALUES ($1, 'maria', 'hash-maria')", [USER]);
    await creating.query(
      "INSERT INTO oidc_providers (id, name, slug, issuer_url, client_id) VALUES ($1, 'Corp', 'corp', 'https://idp.example.com', 'mailflow')", [CORP]);
    await creating.query("INSERT INTO user_identities (user_id, provider_id, issuer) VALUES ($1, $2, 'https://idp.example.com')", [USER, CORP]);
    await creating.query("INSERT INTO system_settings (key, value) VALUES ('mfa_enforcement', 'off'), ('internal_auth_disabled', 'false')");
  });

  // A transaction on `client`, as db.js runs one.
  const transaction = async (client, fn) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  };
  // createToken on the creating connection, held with its locks once the statement that starts
  // with `after` has run, until resume() is called.
  function pausedCreation(after, confirmation) {
    let pausedAt, resume;
    const paused = new Promise(r => { pausedAt = r; });
    const resumed = new Promise(r => { resume = r; });
    withTransaction.mockImplementationOnce(fn => transaction(creating, () => fn({
      query: async (sql, params) => {
        const result = await creating.query(sql, params);
        if (sql.startsWith(after)) {
          pausedAt();
          await resumed;
        }
        return result;
      },
    })));
    const created = createToken(MARIA, { name: 'racing', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000), ...confirmation });
    return { paused, resume, created };
  }
  // 'waiting' while a statement is blocked on the other connection's lock.
  const settled = promise => Promise.race([
    promise.then(() => 'done', err => `failed: ${err.message}`),
    new Promise(r => setTimeout(() => r('waiting'), 400)),
  ]);
  const tokenNames = async () => (await creating.query('SELECT name FROM api_tokens')).rows.map(r => r.name);

  it('an unlink that starts while the token is stored waits for it, then deletes it', async () => {
    const { paused, resume, created } = pausedCreation('SELECT 1 FROM user_identities', { confirmedWith: 'oidc', oidcProvider: AT_CORP });
    await paused;
    const { rows: [{ id: identityId }] } = await revoking.query('SELECT id FROM user_identities WHERE user_id = $1', [USER]);
    const unlink = transaction(revoking, client => unlinkUserIdentity(client, USER, identityId));
    expect(await settled(unlink)).toBe('waiting');
    resume();
    expect(await created).toMatchObject({ apiToken: { name: 'racing' } });
    expect((await unlink).revokedTokens).toBe(1);
    expect(await tokenNames()).toEqual([]);
  });

  it('a provider change that starts while the token is stored waits for it, then deletes it', async () => {
    const { paused, resume, created } = pausedCreation('SELECT key, value FROM system_settings', { confirmedWith: 'oidc', oidcProvider: AT_CORP });
    await paused;
    const change = transaction(revoking, async client => {
      await client.query("UPDATE oidc_providers SET client_id = 'other-app' WHERE id = $1", [CORP]);
      return revokeProviderTokens(client, CORP);
    });
    expect(await settled(change)).toBe('waiting');
    resume();
    expect(await created).toMatchObject({ apiToken: { name: 'racing' } });
    expect(await change).toBe(1);
    expect(await tokenNames()).toEqual([]);
  });

  it('a policy change that starts while the token is stored waits for it, then deletes it', async () => {
    const { paused, resume, created } = pausedCreation('SELECT key, value FROM system_settings', { confirmedWith: 'password' });
    await paused;
    const change = transaction(revoking, async client => {
      await client.query("UPDATE system_settings SET value = 'required', updated_at = NOW() WHERE key = 'mfa_enforcement'");
      return revokeTokensForPolicy(client, 'mfaRequired');
    });
    expect(await settled(change)).toBe('waiting');
    resume();
    expect(await created).toMatchObject({ apiToken: { name: 'racing' } });
    expect(await change).toBe(1);
    expect(await tokenNames()).toEqual([]);
  });

  it('a token being stored waits for a password change that holds the users row, then is refused', async () => {
    await revoking.query('BEGIN');
    await revoking.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [USER]);
    await revoking.query("UPDATE users SET password_hash = 'reset' WHERE id = $1", [USER]);
    withTransaction.mockImplementationOnce(fn => transaction(creating, fn));
    const created = createToken(MARIA, { name: 'late', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000), confirmedWith: 'password' });
    expect(await settled(created)).toBe('waiting');
    await revoking.query('COMMIT');
    expect(await created).toEqual({ signInChanged: true });
    expect(await tokenNames()).toEqual([]);
  });
});
