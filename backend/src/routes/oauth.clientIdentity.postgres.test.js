import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null }));

// The real migration runner and oauth.js, on a fresh database: db.js would connect to the
// app's own, so it is pointed at the throwaway one created below.
vi.mock('../services/db.js', () => ({
  pool: { connect: (...a) => h.pool.connect(...a), query: (...a) => h.pool.query(...a) },
  query: (text, params) => h.pool.query(text, params),
  withTransaction: async (fn) => {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
}));
vi.mock('../index.js', () => ({ imapManager: { clearConnectCooldown: vi.fn(), connectAccount: vi.fn(async () => true) } }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async () => ({ payload: { email: 'me@outlook.com', name: 'Me' } })),
}));
// A stand-in for MailFlow's registered app, so the test never depends on the shipped ID.
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));

import express from 'express';
import { runMigrations } from '../services/migrations.js';
import oauthRoutes, { refreshMicrosoftToken } from './oauth.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;

// Migration 0069 (#674) through the real runner on an empty database, then a device-code
// sign-in through the built-in app stored on the migrated schema and refreshed from the row.
describe.skipIf(!ADMIN_URL)('Microsoft client identity on PostgreSQL', () => {
  const dbName = `mailflow_674_${randomBytes(4).toString('hex')}`;
  let admin;
  let server;
  let base;
  const savedEnv = { id: process.env.MS_CLIENT_ID, secret: process.env.MS_CLIENT_SECRET };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString() });

    const app = express();
    app.use((req, _res, next) => { req.session = { userId: req.get('x-user') }; next(); });
    app.use('/oauth', oauthRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise(resolve => server.close(resolve));
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    for (const [k, v] of [['MS_CLIENT_ID', savedEnv.id], ['MS_CLIENT_SECRET', savedEnv.secret]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('applies on a fresh database through the migration runner, and again as a no-op', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
    await runMigrations();

    const { rows: applied } = await h.pool.query(
      "SELECT version FROM schema_migrations WHERE version = '0069_email_accounts_oauth_client'");
    expect(applied).toHaveLength(1);
    const { rows: cols } = await h.pool.query(`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'email_accounts' AND column_name IN ('oauth_client_id', 'oauth_tenant_id')
       ORDER BY column_name`);
    expect(cols).toEqual([
      { column_name: 'oauth_client_id', is_nullable: 'YES' },
      { column_name: 'oauth_tenant_id', is_nullable: 'YES' },
    ]);
  });

  it('stores the built-in identity on a new account and refreshes through it after an own app is configured', async () => {
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    const { rows: [user] } = await h.pool.query("INSERT INTO users (username) VALUES ('maria') RETURNING id");

    const realFetch = globalThis.fetch;
    const microsoft = vi.fn(async (url) => ({
      ok: true,
      json: async () => (url.endsWith('/devicecode')
        ? { device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 }
        : { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'idt' }),
    }));
    vi.stubGlobal('fetch', microsoft);

    const headers = { 'x-user': user.id };
    expect((await realFetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers })).status).toBe(200);
    const poll = await (await realFetch(`${base}/oauth/microsoft/device/poll`, { headers })).json();

    const { rows: [account] } = await h.pool.query('SELECT * FROM email_accounts WHERE user_id = $1', [user.id]);
    expect(poll).toEqual({ status: 'checking', accountId: account.id, email: 'me@outlook.com' });
    expect(account).toMatchObject({
      email_address: 'me@outlook.com', oauth_provider: 'microsoft', oauth_public_client: true,
      oauth_client_id: 'builtin-app-id', oauth_tenant_id: 'consumers',
    });

    // The admin later registers an own confidential app. This account's refresh token
    // still belongs to the built-in client, which must never be sent the new secret.
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    microsoft.mockClear();
    await refreshMicrosoftToken(account);

    const [url, init] = microsoft.mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect(init.body.get('client_id')).toBe('builtin-app-id');
    expect(init.body.has('client_secret')).toBe(false);
    const { rows: [after] } = await h.pool.query('SELECT oauth_client_id, oauth_tenant_id FROM email_accounts WHERE id = $1', [account.id]);
    expect(after).toEqual({ oauth_client_id: 'builtin-app-id', oauth_tenant_id: 'consumers' });
  });

  it('does not store a refresh from the old client after the account was signed in again through another', async () => {
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    const { rows: [user] } = await h.pool.query("INSERT INTO users (username) VALUES ('ana') RETURNING id");
    const { rows: [account] } = await h.pool.query(`
      INSERT INTO email_accounts (user_id, name, email_address, imap_host, oauth_provider, oauth_refresh_token,
        oauth_access_token, oauth_public_client, oauth_client_id, oauth_tenant_id)
      VALUES ($1, 'Ana', 'ana@outlook.com', 'outlook.office365.com', 'microsoft', 'rt-builtin', 'at-builtin', true,
        'builtin-app-id', 'consumers') RETURNING *`, [user.id]);

    // The refresh is in flight with the built-in client when a sign-in through the
    // instance's own app completes and stores that app's tokens.
    vi.stubGlobal('fetch', vi.fn(async () => {
      await h.pool.query(`UPDATE email_accounts SET oauth_refresh_token = 'rt-own', oauth_access_token = 'at-own',
        oauth_client_id = 'own-app-id', oauth_tenant_id = 'common', oauth_public_client = false WHERE id = $1`, [account.id]);
      return { ok: true, json: async () => ({ access_token: 'at-builtin-2', refresh_token: 'rt-builtin-2', expires_in: 3600 }) };
    }));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await refreshMicrosoftToken(account);

    const { rows: [after] } = await h.pool.query(
      'SELECT oauth_refresh_token, oauth_access_token, oauth_client_id, oauth_tenant_id FROM email_accounts WHERE id = $1', [account.id]);
    expect(after).toEqual({ oauth_refresh_token: 'rt-own', oauth_access_token: 'at-own', oauth_client_id: 'own-app-id', oauth_tenant_id: 'common' });
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
  });

  it('records the instance identity on an account from before 0069 at its first refresh', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const { rows: [user] } = await h.pool.query("INSERT INTO users (username) VALUES ('joao') RETURNING id");
    const { rows: [old] } = await h.pool.query(`
      INSERT INTO email_accounts (user_id, name, email_address, imap_host, oauth_provider, oauth_refresh_token)
      VALUES ($1, 'Old', 'old@contoso.example', 'outlook.office365.com', 'microsoft', 'rt') RETURNING *`, [user.id]);
    expect(old.oauth_client_id).toBeNull();

    const microsoft = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'at2', expires_in: 3600 }) }));
    vi.stubGlobal('fetch', microsoft);
    await refreshMicrosoftToken(old);

    expect(microsoft.mock.calls[0][1].body.get('client_secret')).toBe('secret-xyz');
    const { rows: [after] } = await h.pool.query('SELECT oauth_client_id, oauth_tenant_id FROM email_accounts WHERE id = $1', [old.id]);
    expect(after).toEqual({ oauth_client_id: 'own-app-id', oauth_tenant_id: 'common' });
  });
});
