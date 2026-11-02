import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Linking a single sign-on identity takes the confirmation creating an API token does (#714):
// POST /api/auth/oidc/link-confirm checks the password, the two-factor code or a fresh sign-in
// through single sign-on with the rule in services/apiTokenReauth.js, and records in the session a
// confirmation that the link start spends (oidc.link.test.js). GET /identities says which of the
// three the form has to ask for. The real router, requireAuth and the rule, over an in-memory
// database and Redis.
const { rs, db, session } = vi.hoisted(() => ({ rs: { store: new Map() }, db: {}, session: { extra: {}, last: null } }));
vi.mock('../services/redis.js', () => ({
  redisClient: {
    async incr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v++; rs.store.set(k, e); return e.v; },
    async decr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v--; rs.store.set(k, e); return e.v; },
    async pExpire(k, ms) { const e = rs.store.get(k); if (e) e.exp = Date.now() + ms; return true; },
    async pTTL(k)        { const e = rs.store.get(k); return e ? (e.exp - Date.now()) : -2; },
    async del(k)         { rs.store.delete(k); return 1; },
    async set(k, v, { NX } = {}) { if (NX && rs.store.has(k)) return null; rs.store.set(k, { v, exp: 0 }); return 'OK'; },
  },
}));
vi.mock('../services/db.js', () => {
  const query = vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT id FROM users WHERE id = $1')) return { rows: db.users[params[0]] ? [{ id: params[0] }] : [] };
    if (sql.startsWith('SELECT id, username, password_hash, totp_enabled, totp_secret FROM users')) return { rows: db.users[params[0]] ? [db.users[params[0]]] : [] };
    if (sql.includes("key IN ('internal_auth_disabled', 'mfa_enforcement')")) {
      return { rows: [{ key: 'internal_auth_disabled', value: String(db.internalAuthDisabled) }, { key: 'mfa_enforcement', value: db.mfaEnforcement }] };
    }
    // The providers a sign-in can confirm with (apiTokenReauth.js), and the identities listed.
    if (sql.includes('SELECT DISTINCT op.id, op.slug, op.name FROM user_identities ui')) {
      return { rows: db.identities.filter(i => i.user_id === params[0] && db.providers[i.provider_id].enabled)
        .map(i => ({ id: i.provider_id, slug: db.providers[i.provider_id].slug, name: db.providers[i.provider_id].name })) };
    }
    if (sql.trimStart().startsWith('SELECT ui.id, ui.issuer, ui.email')) {
      return { rows: db.identities.filter(i => i.user_id === params[0]).map(i => ({
        id: i.id, issuer: db.providers[i.provider_id].issuer_url, email: i.email, created_at: '2026-10-01T00:00:00.000Z', last_used_at: null,
        provider_name: db.providers[i.provider_id].name, provider_slug: db.providers[i.provider_id].slug,
      })) };
    }
    if (sql.includes('INSERT INTO auth_events')) { db.events.push(params); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { query, pool: {}, withTransaction: vi.fn(async fn => fn({ query })) };
});
vi.mock('../services/encryption.js', () => ({ decrypt: value => value, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: false })) }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 3, windowMs: 60_000 } }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));

import express from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import oidcApiRouter from './oidc.js';
import { recordOidcConfirmation } from '../services/oidcConfirmation.js';

