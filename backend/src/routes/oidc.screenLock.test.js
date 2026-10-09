import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The screen lock (#235) is enforced by a gate in index.js that only covers /api, and the SSO
// browser routes are mounted at /auth/oidc, outside it. From a locked session, whoever is at the
// keyboard could link their own IdP identity to the account (and later sign in as its owner from
// anywhere), or sign in again and swap the locked session for an unlocked one.
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

let server, base, clientQueries;

beforeAll(async () => {
  process.env.APP_URL = 'https://mail.example.com';
  // Only the IdP is stubbed. Requests to the test server go through realFetch.
  global.fetch = vi.fn(async (url) => {
    if (String(url) === `${issuer}/.well-known/openid-configuration`) return { ok: true, status: 200, json: async () => discoveryDoc };
    if (String(url) === `${issuer}/token`) return { ok: true, status: 200, json: async () => ({ id_token: 'id-token' }) };
    throw new Error(`unexpected fetch: ${url}`);
  });
  const app = express();
  app.use(session(buildSessionOptions(new session.MemoryStore(), 'test-secret-'.padEnd(40, 'x'))));
  app.post('/seed', express.json(), (req, res) => { Object.assign(req.session, req.body); res.end(); });
  app.get('/session', (req, res) => res.json({
    userId: req.session.userId ?? null,
    locked: !!req.session.locked,
    oidcPending: req.session.oidcPending ?? null,
  }));
  app.use('/auth/oidc', oidcBrowserRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  global.fetch = realFetch;
  delete process.env.APP_URL;
  // The redirect bodies are never read, and their keep-alive sockets would hold close() for ~3s.
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

beforeEach(() => {
  clientQueries = [];
  query.mockReset().mockImplementation(async (sql) => ({ rows: sql.includes('FROM oidc_providers') ? [provider] : [] }));
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql.includes('FROM oidc_providers')) return { rows: [provider] };
      if (sql.includes('SELECT user_id FROM user_identities')) return { rows: [{ user_id: 'u1' }] };
      if (sql.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', username: 'owner@example.com', is_admin: false }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  }));
  jwtVerify.mockReset();
});

// Starts a session holding `state` and returns its cookie.
async function sessionWith(state) {
  const res = await realFetch(`${base}/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
const get = (path, cookie) => realFetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
const sessionOf = async (cookie) => (await get('/session', cookie)).json();
const errorIn = (location) => decodeURIComponent(location.split('oidc_error=')[1] ?? '');
const verifiedIdToken = (nonce) => ({ payload: { iss: issuer, sub: 'idp-user', nonce, email: 'someone@example.net', email_verified: true } });
const pendingFlow = (action) => ({
  state: 's1', nonce: 'n1', verifier: 'v1', providerId: 'p1', action,
  linkUserId: action === 'link' ? 'u1' : undefined, expiresAt: Date.now() + 60_000,
});

describe('SSO browser routes honour the screen lock (#235)', () => {
  it.each([
    ['link', '?action=link', /^\/\?oidc_error=/],
    ['login', '', /^\/login\?oidc_error=/],
  ])('refuses to start an SSO %s from a locked session', async (_flow, search, errorPage) => {
    const cookie = await sessionWith({ userId: 'u1', locked: true });

    const res = await get(`/auth/oidc/idp/start${search}`, cookie);

    const location = res.headers.get('location');
    expect(location).toMatch(errorPage);
    expect(errorIn(location)).toMatch(/locked/i);
    expect(await sessionOf(cookie)).toEqual({ userId: 'u1', locked: true, oidcPending: null });
  });

  it.each([
    ['link', /^\/\?oidc_error=/],
    ['login', /^\/login\?oidc_error=/],
  ])('refuses to finish an SSO %s started before the session locked', async (flow, errorPage) => {
    const cookie = await sessionWith({ userId: 'u1', locked: true, oidcPending: pendingFlow(flow) });
    jwtVerify.mockResolvedValue(verifiedIdToken('n1'));

    const res = await get('/auth/oidc/idp/callback?code=c1&state=s1', cookie);

    const location = res.headers.get('location');
    expect(location).toMatch(errorPage);
    expect(errorIn(location)).toMatch(/locked/i);
    // Refused before the callback opens a database client, so none of its branches can link an
    // identity or replace the session, including the two sign-in branches these mocks never reach.
    expect(pool.connect).not.toHaveBeenCalled();
    // Still the same locked session, not a fresh unlocked one.
    expect(await sessionOf(cookie)).toEqual({ userId: 'u1', locked: true, oidcPending: null });
  });

  it('still links an identity from an unlocked session', async () => {
    const cookie = await sessionWith({ userId: 'u1' });

    const start = await get('/auth/oidc/idp/start?action=link', cookie);
    expect(start.headers.get('location').split('?')[0]).toBe(`${issuer}/authorize`);

    const { oidcPending } = await sessionOf(cookie);
    jwtVerify.mockResolvedValue(verifiedIdToken(oidcPending.nonce));
    const done = await get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`, cookie);

    expect(done.headers.get('location')).toBe('/?oidc_success=linked');
    const insert = clientQueries.find(q => q.sql.includes('INSERT INTO user_identities'));
    expect(insert.params.slice(0, 4)).toEqual(['u1', 'p1', issuer, 'idp-user']);
  });
});
