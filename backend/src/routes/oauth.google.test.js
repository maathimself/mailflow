import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

// oauth.js imports imapManager from ../index.js (heavy load-time side effects).
vi.mock('../index.js', () => ({
  imapManager: {
    connectAccount: vi.fn(async () => true),
    disconnectAccount: vi.fn(async () => {}),
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  decrypt: (v) => v,
}));

// In-memory Redis so the real single-use state store runs end to end.
const redisStore = vi.hoisted(() => new Map());
vi.mock('../services/redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value) => { redisStore.set(key, value); return 'OK'; }),
    getDel: vi.fn(async (key) => {
      const value = redisStore.get(key) ?? null;
      redisStore.delete(key);
      return value;
    }),
  },
}));

// Keep the real URL builder and config checks; replace only the network-bound calls.
vi.mock('../services/oauth/googleOAuth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exchangeGoogleCode: vi.fn(), verifyGoogleIdToken: vi.fn() };
});

import express from 'express';
import oauthRoutes from './oauth.js';
import { imapManager } from '../index.js';
import { withTransaction } from '../services/db.js';
import { exchangeGoogleCode, verifyGoogleIdToken, GoogleOAuthError } from '../services/oauth/googleOAuth.js';

const CLIENT_ID = 'cid.apps.googleusercontent.com';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const MAIL_SCOPE = 'https://mail.google.com/';

function buildApp() {
  const app = express();
  // Test-only session: the x-test-user header stands in for the session cookie.
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    req.session = userId ? { userId } : {};
    next();
  });
  app.use('/oauth', oauthRoutes);
  return app;
}

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Transaction client whose SQL is routed by statement type.
let dbState;
function installDb({ existing = null } = {}) {
  dbState = { existing, calls: [] };
  const client = {
    query: vi.fn(async (sql, params) => {
      dbState.calls.push([sql, params]);
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/^\s*SELECT id, oauth_refresh_token FROM email_accounts/.test(sql)) {
        return { rows: dbState.existing ? [dbState.existing] : [] };
      }
      if (/^\s*INSERT INTO email_accounts/.test(sql)) return { rows: [{ id: 'new-acc' }] };
      if (/^\s*UPDATE email_accounts/.test(sql)) return { rows: [], rowCount: 1 };
      if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: params[0], email_address: 'user@gmail.com', oauth_provider: 'google' }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  withTransaction.mockImplementation(async (fn) => fn(client));
}
const sqlCall = (re) => dbState.calls.find(([sql]) => re.test(sql));

const get = (path, { user = USER_ID } = {}) =>
  fetch(`${base}${path}`, { redirect: 'manual', headers: user ? { 'x-test-user': user } : {} });

async function startFlow(query = '') {
  const res = await get(`/oauth/google${query}`);
  const location = new URL(res.headers.get('location'));
  return { res, location, state: location.searchParams.get('state') };
}

let logSpies;
beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
  redisStore.clear();
  exchangeGoogleCode.mockReset();
  verifyGoogleIdToken.mockReset();
  withTransaction.mockReset();
  imapManager.connectAccount.mockClear();
  imapManager.disconnectAccount.mockClear();
  installDb();
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
  logSpies.forEach((s) => s.mockRestore());
});
const loggedText = () => JSON.stringify(logSpies.flatMap((s) => s.mock.calls));

function mockSuccessfulGoogle({ refreshToken = 'refresh-tok', scope = `openid email ${MAIL_SCOPE}`, email = 'user@gmail.com' } = {}) {
  exchangeGoogleCode.mockResolvedValue({
    accessToken: 'access-tok',
    refreshToken,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    scope,
    idToken: 'id-tok',
  });
  verifyGoogleIdToken.mockResolvedValue({ email, name: 'User Name', sub: 'sub-1' });
}

