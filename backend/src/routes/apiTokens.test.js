import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The token routes as the browser and a token reach them: the real router, requireAuth and
// re-authentication over an in-memory database and Redis.
const { rs, db } = vi.hoisted(() => ({ rs: { store: new Map() }, db: {} }));
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
    db.log.push([sql, params]);
    if (sql.startsWith('SELECT id FROM users WHERE id = $1')) return { rows: db.users[params[0]] ? [{ id: params[0] }] : [] };
    if (sql.startsWith('SELECT id, username, password_hash, totp_enabled, totp_secret FROM users')) return { rows: db.users[params[0]] ? [db.users[params[0]]] : [] };
    if (sql.startsWith('SELECT username FROM users WHERE id = $1')) return { rows: db.users[params[0]] ? [db.users[params[0]]] : [] };
    if (sql.startsWith('SELECT 1 FROM users WHERE id = $1 FOR UPDATE')) return { rows: [{}] };
    if (sql.includes("key = 'api_tokens_enabled'")) return { rows: [{ value: String(db.enabled) }] };
    // The policy as createToken re-reads it inside its transaction: a test can make it differ from
    // what reauthFor saw, as an admin's change in between would.
    if (sql.includes("key IN ('mfa_enforcement', 'internal_auth_disabled') FOR SHARE")) {
      return { rows: [
        { key: 'mfa_enforcement', value: db.mfaEnforcementAtInsert ?? db.mfaEnforcement },
        { key: 'internal_auth_disabled', value: String(db.internalAuthDisabledAtInsert ?? db.internalAuthDisabled) },
      ] };
    }
    if (sql.includes("key IN ('internal_auth_disabled', 'mfa_enforcement')")) {
      return { rows: [{ key: 'internal_auth_disabled', value: String(db.internalAuthDisabled) }, { key: 'mfa_enforcement', value: db.mfaEnforcement }] };
    }
    if (sql.includes('FROM user_identities ui') && sql.includes('JOIN oidc_providers op')) {
      return { rows: db.identities.filter(i => i.user_id === params[0] && db.providers[i.provider_id].enabled)
        .map(i => ({ id: i.provider_id, slug: db.providers[i.provider_id].slug, name: db.providers[i.provider_id].name })) };
    }
    if (sql.includes('COUNT(*)::int AS count FROM api_tokens')) return { rows: [{ count: db.tokens.filter(t => t.user_id === params[0]).length }] };
    if (sql.includes('FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC')) {
      return { rows: db.tokens.filter(t => t.user_id === params[0]).sort((a, b) => b.created_at - a.created_at) };
    }
    if (sql.includes('INSERT INTO api_tokens')) {
      const [userId, name, tokenHash, scopes, expiresAt, confirmedWith, oidcProviderId] = params;
      const row = { id: `00000000-0000-4000-8000-${String(db.tokens.length + 1).padStart(12, '0')}`, user_id: userId, name, token_hash: tokenHash,
        scopes: JSON.parse(scopes), created_at: new Date(), expires_at: expiresAt, last_used_at: null, last_used_ip: null, expired: false,
        confirmed_with: confirmedWith, oidc_provider_id: oidcProviderId };
      db.tokens.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2')) {
      const index = db.tokens.findIndex(t => t.id === params[0] && t.user_id === params[1]);
      return { rows: index < 0 ? [] : db.tokens.splice(index, 1) };
    }
    if (sql.includes('INSERT INTO auth_events')) { db.events.push(params); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { query, withTransaction: vi.fn(async fn => fn({ query })) };
});
vi.mock('../services/encryption.js', () => ({ decrypt: value => value }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 60_000 } }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));

import express from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import apiTokenRoutes from './apiTokens.js';
import { hashToken, invalidateApiTokenSettingsCache, isTokenFormat } from '../services/apiTokens.js';

