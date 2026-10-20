import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Creating an API token needs a recent sign-in through single sign-on when the account cannot sign
// in with a password (#617). action=reauth has the provider vouch again for the signed-in user
// without signing them in again, and an SSO sign-in counts too.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: { connectAllForUser: vi.fn() } }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));
// Token signatures are not what is under test here.
vi.mock('jose', async (importOriginal) => ({ ...(await importOriginal()), jwtVerify: vi.fn() }));

import express from 'express';
import session from 'express-session';
import { jwtVerify } from 'jose';
import { query, pool } from '../services/db.js';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import { oidcBrowserRouter } from './oidc.js';

const realFetch = global.fetch;
const issuer = 'https://idp.example.com';
const provider = {
  id: 'p1', slug: 'idp', issuer_url: issuer, client_id: 'mailflow', client_secret: 'secret',
  allow_insecure: false, enabled: true, provisioning_mode: 'login_existing_only',
};
const discoveryDoc = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
};

let server, base, clientQueries, identityOwner;

beforeAll(async () => {
  process.env.APP_URL = 'https://mail.example.com';
  global.fetch = vi.fn(async (url) => {
    if (String(url) === `${issuer}/.well-known/openid-configuration`) return { ok: true, status: 200, json: async () => discoveryDoc };
    if (String(url) === `${issuer}/token`) return { ok: true, status: 200, json: async () => ({ id_token: 'id-token' }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const app = express();
  app.use(session(buildSessionOptions(new session.MemoryStore(), 'test-secret-'.padEnd(40, 'x'))));
  app.post('/seed', express.json(), (req, res) => { Object.assign(req.session, req.body); res.end(); });
  app.get('/session', (req, res) => res.json({
    id: req.sessionID,
    userId: req.session.userId ?? null,
    oidcConfirmedAt: req.session.oidcConfirmedAt ?? null,
    oidcConfirmedProviderId: req.session.oidcConfirmedProviderId ?? null,
    oidcPending: req.session.oidcPending ?? null,
  }));
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
  clientQueries = [];
  identityOwner = 'u1';
  query.mockReset().mockImplementation(async (sql) => ({ rows: sql.includes('FROM oidc_providers') ? [provider] : [] }));
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql.includes('FROM oidc_providers')) return { rows: [provider] };
      if (sql.includes('SELECT user_id FROM user_identities')) return { rows: identityOwner ? [{ user_id: identityOwner }] : [] };
      if (sql.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', username: 'owner@example.com', is_admin: false }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  }));
  jwtVerify.mockReset();
});

async function sessionWith(state) {
  const res = await realFetch(`${base}/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
const get = (path, cookie) => realFetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
const sessionOf = async (cookie) => (await get('/session', cookie)).json();
const errorIn = (location) => decodeURIComponent(location.split('oidc_error=')[1] ?? '');
const verifiedIdToken = (nonce) => ({ payload: { iss: issuer, sub: 'idp-user', nonce, email: 'owner@example.com', email_verified: true } });

// Starts the flow from `cookie`'s session and comes back from the provider.
async function confirmThroughProvider(cookie) {
  const start = await get('/auth/oidc/idp/start?action=reauth', cookie);
  expect(start.headers.get('location').split('?')[0]).toBe(`${issuer}/authorize`);
  const { oidcPending } = await sessionOf(cookie);
  jwtVerify.mockResolvedValue(verifiedIdToken(oidcPending.nonce));
  return get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`, cookie);
}

describe('confirming the signed-in user through single sign-on', () => {
  it('records when the provider vouched for them, and keeps the session as it was', async () => {
    const cookie = await sessionWith({ userId: 'u1' });
    const before = await sessionOf(cookie);
    const startedAt = Date.now();

    const done = await confirmThroughProvider(cookie);

    expect(done.headers.get('location')).toBe('/?oidc_success=reauth');
    const after = await sessionOf(cookie);
    expect(after).toMatchObject({ id: before.id, userId: 'u1', oidcConfirmedProviderId: 'p1', oidcPending: null });
    expect(after.oidcConfirmedAt).toBeGreaterThanOrEqual(startedAt);
    expect(after.oidcConfirmedAt).toBeLessThanOrEqual(Date.now());
    expect(clientQueries.some(q => q.sql.startsWith('UPDATE user_identities SET last_used_at = NOW()'))).toBe(true);
    // Nothing is linked or provisioned on the way.
    expect(clientQueries.some(q => q.sql.includes('INSERT'))).toBe(false);
  });

  it.each([
    ['another account', 'u2'],
    ['no account', null],
  ])('refuses an identity linked to %s, and records nothing', async (_label, owner) => {
    identityOwner = owner;
    const cookie = await sessionWith({ userId: 'u1' });

    const done = await confirmThroughProvider(cookie);

    expect(done.headers.get('location')).toMatch(/^\/\?oidc_error=/);
    expect(errorIn(done.headers.get('location'))).toBe('That sign-in is not linked to your account');
    expect(await sessionOf(cookie)).toMatchObject({ userId: 'u1', oidcConfirmedAt: null, oidcConfirmedProviderId: null });
  });

  it('refuses when the session is no longer the user who started it', async () => {
    const cookie = await sessionWith({ userId: 'u1' });
    await get('/auth/oidc/idp/start?action=reauth', cookie);
    const { oidcPending } = await sessionOf(cookie);
    await realFetch(`${base}/seed`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ userId: 'u2' }) });
    jwtVerify.mockResolvedValue(verifiedIdToken(oidcPending.nonce));

    const done = await get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`, cookie);

    expect(errorIn(done.headers.get('location'))).toBe('That sign-in is not linked to your account');
    expect(await sessionOf(cookie)).toMatchObject({ userId: 'u2', oidcConfirmedAt: null });
  });

  it('needs a signed-in, unlocked session, and reports a refusal inside the app', async () => {
    const signedOut = await sessionWith({ theme: 'dark' });
    let res = await get('/auth/oidc/idp/start?action=reauth', signedOut);
    expect(res.headers.get('location')).toBe(`/?oidc_error=${encodeURIComponent('Not authenticated')}`);
    const locked = await sessionWith({ userId: 'u1', locked: true });
    res = await get('/auth/oidc/idp/start?action=reauth', locked);
    expect(res.headers.get('location')).toMatch(/^\/\?oidc_error=.*locked/i);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('signing in through single sign-on', () => {
  it('counts as a confirmation too', async () => {
    const cookie = await sessionWith({ oidcPending: {
      state: 's1', nonce: 'n1', verifier: 'v1', providerId: 'p1', action: 'login', expiresAt: Date.now() + 60_000,
    } });
    jwtVerify.mockResolvedValue(verifiedIdToken('n1'));

    const done = await get('/auth/oidc/idp/callback?code=c1&state=s1', cookie);

    expect(done.headers.get('location')).toBe('/?oidc_success=login');
    const signedIn = done.headers.get('set-cookie').split(';')[0];
    expect(await sessionOf(signedIn)).toMatchObject({ userId: 'u1', oidcConfirmedProviderId: 'p1' });
    expect((await sessionOf(signedIn)).oidcConfirmedAt).toBeGreaterThan(Date.now() - 60_000);
  });
});
