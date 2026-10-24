import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null }));

// The real migration runner, oauth.js and the engine's error recording on a fresh database.
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
const engine = vi.hoisted(() => ({ clearConnectCooldown: () => {}, connectAccount: async () => true }));
vi.mock('../index.js', () => ({ imapManager: engine }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
const signedIn = vi.hoisted(() => ({ email: 'maria.lopez@outlook.com' }));
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async () => ({ payload: { email: signedIn.email, name: 'Maria' } })),
}));
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));

import express from 'express';
import { runMigrations } from '../services/migrations.js';
import { ImapManager } from '../services/imapManager.js';
import oauthRoutes from './oauth.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;

// Migration 0070 (#674): sync_error_code, recorded with sync_error and cleared with it, and a
// "Sign in again" repair that never adds a second account for a different address.
describe.skipIf(!ADMIN_URL)('account error codes and repair sign-in on PostgreSQL', () => {
  const dbName = `mailflow_674r_${randomBytes(4).toString('hex')}`;
  let admin;
  let server;
  let base;
  let user;
  let account;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString() });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: req.get('x-user') }; next(); });
    app.use('/oauth', oauthRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    delete process.env.MS_CLIENT_ID;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise(resolve => server.close(resolve));
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it('applies on a fresh database through the migration runner, and again as a no-op', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
    await runMigrations();
    const { rows: applied } = await h.pool.query(
      "SELECT version FROM schema_migrations WHERE version = '0070_email_accounts_sync_error_code'");
    expect(applied).toHaveLength(1);
    const { rows: cols } = await h.pool.query(`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'email_accounts' AND column_name = 'sync_error_code'`);
    expect(cols).toEqual([{ data_type: 'character varying', is_nullable: 'YES' }]);

    ({ rows: [user] } = await h.pool.query("INSERT INTO users (username) VALUES ('maria') RETURNING id"));
    ({ rows: [account] } = await h.pool.query(`
      INSERT INTO email_accounts (user_id, name, email_address, imap_host, oauth_provider, oauth_refresh_token,
        oauth_public_client, oauth_client_id, oauth_tenant_id)
      VALUES ($1, 'Maria', 'Maria.Lopez@outlook.com', 'outlook.office365.com', 'microsoft', 'rt', true,
        'builtin-app-id', 'consumers') RETURNING *`, [user.id]));
  });

  it('records the code with the error and clears both', async () => {
    const self = { _syncErrorState: new Map(), _accountErrorStreak: new Map(), broadcast: vi.fn() };
    await ImapManager.prototype._recordAccountError.call(self, account, 'User is authenticated but not connected.');
    const row = async () => (await h.pool.query('SELECT sync_error, sync_error_code FROM email_accounts WHERE id = $1', [account.id])).rows[0];
    expect(await row()).toEqual({ sync_error: 'User is authenticated but not connected.', sync_error_code: 'ms_imap_disabled_personal' });
    await ImapManager.prototype._clearAccountError.call(self, account);
    expect(await row()).toEqual({ sync_error: null, sync_error_code: null });
  });

  const signIn = async (email) => {
    signedIn.email = email;
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => (url.endsWith('/devicecode')
        ? { device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 }
        : { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, id_token: 'idt' }),
    })));
    const headers = { 'x-user': user.id, 'Content-Type': 'application/json' };
    const start = await realFetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers, body: JSON.stringify({ accountId: account.id }) });
    expect(start.status).toBe(200);
    return (await realFetch(`${base}/oauth/microsoft/device/poll`, { headers })).json();
  };

  it('refuses a repair signed in as a different address, adding nothing', async () => {
    await h.pool.query("UPDATE email_accounts SET sync_error = 'AUTHENTICATE failed.', sync_error_code = 'oauth_reauth' WHERE id = $1", [account.id]);
    expect(await signIn('someone.else@hotmail.com')).toEqual({
      status: 'wrong_account', signedInAs: 'someone.else@hotmail.com', expected: 'Maria.Lopez@outlook.com',
    });
    const { rows } = await h.pool.query('SELECT id, oauth_refresh_token, sync_error_code FROM email_accounts WHERE user_id = $1', [user.id]);
    expect(rows).toEqual([{ id: account.id, oauth_refresh_token: 'rt', sync_error_code: 'oauth_reauth' }]);
  });

  it('repairs the account for its own address, whatever the case, and clears its error', async () => {
    // The mailbox refuses the first connection: the engine records it, and the next poll
    // reports it from the row.
    engine.connectAccount = async (acct) => {
      const self = { _syncErrorState: new Map(), _accountErrorStreak: new Map(), broadcast: () => {} };
      await ImapManager.prototype._recordAccountError.call(self, acct, 'User is authenticated but not connected.');
      return false;
    };
    expect(await signIn('maria.lopez@outlook.com')).toEqual({ status: 'checking', accountId: account.id, email: 'Maria.Lopez@outlook.com' });
    const headers = { 'x-user': user.id };
    expect(await (await realFetch(`${base}/oauth/microsoft/device/poll`, { headers })).json()).toEqual({
      status: 'success', accountId: account.id, email: 'Maria.Lopez@outlook.com',
      connection: 'failed', code: 'ms_imap_disabled_personal', error: 'User is authenticated but not connected.',
    });
    // Turned on in Outlook.com, the account connects: the error goes.
    engine.connectAccount = async (acct) => {
      const self = { _syncErrorState: new Map(), _accountErrorStreak: new Map(), broadcast: () => {} };
      await ImapManager.prototype._clearAccountError.call(self, acct);
      return true;
    };
    expect(await signIn('maria.lopez@outlook.com')).toMatchObject({ status: 'checking' });
    expect(await (await realFetch(`${base}/oauth/microsoft/device/poll`, { headers })).json()).toMatchObject({ status: 'success', connection: 'connected' });
    const { rows } = await h.pool.query(
      'SELECT id, oauth_refresh_token, sync_error, sync_error_code FROM email_accounts WHERE user_id = $1', [user.id]);
    expect(rows).toEqual([{ id: account.id, oauth_refresh_token: 'rt-new', sync_error: null, sync_error_code: null }]);
    engine.connectAccount = async () => true;
  });
});