const SECRET = authenticator.generateSecret();
const PASSWORD_HASH = bcrypt.hashSync('right', 4);
const users = () => ({
  'u-totp': { id: 'u-totp', username: 'tess', password_hash: PASSWORD_HASH, totp_enabled: true, totp_secret: SECRET },
  'u-pw': { id: 'u-pw', username: 'paul', password_hash: PASSWORD_HASH, totp_enabled: false, totp_secret: null },
  'u-sso': { id: 'u-sso', username: 'sam', password_hash: null, totp_enabled: false, totp_secret: null },
});
const CORP = 'c0c0c0c0-0000-4000-8000-000000000001';
const OTHER_IDP = 'c0c0c0c0-0000-4000-8000-000000000002';
const providers = () => ({
  [CORP]: { slug: 'corp', name: 'Corp SSO', enabled: true },
  [OTHER_IDP]: { slug: 'other', name: 'Other', enabled: true },
});
// Sam signs in through Corp only; Paul has linked Corp too.
const identities = () => [{ user_id: 'u-sso', provider_id: CORP }, { user_id: 'u-pw', provider_id: CORP }];
// What the browser session holds beyond the user, for a request with x-test-user.
const session = { extra: {} };
const signedInThrough = (providerId, minutesAgo = 1) => {
  session.extra = { oidcConfirmedAt: Date.now() - minutesAgo * 60_000, oidcConfirmedProviderId: providerId };
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  // As index.js sets it behind its proxy, so a test can say what the proxy wrote.
  app.set('trust proxy', 1);
  app.use(express.json());
  // A browser session for x-test-user, or a token request for x-test-token, as apiTokenAuth leaves one.
  app.use((req, _res, next) => {
    if (req.get('x-test-user')) req.session = { userId: req.get('x-test-user'), destroy: vi.fn(), ...session.extra };
    if (req.get('x-test-token')) {
      req.session = { userId: 'u-pw', apiTokenId: 't1' };
      req.apiToken = { id: 't1', userId: 'u-pw', username: 'paul', name: 'Claude', scopes: ['read'], createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null };
    }
    next();
  });
  app.use('/api/api-tokens', apiTokenRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

let log;
beforeEach(() => {
  rs.store.clear();
  Object.assign(db, {
    enabled: true, internalAuthDisabled: false, mfaEnforcement: 'off', mfaEnforcementAtInsert: undefined, internalAuthDisabledAtInsert: undefined,
    users: users(), providers: providers(), identities: identities(), tokens: [], events: [], log: [],
  });
  session.extra = {};
  invalidateApiTokenSettingsCache();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const as = user => (user ? { 'x-test-user': user } : {});
const list = user => fetch(`${base}/api/api-tokens`, { headers: as(user) });
const create = (user, body, headers = {}) => fetch(`${base}/api/api-tokens`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...as(user), ...headers }, body: JSON.stringify(body),
});
const revoke = (user, id, headers = {}) => fetch(`${base}/api/api-tokens/${id}`, { method: 'DELETE', headers: { ...as(user), ...headers } });
const ok = { name: 'Claude at work', scopes: ['read', 'draft'], expiresInDays: 90 };
const code = () => authenticator.generate(SECRET);
const events = type => db.events.filter(([t]) => t === type);

describe('who can manage tokens', () => {
  it('a browser session only', async () => {
    expect((await list()).status).toBe(401);
    expect((await create(null, { ...ok, password: 'right' })).status).toBe(401);
    expect((await revoke(null, '00000000-0000-4000-8000-000000000001')).status).toBe(401);
    expect(db.tokens).toEqual([]);
  });

  it('never a token, even one that got this far', async () => {
    const headers = { 'x-test-token': '1', 'Content-Type': 'application/json' };
    for (const [method, path] of [['GET', ''], ['POST', ''], ['DELETE', '/00000000-0000-4000-8000-000000000001']]) {
      const res = await fetch(`${base}/api/api-tokens${path}`, { method, headers, body: method === 'POST' ? JSON.stringify({ ...ok, password: 'right' }) : undefined });
      expect(res.status, method).toBe(403);
    }
    expect(db.tokens).toEqual([]);
  });
});

describe('GET /api/api-tokens/self', () => {
  it('tells a token who it is', async () => {
    const res = await fetch(`${base}/api/api-tokens/self`, { headers: { 'x-test-token': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 't1', name: 'Claude', scopes: ['read'], createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null, username: 'paul' });
  });

  it('answers anything that is not a token request with a 401 of its own', async () => {
    for (const headers of [{}, as('u-pw')]) {
      const res = await fetch(`${base}/api/api-tokens/self`, { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'This endpoint needs an API token' });
    }
  });
});

describe('listing tokens', () => {
  it('says whether tokens are on, which confirmation creating one takes, and the choices it allows', async () => {
    expect(await (await list('u-totp')).json()).toEqual({ enabled: true, reauth: 'totp', expiryChoices: [7, 30, 90, 365], maxTokens: 20, tokens: [] });
    expect(await (await list('u-pw')).json()).toMatchObject({ reauth: 'password', expiryChoices: [7, 30, 90, 365] });
    expect(await (await list('u-sso')).json()).toMatchObject({
      reauth: 'oidc', oidc: { providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: null }, expiryChoices: [7, 30],
    });
    db.mfaEnforcement = 'required';
    expect(await (await list('u-pw')).json()).toMatchObject({ reauth: 'totpSetup' });
    expect(await (await list('u-totp')).json()).toMatchObject({ reauth: 'totp' });
    db.internalAuthDisabled = true;
    expect(await (await list('u-pw')).json()).toMatchObject({ reauth: 'oidc', expiryChoices: [7, 30] });
    expect(await (await list('u-totp')).json()).toMatchObject({ reauth: 'oidc', oidc: { providers: [] } });
    db.enabled = false;
    invalidateApiTokenSettingsCache();
    expect(await (await list('u-pw')).json()).toMatchObject({ enabled: false });
  });

  it('says until when a sign-in through single sign-on counts, and only through a provider still linked and on', async () => {
    signedInThrough(CORP, 1);
    const at = session.extra.oidcConfirmedAt;
    expect((await (await list('u-sso')).json()).oidc).toEqual({
      providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: new Date(at + 10 * 60_000).toISOString(),
    });
    signedInThrough(CORP, 11);
    expect((await (await list('u-sso')).json()).oidc.confirmedUntil).toBe(null);
    signedInThrough(OTHER_IDP, 1);
    expect((await (await list('u-sso')).json()).oidc.confirmedUntil).toBe(null);
    signedInThrough(CORP, 1);
    db.providers[CORP].enabled = false;
    expect((await (await list('u-sso')).json()).oidc).toEqual({ providers: [], confirmedUntil: null });
  });

  it('lists the user\'s own tokens, newest first, without their hashes', async () => {
    await create('u-pw', { ...ok, name: 'older', password: 'right' });
    await create('u-pw', { ...ok, name: 'newer', password: 'right' });
    signedInThrough(CORP);
    await create('u-sso', { ...ok, name: 'someone else', expiresInDays: 30 });
    db.tokens[0].created_at = new Date(Date.now() - 60_000);
    const { tokens } = await (await list('u-pw')).json();
    expect(tokens.map(t => t.name)).toEqual(['newer', 'older']);
    expect(Object.keys(tokens[0]).sort()).toEqual(['createdAt', 'expired', 'expiresAt', 'id', 'lastUsedAt', 'lastUsedIp', 'name', 'scopes']);
    expect(JSON.stringify(tokens)).not.toMatch(/token_hash|[0-9a-f]{64}/);
  });
});

describe('creating a token', () => {
  it('returns the secret once, and stores only its SHA-256', async () => {
    const res = await create('u-pw', { ...ok, password: 'right' });
    expect(res.status).toBe(201);
    const { token, apiToken } = await res.json();
    expect(isTokenFormat(token)).toBe(true);
    expect(apiToken).toMatchObject({ name: 'Claude at work', scopes: ['read', 'draft'], lastUsedAt: null, lastUsedIp: null, expired: false });
    expect(new Date(apiToken.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 3600 * 1000);
    expect(db.tokens[0].token_hash).toBe(hashToken(token));
    expect(JSON.stringify(db.log)).not.toContain(token);
    // The list never shows it again.
    expect(JSON.stringify(await (await list('u-pw')).json())).not.toContain(token);
  });

  it('logs who created which token, and never the token or its hash', async () => {
    const { token } = await (await create('u-pw', { ...ok, password: 'right' })).json();
    expect(events('api_token_created')).toEqual([['api_token_created', 'paul', 'u-pw', null, '127.0.0.1', true]]);
    const line = log.mock.calls.map(args => args.join(' ')).find(l => l.startsWith('[apiToken]'));
    expect(line).toMatch(/^\[apiToken\] paul created token "Claude at work" \(\S+\) scopes=read,draft expires=\d{4}-\S+ confirmed=password$/);
    expect(line).not.toContain(token);
    expect(line).not.toContain(hashToken(token));
  });

  it('is refused when tokens are turned off', async () => {
    db.enabled = false;
    const res = await create('u-pw', { ...ok, password: 'right' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'API tokens are turned off on this server' });
  });

  it('checks the name, the scopes and the expiry', async () => {
    for (const body of [
      { ...ok, name: '' }, { ...ok, name: 'x'.repeat(61) }, { ...ok, name: 'a\nb' }, { ...ok, name: undefined },
      { ...ok, scopes: [] }, { ...ok, scopes: ['send'] }, { ...ok, scopes: ['read', 'read'] }, { ...ok, scopes: 'read' },
      { ...ok, expiresInDays: undefined }, { ...ok, expiresInDays: 45 }, { ...ok, expiresInDays: '90' }, { ...ok, expiresInDays: 0 },
      { ...ok, expiresInDays: null },
    ]) {
      const res = await create('u-pw', { ...body, password: 'right' });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(db.tokens).toEqual([]);
  });

  it('takes every listed expiry, and never none', async () => {
    for (const expiresInDays of [7, 30, 90, 365]) {
      expect((await create('u-pw', { ...ok, expiresInDays, password: 'right' })).status, String(expiresInDays)).toBe(201);
    }
    expect(db.tokens.map(t => Math.round((t.expires_at - t.created_at) / 86_400_000))).toEqual([7, 30, 90, 365]);
    const res = await create('u-pw', { ...ok, expiresInDays: null, password: 'right' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Choose an expiry of 7, 30, 90 or 365 days' });
  });

  it('stops at 20 tokens per user', async () => {
    for (let i = 0; i < 20; i++) db.tokens.push({ id: `t${i}`, user_id: 'u-pw', name: `t${i}`, created_at: new Date() });
    const res = await create('u-pw', { ...ok, password: 'right' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'You already have 20 API tokens. Revoke one to create another.' });
    // Another user's limit is their own.
    signedInThrough(CORP);
    expect((await create('u-sso', { ...ok, expiresInDays: 30 })).status).toBe(201);
  });

  describe('with the confirmation the account allows', () => {
    it('a two-factor user: their current code, not the password', async () => {
      // A code is good only inside its own 30-second step, so hold the clock mid-step: one made
      // just before a step ends would otherwise fail on a busy machine.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-15T12:00:10.000Z'));
      try {
        for (const body of [{}, { totpCode: '000000' }, { password: 'right' }]) {
          const res = await create('u-totp', { ...ok, ...body });
          expect(res.status, JSON.stringify(body)).toBe(400);
          expect(await res.json()).toEqual({ error: 'Confirm with your current two-factor code', reauth: 'totp' });
        }
        expect((await create('u-totp', { ...ok, totpCode: code() })).status).toBe(201);
        expect(db.tokens.map(t => [t.confirmed_with, t.oidc_provider_id])).toEqual([['totp', null]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a password user: the password, never answered with 401', async () => {
      const res = await create('u-pw', { ...ok, password: 'wrong' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Incorrect password', reauth: 'password' });
      expect((await create('u-pw', ok)).status).toBe(400);
      expect((await create('u-pw', { ...ok, password: 'right' })).status).toBe(201);
      expect(db.tokens.map(t => [t.confirmed_with, t.oidc_provider_id])).toEqual([['password', null]]);
    });

    it('a single sign-on user: a sign-in through their provider in the last 10 minutes, and at most 30 days', async () => {
      const sso = { ...ok, expiresInDays: 30 };
      const refused = { error: 'Confirm through single sign-on first; a confirmation counts for 10 minutes', reauth: 'oidc' };
      // None at all, one too long ago, one through a provider they have no identity at, and one
      // through a provider turned off since.
      for (const signIn of [() => {}, () => signedInThrough(CORP, 11), () => signedInThrough(OTHER_IDP, 1),
        () => { signedInThrough(CORP, 1); db.providers[CORP].enabled = false; }]) {
        session.extra = {};
        db.providers[CORP].enabled = true;
        signIn();
        const res = await create('u-sso', sso);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(refused);
      }
      db.providers[CORP].enabled = true;
      signedInThrough(CORP, 9);
      expect((await create('u-sso', sso)).status).toBe(201);
      expect(db.tokens.map(t => [t.confirmed_with, t.oidc_provider_id])).toEqual([['oidc', CORP]]);
      for (const expiresInDays of [90, 365, null]) {
        const res = await create('u-sso', { ...ok, expiresInDays });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Choose an expiry of 7 or 30 days' });
      }
    });

    it('a password user when password sign-in is off: single sign-on, and no password checked', async () => {
      db.internalAuthDisabled = true;
      const compare = vi.spyOn(bcrypt, 'compare');
      expect((await create('u-pw', { ...ok, expiresInDays: 30, password: 'right' })).status).toBe(400);
      signedInThrough(CORP);
      expect((await create('u-pw', { ...ok, expiresInDays: 30, password: 'wrong' })).status).toBe(201);
      expect(compare).not.toHaveBeenCalled();
      expect(db.tokens.map(t => t.confirmed_with)).toEqual(['oidc']);
    });

    it('a sign-in policy that changed since the confirmation: refused with 409, nothing stored, never 401', async () => {
      db.mfaEnforcementAtInsert = 'required';
      const res = await create('u-pw', { ...ok, password: 'right' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "The server's sign-in policy changed while this token was being created. Confirm again." });
      expect(db.tokens).toEqual([]);
      expect(events('api_token_created')).toEqual([]);
      // A confirmation the new policy still allows goes through.
      db.mfaEnforcementAtInsert = undefined;
      db.internalAuthDisabledAtInsert = true;
      signedInThrough(CORP);
      expect((await create('u-sso', { ...ok, expiresInDays: 30 })).status).toBe(201);
    });

    it('a user without an authenticator while two-factor is required: refused until they set one up', async () => {
      db.mfaEnforcement = 'required';
      const compare = vi.spyOn(bcrypt, 'compare');
      const res = await create('u-pw', { ...ok, password: 'right' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'This server requires two-factor authentication. Set up an authenticator app to create API tokens.', reauth: 'totpSetup',
      });
      expect(compare).not.toHaveBeenCalled();
      expect(db.tokens).toEqual([]);
    });

    it('a refused confirmation stores nothing, and is logged as a failed sign-in or two-factor check', async () => {
      await create('u-pw', { ...ok, password: 'wrong' });
      await create('u-totp', { ...ok, totpCode: '000000' });
      expect(db.tokens).toEqual([]);
      expect(events('api_token_created')).toEqual([]);
      expect(events('login_fail')).toEqual([['login_fail', 'paul', 'u-pw', null, '127.0.0.1', false]]);
      expect(events('totp_fail')).toEqual([['totp_fail', 'tess', 'u-totp', null, '127.0.0.1', false]]);
    });
  });
});

describe('revoking a token', () => {
  it('deletes the user\'s own token and logs it', async () => {
    const { apiToken } = await (await create('u-pw', { ...ok, password: 'right' })).json();
    const res = await revoke('u-pw', apiToken.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.tokens).toEqual([]);
    expect(events('api_token_revoked')).toEqual([['api_token_revoked', 'paul', 'u-pw', null, '127.0.0.1', true]]);
  });

  it('cannot touch another user\'s token', async () => {
    const { apiToken } = await (await create('u-pw', { ...ok, password: 'right' })).json();
    const res = await revoke('u-sso', apiToken.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'API token not found' });
    expect(db.tokens).toHaveLength(1);
    expect(events('api_token_revoked')).toEqual([]);
  });

  it('logs creating and revoking without an address that is not one, as a proxy may have written it', async () => {
    const { apiToken } = await (await create('u-pw', { ...ok, password: 'right' }, { 'X-Forwarded-For': 'not-an-address' })).json();
    await revoke('u-pw', apiToken.id, { 'X-Forwarded-For': `2001:db8::1%${'x'.repeat(60)}` });
    expect(events('api_token_created')).toEqual([['api_token_created', 'paul', 'u-pw', null, null, true]]);
    expect(events('api_token_revoked')).toEqual([['api_token_revoked', 'paul', 'u-pw', null, null, true]]);
  });

  it('refuses an id that is not a UUID before any query', async () => {
    const res = await revoke('u-pw', 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(db.log.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
  });

  it('works while tokens are turned off', async () => {
    const { apiToken } = await (await create('u-pw', { ...ok, password: 'right' })).json();
    db.enabled = false;
    invalidateApiTokenSettingsCache();
    expect((await revoke('u-pw', apiToken.id)).status).toBe(200);
  });
});
