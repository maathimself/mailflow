import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The second step of signing in (services/secondFactor.js), end to end through the real routes:
// password login and single sign-on decide the step, and each completion endpoint accepts only
// its own. GHSA-v67x-j275-jpxj / GHSA-mwj9-qc6h-h734: an account with an authenticator could be
// signed in with a code emailed to its recovery address. GHSA-48gw-3xw6-9v67: single sign-on
// skipped the user's authenticator and the admin's 2FA policy.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() }, withTransaction: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: { connectAllForUser: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v, isEncrypted: () => false }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 1000, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn(), SystemEmailNotConfigured: class SystemEmailNotConfigured extends Error {} }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../services/kvStore.js', () => ({ kv: { set: vi.fn(async () => 'OK') } }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })), reset: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('jose', async (importOriginal) => ({ ...(await importOriginal()), jwtVerify: vi.fn() }));

import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { authenticator } from 'otplib';
import { jwtVerify } from 'jose';
import { query, pool } from '../services/db.js';
import { sendSystemEmail, SystemEmailNotConfigured } from '../services/mailer.js';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import authRoutes from './auth.js';
import { issueSignInCode } from '../services/signInCodes.js';
import { oidcBrowserRouter } from './oidc.js';

const realFetch = global.fetch;
const issuer = 'https://idp.example.com';
const SECRET = authenticator.generateSecret(20);
const PASSWORD = 'correct horse battery';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const discoveryDoc = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
};

let server, base, user, settings, provider, otpHashes;

