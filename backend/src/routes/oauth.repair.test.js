import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  imapManager: { clearConnectCooldown: vi.fn(), connectAccount: vi.fn() },
  query: vi.fn(),
  withTransaction: vi.fn(),
  jwtVerify: vi.fn(),
}));

vi.mock('../index.js', () => ({ imapManager: mocks.imapManager }));
vi.mock('../services/db.js', () => ({ query: mocks.query, withTransaction: mocks.withTransaction }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));
vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(() => ({})), jwtVerify: mocks.jwtVerify }));
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));

import express from 'express';
import oauthRoutes from './oauth.js';
import { noteRefreshFailure, refreshFailureFor } from '../services/accountErrorCode.js';

const realFetch = globalThis.fetch;
const ENV_KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI', 'MS_BUILTIN_APP',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];

// The accounts the signed-in user owns, by id.
const ACCOUNTS = {
  '11111111-1111-4111-8111-111111111111': { id: '11111111-1111-4111-8111-111111111111', user_id: 'user-1', email_address: 'Maria.Lopez@outlook.com', imap_host: 'outlook.office365.com', oauth_provider: 'microsoft', oauth_client_id: 'builtin-app-id' },
  '22222222-2222-4222-8222-222222222222': { id: '22222222-2222-4222-8222-222222222222', user_id: 'user-1', email_address: 'maria@gmail.com', imap_host: 'imap.gmail.com', oauth_provider: 'google' },
  '33333333-3333-4333-8333-333333333333': { id: '33333333-3333-4333-8333-333333333333', user_id: 'user-1', email_address: 'maria@example.com', imap_host: 'imap.example.com', oauth_provider: null },
  // Connected through the instance's own app on the common tenant.
  '55555555-5555-4555-8555-555555555555': { id: '55555555-5555-4555-8555-555555555555', user_id: 'user-1', email_address: 'maria@outlook.com', imap_host: 'outlook.office365.com', oauth_provider: 'microsoft', oauth_client_id: 'own-app-id', oauth_tenant_id: 'common' },
  '66666666-6666-4666-8666-666666666666': { id: '66666666-6666-4666-8666-666666666666', user_id: 'user-1', email_address: 'maria@contoso.example', imap_host: 'outlook.office365.com', oauth_provider: 'microsoft', oauth_client_id: 'own-app-id', oauth_tenant_id: 'contoso.example' },
  // Another user's accounts, which a repair must never reach.
  '77777777-7777-4777-8777-777777777777': { id: '77777777-7777-4777-8777-777777777777', user_id: 'user-2', email_address: 'maria.lopez@outlook.com', imap_host: 'outlook.office365.com', oauth_provider: 'microsoft', oauth_client_id: 'builtin-app-id' },
  '88888888-8888-4888-8888-888888888888': { id: '88888888-8888-4888-8888-888888888888', user_id: 'user-2', email_address: 'maria@gmail.com', imap_host: 'imap.gmail.com', oauth_provider: 'google' },
};

let session;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = session; next(); });
  app.use('/oauth', oauthRoutes);
  return app;
}

// Answers a SELECT against email_accounts by id (and user) with only the named columns.
function pick(sql, params) {
  const m = sql.match(/SELECT ([\w\s,*]+?) FROM email_accounts WHERE id = \$1 AND user_id = \$2/);
  if (!m) return null;
  const row = ACCOUNTS[params[0]];
  if (!row || row.user_id !== params[1]) return { rows: [] };
  const cols = m[1].split(',').map(c => c.trim());
  return { rows: [cols.includes('*') ? row : Object.fromEntries(cols.map(c => [c, row[c]]))] };
}

