import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// oauth.js imports imapManager from ../index.js (heavy load-time side effects).
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn(async () => true),
    clearConnectCooldown: vi.fn(),
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  decrypt: (v) => v,
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
// ID-token signature checks are out of scope here; the route only needs the claims.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async () => ({ payload: { email: 'user@contoso.com', name: 'User' } })),
}));

import express from 'express';
import oauthRoutes from './oauth.js';
import { imapManager } from '../index.js';
import { withTransaction } from '../services/db.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = 'contoso-tenant';
const NONCE = 'test-nonce';
const TOKENS = { access_token: 'ms-at', refresh_token: 'ms-rt', expires_in: 3600, id_token: 'ms-id-token' };

function buildApp() {
  const app = express();
  // Test-only session: the x-test-user header stands in for the session cookie and
  // carries the nonce the auth-code callback expects from GET /oauth/microsoft.
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = userId ? { userId, oauthNonce: NONCE, oauthUserId: userId } : {};
    next();
  });
  app.use('/oauth', oauthRoutes);
  return app;
}

const realFetch = globalThis.fetch;
let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Transaction client for an account row that already exists (reconsent).
let dbCalls;
function installDb() {
  dbCalls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      dbCalls.push([sql, params]);
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/^\s*SELECT id FROM email_accounts/.test(sql)) return { rows: [{ id: 'ms-acc' }] };
      if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: params[0], email_address: 'user@contoso.com', oauth_provider: 'microsoft' }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
}
const updateSql = () => dbCalls.find(([sql]) => /^\s*UPDATE email_accounts/.test(sql))?.[0];

// Reconsent must lift the auth cooldown left by the old grant before reconnecting.
function expectCooldownClearedBeforeConnect() {
  expect(imapManager.clearConnectCooldown).toHaveBeenCalledWith('ms-acc');
  expect(imapManager.connectAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'ms-acc' }));
  expect(imapManager.clearConnectCooldown.mock.invocationCallOrder[0])
    .toBeLessThan(imapManager.connectAccount.mock.invocationCallOrder[0]);
}

// Requests to the test server go through; Microsoft endpoints get canned responses.
function stubMicrosoft(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const href = String(url);
    if (href.startsWith(base)) return realFetch(url, init);
    return handler(href);
  }));
}
const json = (ok, body) => ({ ok, json: async () => body });

let logSpies;
beforeEach(() => {
  process.env.MS_CLIENT_ID = 'ms-client';
  process.env.MS_CLIENT_SECRET = 'ms-secret';
  process.env.MS_TENANT_ID = TENANT_ID;
  process.env.MS_REDIRECT_URI = 'https://mail.example.com/oauth/microsoft/callback';
  withTransaction.mockReset();
  imapManager.connectAccount.mockClear();
  imapManager.clearConnectCooldown.mockClear();
  installDb();
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;
  delete process.env.MS_TENANT_ID;
  delete process.env.MS_REDIRECT_URI;
  logSpies.forEach((s) => s.mockRestore());
});

describe('Microsoft reconsent clears the reconnect flag and connect cooldown', () => {
  it('auth-code callback resets oauth_reconnect_required and sync_error on an existing account', async () => {
    stubMicrosoft(() => json(true, TOKENS));

    const res = await fetch(`${base}/oauth/microsoft/callback?code=auth-code&state=${NONCE}`, {
      redirect: 'manual',
      headers: { 'x-test-user': USER_ID },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?oauth_success=microsoft');
    const sql = updateSql();
    expect(sql).toMatch(/oauth_reconnect_required\s*=\s*false/);
    expect(sql).toMatch(/sync_error\s*=\s*NULL/);
    expectCooldownClearedBeforeConnect();
  });

  it('device-code poll resets oauth_reconnect_required and sync_error on an existing account', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode')
      ? json(true, { device_code: 'dc', user_code: 'UC', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 })
      : json(true, TOKENS)));
    const headers = { 'x-test-user': USER_ID };

    const start = await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers });
    expect(start.status).toBe(200);
    const poll = await fetch(`${base}/oauth/microsoft/device/poll`, { headers });

    expect(await poll.json()).toEqual({ status: 'success' });
    const sql = updateSql();
    expect(sql).toMatch(/oauth_reconnect_required\s*=\s*false/);
    expect(sql).toMatch(/sync_error\s*=\s*NULL/);
    expectCooldownClearedBeforeConnect();
  });
});

describe('Microsoft device-code errors never echo provider text', () => {
  const PROVIDER_TEXT = 'AADSTS700016: Application with identifier ms-client was not found. Trace ID: abc';
  const headers = { 'x-test-user': USER_ID };
  const loggedText = () => logSpies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
  const startOk = () => json(true, { device_code: 'dc-secret', user_code: 'UC', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900 });

  it('start returns a stable error when Microsoft rejects the device-code request', async () => {
    stubMicrosoft(() => json(false, { error: 'unauthorized_client', error_description: PROVIDER_TEXT }));
    const res = await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to start device code flow', code: 'device_code_start_failed' });
    expect(loggedText()).not.toContain('AADSTS700016');
  });

  it('start returns a stable error when the request throws', async () => {
    stubMicrosoft(() => { throw new Error(`connect ECONNREFUSED ${PROVIDER_TEXT}`); });
    const res = await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers });
    expect(await res.json()).toEqual({ error: 'Failed to start device code flow', code: 'device_code_start_failed' });
  });

  it('poll returns a stable error when the token exchange is rejected', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode')
      ? startOk()
      : json(false, { error: 'invalid_grant', error_description: PROVIDER_TEXT })));
    expect((await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers })).status).toBe(200);
    const poll = await fetch(`${base}/oauth/microsoft/device/poll`, { headers });
    expect(await poll.json()).toEqual({ status: 'error', error: 'Token exchange failed', code: 'device_code_token_failed' });
    expect(loggedText()).not.toContain('AADSTS700016');
  });

  it('poll returns a stable error when processing the tokens throws', async () => {
    stubMicrosoft((href) => (href.endsWith('/devicecode') ? startOk() : json(true, TOKENS)));
    withTransaction.mockImplementation(async () => { throw new Error(`db exploded ${PROVIDER_TEXT}`); });
    expect((await fetch(`${base}/oauth/microsoft/device`, { method: 'POST', headers })).status).toBe(200);
    const poll = await fetch(`${base}/oauth/microsoft/device/poll`, { headers });
    expect(await poll.json()).toEqual({ status: 'error', error: 'Token exchange failed', code: 'device_code_token_failed' });
    expect(loggedText()).not.toContain('ms-at');
    expect(loggedText()).not.toContain('dc-secret');
  });
});
