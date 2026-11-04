import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Linking a single sign-on identity takes the confirmation creating an API token does (#714):
// action=link starts only with one just given through POST /api/auth/oidc/link-confirm
// (oidc.linkConfirm.test.js), and spends it, so a session on its own can no longer add an
// identity its owner did not ask for. The callback is as it was.
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
import { logAuthEvent } from '../services/authEvents.js';
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
    linkConfirmation: req.session.linkConfirmation ?? null,
    oidcConfirmation: req.session.oidcConfirmation ?? null,
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
  query.mockReset().mockImplementation(async (sql) => ({ rows: sql.includes('FROM oidc_providers') ? [provider] : [] }));
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql.includes('FROM oidc_providers')) return { rows: [provider] };
      return { rows: [] };
    }),
    release: vi.fn(),
  }));
  jwtVerify.mockReset();
  logAuthEvent.mockClear();
});

// Starts a session holding `state` and returns its cookie; given one, adds `state` to that session.
async function seed(state, cookie) {
  const res = await realFetch(`${base}/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(state),
  });
  return cookie ?? res.headers.get('set-cookie').split(';')[0];
}
const get = (path, cookie) => realFetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
const start = cookie => get('/auth/oidc/idp/start?action=link', cookie);
const sessionOf = async (cookie) => (await get('/session', cookie)).json();
const errorIn = (location) => decodeURIComponent(location.split('oidc_error=')[1] ?? '');
const verifiedIdToken = (nonce) => ({ payload: { iss: issuer, sub: 'idp-user', nonce, email: 'owner@example.net', email_verified: true } });

const LINK_CONFIRMATION_MS = 5 * 60 * 1000;
const REFUSED = 'Confirm it is you first — link from Settings → Security';
// As POST /api/auth/oidc/link-confirm records one, `msAgo` ago.
const confirmed = (msAgo = 1000, userId = 'u1') => ({ linkConfirmation: { at: Date.now() - msAgo, userId } });

describe('starting a link', () => {
  it('needs a confirmation just given, and spends it', async () => {
    const cookie = await seed({ userId: 'u1' });
    let res = await start(cookie);
    expect(res.headers.get('location')).toBe(`/?oidc_error=${encodeURIComponent(REFUSED)}`);
    // Refused before the provider is looked up.
    expect(query).not.toHaveBeenCalled();
    expect(await sessionOf(cookie)).toMatchObject({ userId: 'u1', oidcPending: null });

    await seed(confirmed(), cookie);
    res = await start(cookie);
    const authorize = new URL(res.headers.get('location'));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${issuer}/authorize`);
    // The confirmation was given to MailFlow itself: the provider is not asked for credentials again.
    expect(authorize.searchParams.has('prompt')).toBe(false);
    expect(authorize.searchParams.has('max_age')).toBe(false);
    const after = await sessionOf(cookie);
    expect(after.oidcPending).toMatchObject({ action: 'link', linkUserId: 'u1', providerId: 'p1' });
    expect(after.linkConfirmation).toBe(null);

    // The next link needs a confirmation of its own.
    res = await start(cookie);
    expect(errorIn(res.headers.get('location'))).toBe(REFUSED);
  });

  it.each([
    ['older than five minutes', () => confirmed(LINK_CONFIRMATION_MS + 1000)],
    ['from the future', () => confirmed(-60_000)],
    ['that is another user\'s', () => confirmed(1000, 'u2')],
    ['with no time', () => ({ linkConfirmation: { userId: 'u1' } })],
    ['with a time that is not a number', () => ({ linkConfirmation: { at: String(Date.now()), userId: 'u1' } })],
  ])('refuses a confirmation %s', async (_label, state) => {
    const cookie = await seed({ userId: 'u1', ...state() });
    const res = await start(cookie);
    expect(errorIn(res.headers.get('location'))).toBe(REFUSED);
    expect((await sessionOf(cookie)).oidcPending).toBe(null);
    expect(query).not.toHaveBeenCalled();
  });

  it('then links the identity the provider returns, and logs it', async () => {
    const cookie = await seed({ userId: 'u1', username: 'owner@example.com', ...confirmed() });
    await start(cookie);
    const { oidcPending } = await sessionOf(cookie);
    jwtVerify.mockResolvedValue(verifiedIdToken(oidcPending.nonce));

    const done = await get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`, cookie);

    expect(done.headers.get('location')).toBe('/?oidc_success=linked');
    const insert = clientQueries.find(q => q.sql.includes('INSERT INTO user_identities'));
    expect(insert.params.slice(0, 4)).toEqual(['u1', 'p1', issuer, 'idp-user']);
    expect(logAuthEvent).toHaveBeenCalledWith('identity_linked', expect.objectContaining({ userId: 'u1', username: 'owner@example.com', success: true }));
    // Nothing is left over for a second link, and no sign-in confirmation is made on the way.
    expect(await sessionOf(cookie)).toMatchObject({ userId: 'u1', linkConfirmation: null, oidcConfirmation: null, oidcPending: null });
  });

  it('is not confirmed by a fresh single sign-on alone: that goes through link-confirm first', async () => {
    // As the reauth callback records one, which link-confirm spends for an account without password sign-in.
    const oidcConfirmation = { at: Date.now() - 1000, nonce: 'n0nce', userId: 'u1', providerId: 'p1', issuerUrl: issuer, clientId: 'mailflow' };
    const cookie = await seed({ userId: 'u1', oidcConfirmation });
    const res = await start(cookie);
    expect(errorIn(res.headers.get('location'))).toBe(REFUSED);
    expect(await sessionOf(cookie)).toMatchObject({ oidcConfirmation, oidcPending: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses the callback when the session is no longer the user who started the link', async () => {
    const cookie = await seed({ userId: 'u1', ...confirmed() });
    await start(cookie);
    const { oidcPending } = await sessionOf(cookie);
    await seed({ userId: 'u2' }, cookie);
    jwtVerify.mockResolvedValue(verifiedIdToken(oidcPending.nonce));

    const done = await get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`, cookie);

    expect(errorIn(done.headers.get('location'))).toBe('Link session invalid');
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO user_identities'))).toBe(false);
    expect(logAuthEvent).not.toHaveBeenCalledWith('identity_linked', expect.anything());
  });

  it('is not confirmed by a fresh single sign-on alone: that goes through link-confirm first', async () => {
    // As the reauth callback records one, which link-confirm spends for an account without password sign-in.
    const oidcConfirmation = { at: Date.now() - 1000, nonce: 'n0nce', userId: 'u1', providerId: 'p1', issuerUrl: issuer, clientId: 'mailflow' };
    const cookie = await seed({ userId: 'u1', oidcConfirmation });
    const res = await start(cookie);
    expect(errorIn(res.headers.get('location'))).toBe(REFUSED);
    expect(await sessionOf(cookie)).toMatchObject({ oidcConfirmation, oidcPending: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses the callback when the session is no longer the user who started the link', async () => {
    const cookie = await seed({ userId: 'u1', ...confirmed() });
    await start(cookie);
    const { oidcPending } = await sessionOf(cookie);
    await seed({ userId: 'u2' }, cookie);
    jwtVerify.mockResolvedValue(verifiedIdToken(oidcPending.nonce));

    const done = await get(`/auth/oidc/idp/callback?code=c1&state=${oidcPending.state}`, cookie);

    expect(errorIn(done.headers.get('location'))).toBe('Link session invalid');
    expect(clientQueries.some(q => q.sql.includes('INSERT INTO user_identities'))).toBe(false);
    expect(logAuthEvent).not.toHaveBeenCalledWith('identity_linked', expect.anything());
  });

  it('still needs a signed-in, unlocked session', async () => {
    const signedOut = await seed({ ...confirmed() });
    expect(errorIn((await start(signedOut)).headers.get('location'))).toBe('Not authenticated');
    const locked = await seed({ userId: 'u1', locked: true, ...confirmed() });
    expect(errorIn((await start(locked)).headers.get('location'))).toMatch(/locked/i);
    expect((await sessionOf(locked)).oidcPending).toBe(null);
    expect(query).not.toHaveBeenCalled();
  });
});
