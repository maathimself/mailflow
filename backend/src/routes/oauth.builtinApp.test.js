import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { FAKE_BUILTIN_ID, mocks } = vi.hoisted(() => ({ FAKE_BUILTIN_ID: '11111111-2222-4333-8444-555555555555', mocks: {
  imapManager: { clearConnectCooldown: vi.fn(), connectAccount: vi.fn() },
  withTransaction: vi.fn(),
  jwtVerify: vi.fn(),
} }));

// oauth.js imports imapManager from ../index.js, which has heavy load-time side
// effects (Redis connect, migrations). Mock it so importing oauth.js is inert.
vi.mock('../index.js', () => ({ imapManager: mocks.imapManager }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: mocks.withTransaction }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(() => ({})), jwtVerify: mocks.jwtVerify }));
// A stand-in for MailFlow's registered app, so the tests never depend on the shipped ID.
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: FAKE_BUILTIN_ID }));

import express from 'express';
import oauthRoutes from './oauth.js';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_BUILTIN_APP'];

function buildApp() {
  const app = express();
  app.use((req, _res, next) => { req.session = { userId: 'user-1' }; next(); });
  app.use('/oauth', oauthRoutes);
  return app;
}

// The device-code sign-in for personal Microsoft accounts (#674): with no app of the
// instance's own it runs through MailFlow's built-in public client, and the account
// records which client and tenant it was connected with.
describe('Microsoft device-code flow client', () => {
  let server;
  let base;
  let statements; // [sql, params] run inside the upsert transaction
  let microsoftCalls; // [url, URLSearchParams] sent to Microsoft
  const savedEnv = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    await new Promise(resolve => { server = buildApp().listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    statements = [];
    microsoftCalls = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        statements.push([sql, params]);
        if (/^SELECT \* FROM email_accounts WHERE id =/.test(sql)) return { rows: [{ id: 'acc-new' }] };
        if (/INSERT INTO email_accounts/.test(sql)) return { rows: [{ id: 'acc-new' }] };
        return { rows: [] };
      }),
    };
    mocks.withTransaction.mockReset().mockImplementation(fn => fn(client));
    mocks.jwtVerify.mockReset().mockResolvedValue({ payload: { email: 'me@outlook.com', name: 'Me' } });
    mocks.imapManager.connectAccount.mockReset().mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      microsoftCalls.push([url, init.body]);
      if (url.endsWith('/devicecode')) {
        return { ok: true, json: async () => ({ device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 }) };
      }
      return { ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'idt' }) };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function connect() {
    const start = await realFetch(`${base}/oauth/microsoft/device`, { method: 'POST' });
    if (!start.ok) return { start };
    const poll = await (await realFetch(`${base}/oauth/microsoft/device/poll`)).json();
    return { start, poll };
  }

  const insert = () => statements.find(([sql]) => /INSERT INTO email_accounts/.test(sql));

  it('uses the built-in client on the consumers tenant when no Client ID is configured', async () => {
    const { start, poll } = await connect();
    expect(start.status).toBe(200);
    expect(poll).toEqual({ status: 'checking', accountId: 'acc-new', email: 'me@outlook.com' });

    expect(microsoftCalls.map(([url]) => url)).toEqual([
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    ]);
    for (const [, body] of microsoftCalls) {
      expect(body.get('client_id')).toBe(FAKE_BUILTIN_ID);
      expect(body.has('client_secret')).toBe(false);
    }
    // The id_token is issued to the built-in client, so that is its audience.
    expect(mocks.jwtVerify.mock.calls[0][2]).toEqual({ audience: FAKE_BUILTIN_ID });

    // The new account records the client and tenant its refresh token belongs to.
    const [sql, params] = insert();
    expect(sql).toMatch(/oauth_public_client, oauth_client_id, oauth_tenant_id/);
    expect(params.slice(-3)).toEqual([true, FAKE_BUILTIN_ID, 'consumers']);
  });

  it('never sends the configured secret with the built-in client', async () => {
    process.env.MS_CLIENT_SECRET = 'secret-xyz';
    const { poll } = await connect();
    expect(poll).toEqual({ status: 'checking', accountId: 'acc-new', email: 'me@outlook.com' });
    expect(microsoftCalls).toHaveLength(2);
    for (const [, body] of microsoftCalls) expect(body.has('client_secret')).toBe(false);
  });

  it('uses the configured app and tenant, exactly as before, when a Client ID is set', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'contoso.example';
    const { poll } = await connect();
    expect(poll).toEqual({ status: 'checking', accountId: 'acc-new', email: 'me@outlook.com' });

    expect(microsoftCalls[0][0]).toBe('https://login.microsoftonline.com/contoso.example/oauth2/v2.0/devicecode');
    for (const [, body] of microsoftCalls) expect(body.get('client_id')).toBe('own-app-id');
    expect(insert()[1].slice(-3)).toEqual([true, 'own-app-id', 'contoso.example']);
  });

  it('records the client on an existing account that signs in again', async () => {
    const client = {
      query: vi.fn(async (sql, params) => {
        statements.push([sql, params]);
        if (/SELECT id, imap_host, oauth_provider FROM email_accounts/.test(sql)) {
          return { rows: [{ id: 'acc-1', imap_host: 'outlook.office365.com', oauth_provider: 'microsoft' }] };
        }
        return { rows: [{ id: 'acc-1' }] };
      }),
    };
    mocks.withTransaction.mockImplementation(fn => fn(client));
    await connect();

    const [sql, params] = statements.find(([s]) => /UPDATE email_accounts/.test(s));
    expect(sql).toMatch(/oauth_client_id = \$7, oauth_tenant_id = \$8/);
    expect(params.slice(4)).toEqual([true, 'acc-1', FAKE_BUILTIN_ID, 'consumers']);
  });

  it.each(['false', 'FALSE', '0', 'off', 'no'])('MS_BUILTIN_APP=%s keeps the not-configured error', async (value) => {
    process.env.MS_BUILTIN_APP = value;
    const { start } = await connect();
    expect(start.status).toBe(400);
    expect((await start.json()).error).toMatch(/Microsoft integration not configured/);
    expect(microsoftCalls).toEqual([]);
  });

  it('the opt-out does not affect an instance with its own app', async () => {
    process.env.MS_BUILTIN_APP = 'false';
    process.env.MS_CLIENT_ID = 'own-app-id';
    const { start } = await connect();
    expect(start.status).toBe(200);
    expect(microsoftCalls[0][1].get('client_id')).toBe('own-app-id');
  });
});