const SECRET = authenticator.generateSecret();
const PASSWORD_HASH = bcrypt.hashSync('right', 4);
const users = () => ({
  'u-totp': { id: 'u-totp', username: 'tess', password_hash: PASSWORD_HASH, totp_enabled: true, totp_secret: SECRET },
  'u-pw': { id: 'u-pw', username: 'paul', password_hash: PASSWORD_HASH, totp_enabled: false, totp_secret: null },
  'u-sso': { id: 'u-sso', username: 'sam', password_hash: null, totp_enabled: false, totp_secret: null },
});
const CORP = 'c0c0c0c0-0000-4000-8000-000000000001';
const providers = () => ({
  [CORP]: { id: CORP, slug: 'corp', name: 'Corp SSO', enabled: true, issuer_url: 'https://corp.example.com', client_id: 'mailflow' },
});
// Sam signs in through Corp; Paul and Tess have a password.
const identities = () => [{ id: 'i-sam', user_id: 'u-sso', provider_id: CORP, email: 'sam@corp.example.com' }];
// What the browser session holds beyond the user, for a request with x-test-user. Each request
// gets a copy, as a session store would give it one.
const signedInThrough = (providerId, minutesAgo = 1, userId = 'u-sso') => {
  session.extra = {};
  recordOidcConfirmation(session.extra, userId, db.providers[providerId], Date.now() - minutesAgo * 60_000);
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.get('x-test-user')) req.session = { userId: req.get('x-test-user'), destroy: vi.fn(), ...session.extra };
    // Kept so a test can see what the request left in its session.
    session.last = req.session ?? null;
    next();
  });
  app.use('/api/auth/oidc', oidcApiRouter);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  rs.store.clear();
  Object.assign(db, { internalAuthDisabled: false, mfaEnforcement: 'off', users: users(), providers: providers(), identities: identities(), events: [] });
  session.extra = {};
  session.last = null;
});
afterEach(() => vi.restoreAllMocks());

const as = user => (user ? { 'x-test-user': user } : {});
const confirm = (user, body = {}) => fetch(`${base}/api/auth/oidc/link-confirm`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...as(user) }, body: JSON.stringify(body),
});
const identitiesOf = user => fetch(`${base}/api/auth/oidc/identities`, { headers: as(user) });
const code = () => authenticator.generate(SECRET);
const events = type => db.events.filter(([t]) => t === type);
const LINK_CONFIRMATION_MS = 5 * 60_000;