// "Sign in again" on a broken account (#674) names that account. Signing in to the provider as
// someone else must not add a second account, nor touch the one being repaired.
describe('repairing an account by signing in again', () => {
  let server;
  let base;
  let statements;
  let signedInAs;
  const saved = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    await new Promise(resolve => { server = buildApp().listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    session = { userId: 'user-1', save: (cb) => cb() };
    statements = [];
    signedInAs = 'maria.lopez@outlook.com';
    mocks.query.mockReset().mockImplementation(async (sql, params) => pick(sql, params) || { rows: [] });
    const client = {
      query: vi.fn(async (sql, params) => {
        statements.push([sql, params]);
        if (/INSERT INTO email_accounts/.test(sql)) return { rows: [{ id: 'new-1' }] };
        if (/^SELECT \* FROM email_accounts WHERE id = \$1$/.test(sql)) return { rows: [ACCOUNTS[params[0]] || { id: params[0] }] };
        return pick(sql, params) || { rows: [] };
      }),
    };
    mocks.withTransaction.mockReset().mockImplementation(fn => fn(client));
    mocks.jwtVerify.mockReset().mockImplementation(async () => ({ payload: { email: signedInAs, name: 'Maria', email_verified: true } }));
    mocks.imapManager.connectAccount.mockReset().mockResolvedValue(true);
    mocks.imapManager.clearConnectCooldown.mockReset();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.endsWith('/devicecode')) {
        return { ok: true, json: async () => ({ device_code: 'dc', user_code: 'K7QWZP2M', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 }) };
      }
      return { ok: true, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'idt' }) };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const writes = () => statements.filter(([sql]) => /UPDATE email_accounts|INSERT INTO email_accounts/.test(sql));
  const startDevice = (body) => realFetch(`${base}/oauth/microsoft/device`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const poll = async () => (await realFetch(`${base}/oauth/microsoft/device/poll`)).json();

  it('reports a different address and stores nothing', async () => {
    signedInAs = 'someone.else@hotmail.com';
    expect((await startDevice({ accountId: '11111111-1111-4111-8111-111111111111' })).status).toBe(200);
    expect(await poll()).toEqual({ status: 'wrong_account', signedInAs: 'someone.else@hotmail.com', expected: 'Maria.Lopez@outlook.com' });
    expect(writes()).toEqual([]);
    expect(mocks.imapManager.connectAccount).not.toHaveBeenCalled();
    // The flow is over: a second poll has nothing pending.
    expect((await poll()).status).toBe('lost');
  });

  it('updates the account it was started for when the address matches without regard to case', async () => {
    noteRefreshFailure('11111111-1111-4111-8111-111111111111', { code: 'oauth_reauth', detail: 'AADSTS700082: expired' });
    await startDevice({ accountId: '11111111-1111-4111-8111-111111111111' });
    // The address as stored on the account, not the casing the person signed in with.
    expect(await poll()).toEqual({ status: 'checking', accountId: '11111111-1111-4111-8111-111111111111', email: 'Maria.Lopez@outlook.com' });
    expect(await poll()).toEqual({ status: 'success', accountId: '11111111-1111-4111-8111-111111111111', email: 'Maria.Lopez@outlook.com', connection: 'connected' });

    const [sql, params] = writes()[0];
    expect(writes()).toHaveLength(1);
    expect(sql).toMatch(/^\s*UPDATE email_accounts SET/);
    expect(sql).toMatch(/sync_error = NULL, sync_error_code = NULL/);
    expect(params[5]).toBe('11111111-1111-4111-8111-111111111111');
    // A new sign-in replaces the tokens whose refresh failed.
    expect(refreshFailureFor('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(mocks.imapManager.connectAccount).toHaveBeenCalledWith(ACCOUNTS['11111111-1111-4111-8111-111111111111']);
  });

  it('signs a repair in through the client the account was connected with', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'organizations';
    await startDevice({ accountId: '11111111-1111-4111-8111-111111111111' });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode');
    expect(init.body.get('client_id')).toBe('builtin-app-id');
  });

  // A new sign-in names its kind; personal accounts on an instance whose own app is limited to
  // work accounts go through the shared app (#674).
  it.each([
    ['personal', 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', 'builtin-app-id'],
    ['work', 'https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode', 'own-app-id'],
  ])('a %s sign-in uses the app for that kind', async (kind, url, clientId) => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'organizations';
    expect((await startDevice({ kind })).status).toBe(200);
    const [calledUrl, init] = globalThis.fetch.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(init.body.get('client_id')).toBe(clientId);
  });

  // The own app's tenant changed to organizations after these accounts were connected.
  it.each([
    ['a personal account goes to the shared app', '55555555-5555-4555-8555-555555555555', 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', 'builtin-app-id'],
    ['a work account keeps the tenant it was connected with', '66666666-6666-4666-8666-666666666666', 'https://login.microsoftonline.com/contoso.example/oauth2/v2.0/devicecode', 'own-app-id'],
  ])('repair after the own app\'s tenant changed: %s', async (_label, id, url, clientId) => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'organizations';
    expect((await startDevice({ accountId: id })).status).toBe(200);
    const [calledUrl, init] = globalThis.fetch.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(init.body.get('client_id')).toBe(clientId);
  });

  it('a repair of an account with no recorded client picks the app by the kind of address', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'organizations';
    const id = '11111111-1111-4111-8111-111111111111';
    const before = ACCOUNTS[id].oauth_client_id;
    ACCOUNTS[id].oauth_client_id = null;
    try {
      await startDevice({ accountId: id });
      expect(globalThis.fetch.mock.calls[0][1].body.get('client_id')).toBe('builtin-app-id');
    } finally {
      ACCOUNTS[id].oauth_client_id = before;
    }
  });

  it.each([
    ['something that is not an account id', 'nope'],
    ['a missing account', '44444444-4444-4444-8444-444444444444'],
    ['an account on another provider', '22222222-2222-4222-8222-222222222222'],
    ['a password account', '33333333-3333-4333-8333-333333333333'],
  ])('refuses to start a repair for %s', async (_label, accountId) => {
    const res = await startDevice({ accountId });
    expect(res.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('still adds or updates by address when no account is named', async () => {
    signedInAs = 'new.person@outlook.com';
    await startDevice({});
    expect((await poll()).status).toBe('checking');
    expect(writes().some(([sql]) => /INSERT INTO email_accounts/.test(sql))).toBe(true);
  });

  it('carries a repair through the Google redirect and refuses a different address', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://mail.example/oauth/google/callback';
    const start = await realFetch(`${base}/oauth/google?accountId=22222222-2222-4222-8222-222222222222`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(session.oauthRepairAccountId).toBe('22222222-2222-4222-8222-222222222222');

    signedInAs = 'other@gmail.com';
    const cb = await realFetch(`${base}/oauth/google/callback?code=c&state=${session.oauthNonce}`, { redirect: 'manual' });
    // The addresses stay out of the URL (access logs, history); the page fetches them once.
    expect(cb.headers.get('location')).toBe('/?oauth_error=wrong_account&oauth_result=1');
    expect(await (await realFetch(`${base}/oauth/result`)).json()).toEqual({
      result: { error: 'wrong_account', signedInAs: 'other@gmail.com', expected: 'maria@gmail.com' },
    });
    expect(await (await realFetch(`${base}/oauth/result`)).json()).toEqual({ result: null });
    expect(writes()).toEqual([]);
    expect(session.oauthRepairAccountId).toBeUndefined();
  });

  // After Microsoft approves, the page shows "checking" and the next poll answers with how
  // the first connection went (#674).
  it('reports a mailbox that refuses the first connection, with its recorded error', async () => {
    signedInAs = 'new.person@outlook.com';
    mocks.imapManager.connectAccount.mockResolvedValue(false);
    mocks.query.mockImplementation(async (sql, params) => (/SELECT sync_error, sync_error_code/.test(sql)
      ? { rows: [{ sync_error: 'User is authenticated but not connected.', sync_error_code: 'ms_imap_disabled_personal' }] }
      : pick(sql, params) || { rows: [] }));
    await startDevice({});
    expect((await poll()).status).toBe('checking');
    expect(await poll()).toEqual({
      status: 'success', accountId: 'new-1', email: 'new.person@outlook.com',
      connection: 'failed', code: 'ms_imap_disabled_personal', error: 'User is authenticated but not connected.',
    });
    // The flow is finished.
    expect((await poll()).status).toBe('lost');
  });

  // Pending flows live in memory: after a restart the page must not claim the sign-in failed.
  it('answers "lost" when nothing is pending, not an error', async () => {
    expect(await poll()).toEqual({ status: 'lost' });
  });

  it('a poll that comes after the wait ended reports the connection as it is now', async () => {
    signedInAs = 'new.person@outlook.com';
    let live = false;
    mocks.imapManager.isConnected = vi.fn(() => live);
    mocks.imapManager.connectAccount.mockResolvedValue(false); // ended without an error to show
    try {
      await startDevice({});
      expect((await poll()).status).toBe('checking');
      await new Promise(r => setTimeout(r, 30));
      live = true; // connected since, on a later attempt
      expect(await poll()).toMatchObject({ status: 'success', connection: 'connected' });
    } finally {
      delete mocks.imapManager.isConnected;
    }
  });

  it('a new sign-in started while the tokens are stored is not overwritten by the old one', async () => {
    signedInAs = 'new.person@outlook.com';
    let release;
    mocks.withTransaction.mockImplementationOnce(async (fn) => {
      await new Promise(r => { release = r; });
      return mocks.withTransaction.getMockImplementation()(fn);
    });
    await startDevice({});
    const first = poll();
    await new Promise(r => setTimeout(r, 30));
    // While the first is storing, a concurrent poll waits instead of redeeming the code again.
    expect(await poll()).toEqual({ status: 'pending' });
    await startDevice({}); // a fresh sign-in replaces the pending one
    release();
    expect((await first).status).toBe('checking');
    // The fresh flow is still the one pending: its poll asks Microsoft, it is not 'checking'.
    const calls = globalThis.fetch.mock.calls.length;
    await poll();
    expect(globalThis.fetch.mock.calls.length).toBe(calls + 1);
  });

  it('reports connected as soon as the login is live, while the first sync is still running', async () => {
    signedInAs = 'new.person@outlook.com';
    mocks.imapManager.connectAccount.mockReturnValue(new Promise(() => {}));
    mocks.imapManager.isConnected = vi.fn(() => true);
    try {
      await startDevice({});
      await poll();
      expect(await poll()).toMatchObject({ status: 'success', connection: 'connected' });
    } finally {
      delete mocks.imapManager.isConnected;
    }
  });

  it('a Google sign-in reports the first connection through the session, with the stored address', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://mail.example/oauth/google/callback';
    mocks.imapManager.connectAccount.mockResolvedValue(false);
    mocks.query.mockImplementation(async (sql, params) => (/SELECT sync_error, sync_error_code/.test(sql)
      ? { rows: [{ sync_error: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)', sync_error_code: 'oauth_reauth' }] }
      : pick(sql, params) || { rows: [] }));
    await realFetch(`${base}/oauth/google?accountId=22222222-2222-4222-8222-222222222222`, { redirect: 'manual' });
    signedInAs = 'MARIA@gmail.com';
    const cb = await realFetch(`${base}/oauth/google/callback?code=c&state=${session.oauthNonce}`, { redirect: 'manual' });
    expect(cb.headers.get('location')).toBe('/?oauth_success=google&oauth_result=1');
    expect(await (await realFetch(`${base}/oauth/result`)).json()).toEqual({
      result: {
        provider: 'google', accountId: '22222222-2222-4222-8222-222222222222', email: 'maria@gmail.com',
        connection: 'failed', code: 'oauth_reauth', error: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)',
      },
    });
  });

  it('refuses to start a repair of another user\'s account, as one that does not exist', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    process.env.GOOGLE_REDIRECT_URI = 'https://mail.example/oauth/google/callback';
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'common';
    process.env.MS_REDIRECT_URI = 'https://mail.example/oauth/microsoft/callback';
    const device = await startDevice({ accountId: '77777777-7777-4777-8777-777777777777' });
    expect(device.status).toBe(404);
    expect(await device.json()).toEqual({ error: 'Account not found' });
    for (const url of [
      `${base}/oauth/microsoft?accountId=77777777-7777-4777-8777-777777777777`,
      `${base}/oauth/google?accountId=88888888-8888-4888-8888-888888888888`,
    ]) {
      const res = await realFetch(url, { redirect: 'manual' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Account not found' });
    }
    expect(session.oauthRepairAccountId).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses a repair whose account is no longer the user\'s by the time the sign-in ends', async () => {
    await startDevice({ accountId: '11111111-1111-4111-8111-111111111111' });
    const account = ACCOUNTS['11111111-1111-4111-8111-111111111111'];
    account.user_id = 'user-2';
    try {
      expect(await poll()).toEqual({ status: 'error', error: 'Account not found' });
    } finally {
      account.user_id = 'user-1';
    }
    expect(writes()).toEqual([]);
    expect(mocks.imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('refuses a Google repair whose account is no longer the user\'s by the callback', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://mail.example/oauth/google/callback';
    await realFetch(`${base}/oauth/google?accountId=22222222-2222-4222-8222-222222222222`, { redirect: 'manual' });
    const account = ACCOUNTS['22222222-2222-4222-8222-222222222222'];
    account.user_id = 'user-2';
    let cb;
    try {
      cb = await realFetch(`${base}/oauth/google/callback?code=c&state=${session.oauthNonce}`, { redirect: 'manual' });
    } finally {
      account.user_id = 'user-1';
    }
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/?oauth_error=Authentication+failed');
    expect(writes()).toEqual([]);
    expect(mocks.imapManager.connectAccount).not.toHaveBeenCalled();
  });

  // The re-check runs on the sign-in's transaction client, under its advisory lock, not on the pool.
  const txOwnershipCheck = (id) => statements.filter(([sql, params]) =>
    /FROM email_accounts WHERE id = \$1 AND user_id = \$2/.test(sql) && params[0] === id && params[1] === 'user-1');

  it('re-checks a Google repair\'s account inside the sign-in transaction', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://mail.example/oauth/google/callback';
    await realFetch(`${base}/oauth/google?accountId=22222222-2222-4222-8222-222222222222`, { redirect: 'manual' });
    signedInAs = 'maria@gmail.com';
    const cb = await realFetch(`${base}/oauth/google/callback?code=c&state=${session.oauthNonce}`, { redirect: 'manual' });
    expect(cb.headers.get('location')).toBe('/?oauth_success=google&oauth_result=1');
    const [[sql]] = txOwnershipCheck('22222222-2222-4222-8222-222222222222');
    expect(sql).toBe('SELECT id, email_address FROM email_accounts WHERE id = $1 AND user_id = $2');
  });

  it('re-checks a Microsoft repair\'s account inside the sign-in transaction', async () => {
    await startDevice({ accountId: '11111111-1111-4111-8111-111111111111' });
    expect((await poll()).status).toBe('checking');
    const [[sql]] = txOwnershipCheck('11111111-1111-4111-8111-111111111111');
    expect(sql).toBe('SELECT id, imap_host, oauth_provider, email_address FROM email_accounts WHERE id = $1 AND user_id = $2');
  });

  it('carries a repair through the Microsoft redirect', async () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_CLIENT_SECRET = 'secret';
    process.env.MS_REDIRECT_URI = 'https://mail.example/oauth/microsoft/callback';
    await realFetch(`${base}/oauth/microsoft?accountId=11111111-1111-4111-8111-111111111111`, { redirect: 'manual' });
    expect(session.oauthRepairAccountId).toBe('11111111-1111-4111-8111-111111111111');
    const cb = await realFetch(`${base}/oauth/microsoft/callback?code=c&state=${session.oauthNonce}`, { redirect: 'manual' });
    // Back to the page with only a short code; how the first connection went is fetched once.
    expect(cb.headers.get('location')).toBe('/?oauth_success=microsoft&oauth_result=1');
    expect(await (await realFetch(`${base}/oauth/result`)).json()).toEqual({
      result: { provider: 'microsoft', accountId: '11111111-1111-4111-8111-111111111111', email: 'Maria.Lopez@outlook.com', connection: 'connected' },
    });
    expect(writes()[0][1][5]).toBe('11111111-1111-4111-8111-111111111111');
  });
});