function settingRows(sql) {
  const keys = sql.includes(' IN (')
    ? [...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    : [sql.match(/key = '([a-z_]+)'/)?.[1]];
  return keys.filter(k => settings[k] !== undefined).map(k => ({ key: k, value: settings[k] }));
}

function db(sql, params = []) {
  if (sql.includes('FROM system_settings')) return { rows: settingRows(sql) };
  if (sql.includes('FROM oidc_providers')) return { rows: [provider] };
  if (/FROM users WHERE (username|id) = \$1/.test(sql)) {
    const hit = params[0] === user.id || params[0] === user.username;
    return { rows: hit ? [user] : [] };
  }
  if (sql.startsWith('UPDATE users SET totp_secret')) {
    if (user.totp_enabled) return { rows: [] };
    Object.assign(user, { totp_secret: params[0], totp_enabled: true });
    return { rows: [{ id: user.id }] };
  }
  if (sql.startsWith('DELETE FROM email_otp_tokens')) { otpHashes = []; return { rows: [] }; }
  if (sql.startsWith('INSERT INTO email_otp_tokens')) { otpHashes.push(params[1]); return { rows: [] }; }
  if (sql.includes('FROM email_otp_tokens')) return { rows: otpHashes.includes(params[1]) ? [{ id: 'otp-1' }] : [] };
  if (sql.includes('FROM user_identities WHERE issuer')) return { rows: [{ user_id: user.id }] };
  return { rows: [] };
}

beforeAll(async () => {
  process.env.APP_URL = 'https://mail.example.com';
  global.fetch = vi.fn(async (url) => {
    if (String(url) === `${issuer}/.well-known/openid-configuration`) return { ok: true, status: 200, json: async () => discoveryDoc };
    if (String(url) === `${issuer}/token`) return { ok: true, status: 200, json: async () => ({ id_token: 'id-token-1' }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const app = express();
  app.use(express.json());
  app.use(session(buildSessionOptions(new session.MemoryStore(), 'test-secret-'.padEnd(40, 'x'))));
  app.get('/session', (req, res) => res.json({
    userId: req.session.userId ?? null,
    pendingUserId: req.session.pendingUserId ?? null,
    pendingSecondFactor: req.session.pendingSecondFactor ?? null,
    oidcProviderId: req.session.oidcProviderId ?? null,
    oidcIdToken: req.session.oidcIdToken ?? null,
    oidcPending: req.session.oidcPending ?? null,
  }));
  app.use('/api/auth', authRoutes);
  app.use('/auth/oidc', oidcBrowserRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  global.fetch = realFetch;
  delete process.env.APP_URL;
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

beforeEach(() => {
  vi.clearAllMocks();
  user = {
    id: 'u1', username: 'alice', password_hash: PASSWORD_HASH, is_admin: false,
    totp_enabled: false, totp_secret: null, recovery_email: 'alice@example.net',
    display_name: 'Alice', avatar: null,
  };
  settings = {};
  provider = {
    id: 'p1', slug: 'idp', issuer_url: issuer, client_id: 'mailflow', client_secret: 'secret',
    allow_insecure: false, enabled: true, provisioning_mode: 'login_existing_only', idp_enforces_mfa: false,
  };
  otpHashes = [];
  query.mockReset().mockImplementation(async (sql, params) => db(sql, params));
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => db(sql, params)),
    release: vi.fn(),
  }));
  jwtVerify.mockReset();
});

// A browser: keeps the session cookie across requests, including a regenerated one.
function browser() {
  let cookie = '';
  const send = async (method, path, body) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-requested-with': 'XMLHttpRequest' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a redirect */ }
    return { status: res.status, json, location: res.headers.get('location') };
  };
  return {
    get: path => send('GET', path),
    post: (path, body) => send('POST', path, body ?? {}),
    session: async () => (await send('GET', '/session')).json,
  };
}

const emailedCode = () => sendSystemEmail.mock.calls.at(-1)?.[0].text.match(/code is: (\d{6})/)[1];
const withAuthenticator = () => Object.assign(user, { totp_enabled: true, totp_secret: SECRET });

describe('password sign-in: an emailed code never replaces the authenticator', () => {
  it('an account with an authenticator is asked for it, and the email-code endpoints refuse', async () => {
    withAuthenticator();
    const b = browser();
    expect((await b.post('/api/auth/login', { username: 'alice', password: PASSWORD })).json).toMatchObject({ requiresTOTP: true });

    const send = await b.post('/api/auth/2fa/send-email-otp');
    expect(send.status).toBe(400);
    expect(sendSystemEmail).not.toHaveBeenCalled();
    // Even a code that would be valid is refused for this sign-in.
    otpHashes.push(crypto.createHash('sha256').update('123456').digest('hex'));
    const verify = await b.post('/api/auth/2fa/verify-email-otp', { code: '123456' });
    expect(verify.status).toBe(400);
    expect((await b.session()).userId).toBe(null);

    const ok = await b.post('/api/auth/2fa/challenge', { code: authenticator.generate(SECRET) });
    expect(ok.status).toBe(200);
    expect((await b.session()).userId).toBe('u1');
  });

  it('with 2FA required and no authenticator, only the emailed code completes the sign-in', async () => {
    settings.mfa_enforcement = 'required';
    const b = browser();
    expect((await b.post('/api/auth/login', { username: 'alice', password: PASSWORD })).json)
      .toMatchObject({ requiresEmailOTP: true, emailHint: 'a***e@example.net' });
    const code = emailedCode();

    expect((await b.post('/api/auth/2fa/challenge', { code: '000000' })).status).toBe(400);
    expect((await b.get('/api/auth/2fa/enrollment/setup')).status).toBe(400);
    const ok = await b.post('/api/auth/2fa/verify-email-otp', { code });
    expect(ok.status).toBe(200);
    expect((await b.session()).userId).toBe('u1');
  });

  it('when the code cannot be emailed, the sign-in fails closed: it waits for a code, and one an admin issues completes it', async () => {
    settings.mfa_enforcement = 'required';
    // The admin may issue the code before the user tries: a failed send and a failed resend
    // leave it working.
    const { code } = await issueSignInCode(user.id); // what src/cli/authRecovery.js sign-in-code does
    sendSystemEmail.mockRejectedValueOnce(new Error('SMTP down'));
    const b = browser();
    expect((await b.post('/api/auth/login', { username: 'alice', password: PASSWORD })).json)
      .toMatchObject({ requiresEmailOTP: true, emailSendFailed: true });
    // Never the authenticator setup that whoever has the password could finish.
    expect((await b.get('/api/auth/2fa/enrollment/setup')).status).toBe(400);
    expect((await b.get('/api/auth/2fa/pending')).json).toMatchObject({ step: 'email', emailSendFailed: true });
    sendSystemEmail.mockRejectedValueOnce(new Error('SMTP down'));
    expect((await b.post('/api/auth/2fa/send-email-otp')).status).toBe(503);
    expect((await b.session()).userId).toBe(null);

    expect((await b.post('/api/auth/2fa/verify-email-otp', { code })).status).toBe(200);
    expect((await b.session()).userId).toBe('u1');
  });

  it('with 2FA required and no system email configured at all, the user sets up an authenticator', async () => {
    settings.mfa_enforcement = 'required';
    sendSystemEmail.mockRejectedValueOnce(new SystemEmailNotConfigured());
    const b = browser();
    expect((await b.post('/api/auth/login', { username: 'alice', password: PASSWORD })).json).toMatchObject({ requiresMFAEnrollment: true });
    expect((await b.get('/api/auth/2fa/enrollment/setup')).status).toBe(200);
  });

  it('with 2FA required and no recovery email, the user sets up an authenticator and nothing else', async () => {
    settings.mfa_enforcement = 'required';
    user.recovery_email = null;
    const b = browser();
    expect((await b.post('/api/auth/login', { username: 'alice', password: PASSWORD })).json).toMatchObject({ requiresMFAEnrollment: true });
    expect((await b.post('/api/auth/2fa/send-email-otp')).status).toBe(400);
    expect((await b.post('/api/auth/2fa/verify-email-otp', { code: '123456' })).status).toBe(400);
    expect((await b.get('/api/auth/2fa/enrollment/setup')).status).toBe(200);
  });

  it('enrollment sets up an authenticator, but never replaces one the owner turned on meanwhile', async () => {
    settings.mfa_enforcement = 'required';
    user.recovery_email = null;
    const b = browser();
    await b.post('/api/auth/login', { username: 'alice', password: PASSWORD });
    const { secret } = (await b.get('/api/auth/2fa/enrollment/setup')).json;
    expect((await b.post('/api/auth/2fa/enrollment/enable', { code: authenticator.generate(secret) })).status).toBe(200);
    expect(await b.session()).toMatchObject({ userId: 'u1' });

    Object.assign(user, { totp_enabled: false, totp_secret: null });
    const other = browser();
    await other.post('/api/auth/login', { username: 'alice', password: PASSWORD });
    const pending = (await other.get('/api/auth/2fa/enrollment/setup')).json;
    withAuthenticator(); // the owner turns one on in another session
    expect((await other.post('/api/auth/2fa/enrollment/enable', { code: authenticator.generate(pending.secret) })).status).toBe(401);
    expect(user.totp_secret).toBe(SECRET);
    expect((await other.session()).userId).toBe(null);
  });

  it('GET /2fa/pending names the step without anything secret', async () => {
    const b = browser();
    expect((await b.get('/api/auth/2fa/pending')).json).toEqual({ step: null });
    settings.mfa_enforcement = 'required';
    await b.post('/api/auth/login', { username: 'alice', password: PASSWORD });
    expect((await b.get('/api/auth/2fa/pending')).json).toEqual({ step: 'email', deviceTrustAvailable: true, emailHint: 'a***e@example.net' });
  });
});

// Signs in through the provider and returns the callback's redirect.
async function ssoSignIn(b) {
  await b.get('/auth/oidc/idp/start');
  const { oidcPending } = await b.session();
  jwtVerify.mockResolvedValue({ payload: { iss: issuer, sub: 'idp-alice', nonce: oidcPending.nonce, email: 'alice@example.net', email_verified: true } });
  return (await b.get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`)).location;
}

describe('single sign-on takes the same second step', () => {
  it('with nothing to ask, it signs in as before', async () => {
    const b = browser();
    expect(await ssoSignIn(b)).toBe('/?oidc_success=login');
    expect(await b.session()).toMatchObject({ userId: 'u1', oidcProviderId: 'p1' });
  });

  it('asks for the user\'s authenticator, then signs in with the provider kept for SSO logout', async () => {
    withAuthenticator();
    const b = browser();
    expect(await ssoSignIn(b)).toBe('/login?oidc_mfa=1');
    expect(await b.session()).toMatchObject({ userId: null, pendingUserId: 'u1', pendingSecondFactor: 'totp', oidcProviderId: null });
    expect((await b.get('/api/auth/2fa/pending')).json).toMatchObject({ step: 'totp' });
    expect((await b.post('/api/auth/2fa/send-email-otp')).status).toBe(400);

    const ok = await b.post('/api/auth/2fa/challenge', { code: authenticator.generate(SECRET) });
    expect(ok.status).toBe(200);
    expect(await b.session()).toMatchObject({ userId: 'u1', pendingUserId: null, oidcProviderId: 'p1', oidcIdToken: 'id-token-1' });
  });

  it('applies the admin\'s "2FA required" policy while password sign-in is on', async () => {
    settings.mfa_enforcement = 'required';
    const b = browser();
    expect(await ssoSignIn(b)).toBe('/login?oidc_mfa=1');
    expect((await b.get('/api/auth/2fa/pending')).json).toMatchObject({ step: 'email' });
    expect((await b.post('/api/auth/2fa/verify-email-otp', { code: emailedCode() })).status).toBe(200);
    expect(await b.session()).toMatchObject({ userId: 'u1', oidcProviderId: 'p1' });
  });

  it('not the policy once password sign-in is off (Settings shows it as not applicable), but still the user\'s authenticator', async () => {
    settings.mfa_enforcement = 'required';
    settings.internal_auth_disabled = 'true';
    const b = browser();
    expect(await ssoSignIn(b)).toBe('/?oidc_success=login');
    withAuthenticator();
    expect(await ssoSignIn(browser())).toBe('/login?oidc_mfa=1');
  });

  it('a provider marked as enforcing MFA skips both', async () => {
    provider.idp_enforces_mfa = true;
    settings.mfa_enforcement = 'required';
    withAuthenticator();
    const b = browser();
    expect(await ssoSignIn(b)).toBe('/?oidc_success=login');
    expect((await b.session()).userId).toBe('u1');
  });
});