describe('GET /oauth/google', () => {
  it('requires an authenticated MailExpert session', async () => {
    const res = await get('/oauth/google', { user: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
  });

  it('redirects with not_configured when the integration is incomplete', async () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const res = await get('/oauth/google');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?oauth_error=not_configured&oauth_provider=google');
  });

  it('stores state + PKCE verifier server-side and redirects to Google with the challenge only', async () => {
    const { res, location, state } = await startFlow('?login_hint=user%40gmail.com');
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = location.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(`openid email profile ${MAIL_SCOPE}`);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('login_hint')).toBe('user@gmail.com');
    expect(state).toBeTruthy();

    expect(redisStore.size).toBe(1);
    const saved = JSON.parse([...redisStore.values()][0]);
    expect(saved).toMatchObject({ userId: USER_ID, loginHint: 'user@gmail.com' });
    expect(p.get('code_challenge')).toBe(createHash('sha256').update(saved.codeVerifier).digest('base64url'));
    expect(location.toString()).not.toContain(saved.codeVerifier);
    expect(location.toString()).not.toContain(CLIENT_SECRET);
  });

  it('ignores a malformed login_hint', async () => {
    const { location } = await startFlow(`?login_hint=${encodeURIComponent('not an email')}`);
    expect(location.searchParams.has('login_hint')).toBe(false);
  });
});