describe('POST /api/auth/oidc/link-confirm', () => {
  it('needs a browser session', async () => {
    expect((await confirm(null, { password: 'right' })).status).toBe(401);
    expect(db.events).toEqual([]);
  });

  it('takes the password of a user who signs in with one, and counts for five minutes', async () => {
    const before = Date.now();
    const res = await confirm('u-pw', { password: 'right' });
    expect(res.status).toBe(200);
    const { linkConfirmation } = session.last;
    expect(linkConfirmation).toEqual({ at: expect.any(Number), userId: 'u-pw' });
    expect(linkConfirmation.at).toBeGreaterThanOrEqual(before);
    expect(linkConfirmation.at).toBeLessThanOrEqual(Date.now());
    expect(await res.json()).toEqual({ ok: true, until: new Date(linkConfirmation.at + LINK_CONFIRMATION_MS).toISOString() });
    expect(db.events).toEqual([]);
  });

  it('refuses a wrong or missing password, logs a wrong one as a failed sign-in, records nothing, and is never a 401', async () => {
    for (const body of [{ password: 'wrong' }, {}, { totpCode: code() }]) {
      const res = await confirm('u-pw', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'Incorrect password', reauth: 'password' });
      expect(session.last.linkConfirmation).toBeUndefined();
    }
    expect(events('login_fail')).toEqual([['login_fail', 'paul', 'u-pw', null, '127.0.0.1', false]]);
  });

  it('takes the current two-factor code of a user with two-factor on, once', async () => {
    // A code is good only inside its own 30-second step, so hold the clock mid-step.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T12:00:10.000Z'));
    try {
      for (const body of [{ password: 'right' }, { totpCode: '000000' }]) {
        const res = await confirm('u-totp', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toEqual({ error: 'Confirm with your current two-factor code', reauth: 'totp' });
        expect(session.last.linkConfirmation).toBeUndefined();
      }
      const right = code();
      expect((await confirm('u-totp', { totpCode: right })).status).toBe(200);
      expect(session.last.linkConfirmation).toMatchObject({ userId: 'u-totp' });
      expect((await confirm('u-totp', { totpCode: right })).status).toBe(400);
      expect(session.last.linkConfirmation).toBeUndefined();
      const failed = ['totp_fail', 'tess', 'u-totp', null, '127.0.0.1', false];
      expect(events('totp_fail')).toEqual([failed, failed]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends a fresh sign-in through single sign-on for an account that cannot sign in with a password', async () => {
    signedInThrough(CORP);
    const { nonce } = session.extra.oidcConfirmation;
    const res = await confirm('u-sso');
    expect(res.status).toBe(200);
    expect(session.last.linkConfirmation).toMatchObject({ userId: 'u-sso' });
    // Spent: the session forgets it and its nonce is marked used, so a request racing this one
    // cannot pass with the same sign-in. The next link needs a sign-in of its own.
    expect(session.last.oidcConfirmation).toBeUndefined();
    expect(rs.store.has(`oidc_confirmation_used:${nonce}`)).toBe(true);
    const again = await confirm('u-sso');
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'Confirm through single sign-on first; each confirmation can be used once, within 10 minutes', reauth: 'oidc' });
    expect(session.last.linkConfirmation).toBeUndefined();
  });

  it('refuses such an account without a fresh sign-in, whatever password it sends', async () => {
    // None, one too long ago, and one that is another user's.
    for (const signIn of [() => {}, () => signedInThrough(CORP, 11), () => signedInThrough(CORP, 1, 'u-pw')]) {
      session.extra = {};
      signIn();
      const res = await confirm('u-sso', { password: 'right' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reauth: 'oidc' });
      expect(session.last.linkConfirmation).toBeUndefined();
    }
    // With password sign-in turned off, a password user confirms the same way.
    db.internalAuthDisabled = true;
    expect((await confirm('u-pw', { password: 'right' })).status).toBe(400);
    expect(db.events).toEqual([]);
  });

  it('refuses while two-factor is required and the user has no authenticator', async () => {
    db.mfaEnforcement = 'required';
    const res = await confirm('u-pw', { password: 'right' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This server requires two-factor authentication. Set up an authenticator app first.', reauth: 'totpSetup' });
    expect(session.last.linkConfirmation).toBeUndefined();
  });

  it('is limited as a sign-in is, and says when to try again', async () => {
    for (let i = 0; i < 3; i++) expect((await confirm('u-pw', { password: 'wrong' })).status).toBe(400);
    const res = await confirm('u-pw', { password: 'right' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await res.json()).toEqual({ error: 'Too many attempts. Try again later.', reauth: 'password' });
    expect(session.last.linkConfirmation).toBeUndefined();
  });
});

describe('GET /api/auth/oidc/identities', () => {
  it('lists the identities, and says what linking another has to be confirmed with', async () => {
    expect(await (await identitiesOf('u-sso')).json()).toEqual({
      identities: [{
        id: 'i-sam', issuer: 'https://corp.example.com', email: 'sam@corp.example.com', created_at: '2026-10-01T00:00:00.000Z', last_used_at: null,
        provider_name: 'Corp SSO', provider_slug: 'corp',
      }],
      reauth: 'oidc',
      oidc: { providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: null },
    });
    expect(await (await identitiesOf('u-pw')).json()).toEqual({ identities: [], reauth: 'password' });
    expect(await (await identitiesOf('u-totp')).json()).toEqual({ identities: [], reauth: 'totp' });
    db.mfaEnforcement = 'required';
    expect(await (await identitiesOf('u-pw')).json()).toEqual({ identities: [], reauth: 'totpSetup' });
    db.internalAuthDisabled = true;
    expect(await (await identitiesOf('u-pw')).json()).toEqual({ identities: [], reauth: 'oidc', oidc: { providers: [], confirmedUntil: null } });
  });

  it('says until when a sign-in through single sign-on counts', async () => {
    signedInThrough(CORP, 2);
    const { at } = session.extra.oidcConfirmation;
    expect((await (await identitiesOf('u-sso')).json()).oidc.confirmedUntil).toBe(new Date(at + 10 * 60_000).toISOString());
    signedInThrough(CORP, 11);
    expect((await (await identitiesOf('u-sso')).json()).oidc.confirmedUntil).toBe(null);
  });

  it('needs a browser session', async () => {
    expect((await identitiesOf(null)).status).toBe(401);
  });
});