describe('GET /oauth/google/callback', () => {
  const callback = (params, opts) => get(`/oauth/google/callback?${new URLSearchParams(params)}`, opts);
  const errorLocation = (code) => `/?oauth_error=${code}&oauth_provider=google`;

  it('creates a Gmail account with fixed hosts, encrypted tokens and unified inbox off', async () => {
    mockSuccessfulGoogle();
    const { state } = await startFlow();
    const saved = JSON.parse([...redisStore.values()][0]);

    const res = await callback({ code: 'auth-code-xyz', state });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=created');
    expect(exchangeGoogleCode).toHaveBeenCalledWith({ code: 'auth-code-xyz', codeVerifier: saved.codeVerifier, redirectUri: REDIRECT_URI });
    expect(verifyGoogleIdToken).toHaveBeenCalledWith({ idToken: 'id-tok', clientId: CLIENT_ID });

    const lock = sqlCall(/pg_advisory_xact_lock/);
    expect(lock[0]).toMatch(/hashtext\(\$1\)/);
    expect(lock[1]).toEqual([`oauth-account:${USER_ID}:user@gmail.com`]);

    const [insertSql, insertParams] = sqlCall(/^\s*INSERT INTO email_accounts/);
    expect(insertSql).toMatch(/'imap\.gmail\.com', 993, true/);
    expect(insertSql).toMatch(/'smtp\.gmail\.com', 465, 'SSL'/);
    expect(insertSql).toMatch(/'google'/);
    expect(insertSql).toMatch(/include_in_unified_inbox/);
    expect(insertSql).toMatch(/false\)\s*RETURNING id/);
    expect(insertParams).toContain('enc(access-tok)');
    expect(insertParams).toContain('enc(refresh-tok)');
    expect(insertParams).not.toContain('access-tok');
    expect(insertParams).not.toContain('refresh-tok');

    expect(imapManager.connectAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-acc' }));
  });

  it('updates an existing account, keeps the stored refresh token and clears the reconnect flag', async () => {
    installDb({ existing: { id: 'acc-1', oauth_refresh_token: 'enc(old-refresh)' } });
    mockSuccessfulGoogle({ refreshToken: null, email: 'User@Gmail.com' });
    const { state } = await startFlow();

    const res = await callback({ code: 'c', state });

    expect(res.headers.get('location')).toBe('/?oauth_success=google&oauth_result=updated');
    const lock = sqlCall(/pg_advisory_xact_lock/);
    expect(lock[1]).toEqual([`oauth-account:${USER_ID}:user@gmail.com`]);
    expect(sqlCall(/^\s*SELECT id, oauth_refresh_token FROM email_accounts/)[0]).toMatch(/lower\(email_address\) = lower\(\$2\)/);
    const [updateSql, updateParams] = sqlCall(/^\s*UPDATE email_accounts/);
    expect(updateSql).toMatch(/oauth_refresh_token = COALESCE\(\$2, oauth_refresh_token\)/);
    expect(updateSql).toMatch(/oauth_reconnect_required = false/);
    expect(updateSql).toMatch(/sync_error = NULL/);
    expect(updateSql).toMatch(/oauth_provider = 'google'/);
    expect(updateParams[0]).toBe('enc(access-tok)');
    expect(updateParams[1]).toBeNull();
    expect(sqlCall(/^\s*INSERT INTO email_accounts/)).toBeUndefined();
  });

  it('rejects a new account when Google returned no refresh token', async () => {
    mockSuccessfulGoogle({ refreshToken: null });
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*INSERT INTO email_accounts/)).toBeUndefined();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('rejects an existing account without any refresh token to keep', async () => {
    installDb({ existing: { id: 'acc-1', oauth_refresh_token: null } });
    mockSuccessfulGoogle({ refreshToken: null });
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('missing_refresh_token'));
    expect(sqlCall(/^\s*UPDATE email_accounts/)).toBeUndefined();
  });

  it('maps a user cancellation to access_denied and burns the state', async () => {
    const { state } = await startFlow();
    const res = await callback({ error: 'access_denied', state });
    expect(res.headers.get('location')).toBe(errorLocation('access_denied'));
    expect(redisStore.size).toBe(0);
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('maps any other provider error to authentication_failed without echoing it', async () => {
    const { state } = await startFlow();
    const res = await callback({ error: 'server_error<script>', error_description: 'raw google text', state });
    const location = res.headers.get('location');
    expect(location).toBe(errorLocation('authentication_failed'));
    expect(loggedText()).not.toMatch(/raw google text|server_error<script>/);
  });

  it.each([
    ['missing', {}],
    ['unknown', { state: 'A'.repeat(43) }],
    ['malformed', { state: 'nope' }],
  ])('rejects a %s state with invalid_state', async (_label, params) => {
    const res = await callback({ code: 'c', ...params });
    expect(res.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('accepts a state only once', async () => {
    mockSuccessfulGoogle();
    const { state } = await startFlow();
    expect((await callback({ code: 'c', state })).headers.get('location')).toMatch(/oauth_success=google/);
    const replay = await callback({ code: 'c', state });
    expect(replay.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).toHaveBeenCalledTimes(1);
  });

  it('rejects a state issued to a different MailExpert user', async () => {
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state }, { user: '22222222-2222-2222-2222-222222222222' });
    expect(res.headers.get('location')).toBe(errorLocation('invalid_state'));
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('redirects with not_configured when the integration was removed mid-flow', async () => {
    const { state } = await startFlow();
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('not_configured'));
  });

  it('maps a failed code exchange to authentication_failed without leaking the code', async () => {
    exchangeGoogleCode.mockRejectedValue(new GoogleOAuthError('authentication_failed', { oauthError: 'invalid_grant' }));
    const { state } = await startFlow();
    const res = await callback({ code: 'secret-auth-code', state });
    expect(res.headers.get('location')).toBe(errorLocation('authentication_failed'));
    expect(loggedText()).not.toMatch(/secret-auth-code|client-secret-value/);
  });

  it('maps an unexpected exception to authentication_failed without logging its message', async () => {
    exchangeGoogleCode.mockRejectedValue(new Error('boom access-tok refresh-tok'));
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('authentication_failed'));
    expect(loggedText()).not.toMatch(/access-tok|refresh-tok/);
  });

  it('requires the full Gmail scope', async () => {
    mockSuccessfulGoogle({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' });
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('scope_missing'));
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unverified Google email', async () => {
    mockSuccessfulGoogle();
    verifyGoogleIdToken.mockRejectedValue(new GoogleOAuthError('email_not_verified'));
    const { state } = await startFlow();
    const res = await callback({ code: 'c', state });
    expect(res.headers.get('location')).toBe(errorLocation('email_not_verified'));
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('never logs tokens, codes, verifiers or the client secret across the success path', async () => {
    mockSuccessfulGoogle();
    const { state } = await startFlow();
    const saved = JSON.parse([...redisStore.values()][0]);
    await callback({ code: 'auth-code-xyz', state });
    const logged = loggedText();
    for (const secret of ['auth-code-xyz', 'access-tok', 'refresh-tok', 'id-tok', CLIENT_SECRET, saved.codeVerifier, state]) {
      expect(logged).not.toContain(secret);
    }
  });
});
