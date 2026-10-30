import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real rate limiter and replay guard run against this in-memory Redis.
const { rs, settings, linked } = vi.hoisted(() => ({
  rs: { store: new Map() },
  settings: { internalAuthDisabled: 'false', mfaEnforcement: 'off' },
  // Enabled providers each user has an identity at, as the query returns them.
  linked: new Map(),
}));
vi.mock('./redis.js', () => ({
  redisClient: {
    async incr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v++; rs.store.set(k, e); return e.v; },
    async decr(k)        { const e = rs.store.get(k) || { v: 0, exp: 0 }; e.v--; rs.store.set(k, e); return e.v; },
    async pExpire(k, ms) { const e = rs.store.get(k); if (e) e.exp = Date.now() + ms; return true; },
    async pTTL(k)        { const e = rs.store.get(k); return e ? (e.exp - Date.now()) : -2; },
    async del(k)         { rs.store.delete(k); return 1; },
    async set(k, v, { NX } = {}) { if (NX && rs.store.has(k)) return null; rs.store.set(k, { v, exp: 0 }); return 'OK'; },
  },
}));
vi.mock('./db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (sql.includes("key IN ('internal_auth_disabled', 'mfa_enforcement')")) {
      return { rows: [{ key: 'internal_auth_disabled', value: settings.internalAuthDisabled }, { key: 'mfa_enforcement', value: settings.mfaEnforcement }] };
    }
    if (sql.includes('FROM user_identities ui')) return { rows: linked.get(params[0]) ?? [] };
    return { rows: [] };
  }),
}));
vi.mock('./encryption.js', () => ({ decrypt: value => value }));
vi.mock('./authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 3, windowMs: 60_000 } }));
vi.mock('./authEvents.js', () => ({ logAuthEvent: vi.fn() }));

import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { logAuthEvent } from './authEvents.js';
import { confirmReauth, expiryChoicesFor, oidcConfirmationState, reauthFor } from './apiTokenReauth.js';
import { OIDC_CONFIRMATION_MS, recordOidcConfirmation } from './oidcConfirmation.js';

const SECRET = authenticator.generateSecret();
const TOTP_USER = { id: 'u-totp', username: 'tess', password_hash: bcrypt.hashSync('right', 4), totp_enabled: true, totp_secret: SECRET };
const PASSWORD_USER = { id: 'u-pw', username: 'paul', password_hash: bcrypt.hashSync('right', 4), totp_enabled: false, totp_secret: null };
const SSO_USER = { id: 'u-sso', username: 'sam', password_hash: null, totp_enabled: false, totp_secret: null };
const CORP = { id: 'c0c0c0c0-0000-4000-8000-000000000001', slug: 'corp', name: 'Corp SSO' };
const request = (body, ip = '203.0.113.7', session = {}) => ({ ip, body, session });
const count = key => rs.store.get(`rl:${key}`)?.v ?? 0;
const failed = (type, { id, username }, ip = '203.0.113.7') => [type, { userId: id, username, ip, success: false }];

beforeEach(() => {
  rs.store.clear();
  settings.internalAuthDisabled = 'false';
  settings.mfaEnforcement = 'off';
  linked.clear();
  linked.set(SSO_USER.id, [CORP]);
  logAuthEvent.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('which confirmation token creation asks for', () => {
  it('the two-factor code when the user has two-factor on and can sign in with a password', async () => {
    expect(await reauthFor(TOTP_USER)).toBe('totp');
    settings.mfaEnforcement = 'required';
    expect(await reauthFor(TOTP_USER)).toBe('totp');
  });

  it('the password when the user has one, password sign-in is on and two-factor is not required', async () => {
    expect(await reauthFor(PASSWORD_USER)).toBe('password');
  });

  it('a sign-in through single sign-on when the account cannot use a password, two-factor or not', async () => {
    expect(await reauthFor(SSO_USER)).toBe('oidc');
    expect(await reauthFor({ ...TOTP_USER, password_hash: null })).toBe('oidc');
    settings.internalAuthDisabled = 'true';
    expect(await reauthFor(PASSWORD_USER)).toBe('oidc');
    expect(await reauthFor(TOTP_USER)).toBe('oidc');
  });

  it('an authenticator set up first when two-factor is required and the user has none', async () => {
    settings.mfaEnforcement = 'required';
    expect(await reauthFor(PASSWORD_USER)).toBe('totpSetup');
    const refusal = { status: 403, body: { error: 'This server requires two-factor authentication. Set up an authenticator app to create API tokens.', reauth: 'totpSetup' } };
    expect(await confirmReauth(request({ password: 'right' }), PASSWORD_USER, 'totpSetup')).toEqual({ refusal });
  });

  it('and a token lasts a year at most, or 30 days when single sign-on confirmed it', () => {
    expect(expiryChoicesFor('oidc')).toEqual([7, 30]);
    for (const reauth of ['totp', 'password', 'totpSetup']) expect(expiryChoicesFor(reauth)).toEqual([7, 30, 90, 365]);
  });
});

describe('confirming with the two-factor code', () => {
  const refused = { refusal: { status: 400, body: { error: 'Confirm with your current two-factor code', reauth: 'totp' } } };

  // otplib takes a code only inside its own 30-second step (window 0, as sign-in uses it), so a
  // code made just before a step ends would fail on a busy machine. Hold the clock mid-step.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:10.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('takes the current code, spaces and all', async () => {
    const code = authenticator.generate(SECRET);
    expect(await confirmReauth(request({ totpCode: `${code.slice(0, 3)} ${code.slice(3)}` }), TOTP_USER, 'totp')).toEqual({ confirmedWith: 'totp' });
  });

  it('refuses a missing or wrong code, or one with no secret to check it against', async () => {
    const code = authenticator.generate(SECRET);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(await confirmReauth(request({}), TOTP_USER, 'totp')).toEqual(refused);
    expect(await confirmReauth(request({ totpCode: wrong }), TOTP_USER, 'totp')).toEqual(refused);
    expect(await confirmReauth(request({ password: 'right' }), TOTP_USER, 'totp')).toEqual(refused);
    expect(await confirmReauth(request({ totpCode: code }), { ...TOTP_USER, totp_secret: null }, 'totp')).toEqual(refused);
  });

  it('does not take a code twice, as sign-in does not', async () => {
    const code = authenticator.generate(SECRET);
    expect(await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp')).toEqual({ confirmedWith: 'totp' });
    expect(await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp')).toEqual(refused);
    expect(rs.store.has(`totp_used:${TOTP_USER.id}:${code}`)).toBe(true);
  });

  it('logs a wrong or replayed code as sign-in logs a failed one, and a missing or right one not at all', async () => {
    const code = authenticator.generate(SECRET);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    await confirmReauth(request({}), TOTP_USER, 'totp');
    await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp');
    expect(logAuthEvent).not.toHaveBeenCalled();
    await confirmReauth(request({ totpCode: wrong }), TOTP_USER, 'totp');
    await confirmReauth(request({ totpCode: code }), TOTP_USER, 'totp');
    expect(logAuthEvent.mock.calls).toEqual([failed('totp_fail', TOTP_USER), failed('totp_fail', TOTP_USER)]);
  });

  it('allows 5 attempts per 15 minutes on the sign-in challenge\'s own budget', async () => {
    for (let i = 0; i < 5; i++) await confirmReauth(request({ totpCode: '000000' }), TOTP_USER, 'totp');
    expect(count(`totp:${TOTP_USER.id}`)).toBe(5);
    const { refusal } = await confirmReauth(request({ totpCode: authenticator.generate(SECRET) }), TOTP_USER, 'totp');
    expect(refusal).toMatchObject({ status: 429, body: { reauth: 'totp' } });
    expect(Number(refusal.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('confirming with the password', () => {
  it('takes the right one, and gives its slot in the sign-in budget back', async () => {
    expect(await confirmReauth(request({ password: 'right' }), PASSWORD_USER, 'password')).toEqual({ confirmedWith: 'password' });
    expect(count('auth:203.0.113.7')).toBe(0);
  });

  it('refuses a wrong or missing one, and counts it as a failed sign-in from that address', async () => {
    const refused = { refusal: { status: 400, body: { error: 'Incorrect password', reauth: 'password' } } };
    expect(await confirmReauth(request({ password: 'wrong' }), PASSWORD_USER, 'password')).toEqual(refused);
    expect(await confirmReauth(request({}), PASSWORD_USER, 'password')).toEqual(refused);
    expect(await confirmReauth(request({ password: ['right'] }), PASSWORD_USER, 'password')).toEqual(refused);
    expect(count('auth:203.0.113.7')).toBe(3);
    // The budget is spent, so not even the right one is checked now.
    expect((await confirmReauth(request({ password: 'right' }), PASSWORD_USER, 'password')).refusal)
      .toMatchObject({ status: 429, body: { reauth: 'password' } });
  });

  it('logs a wrong one as a failed sign-in, and a missing or right one not at all', async () => {
    await confirmReauth(request({}), PASSWORD_USER, 'password');
    await confirmReauth(request({ password: ['right'] }), PASSWORD_USER, 'password');
    await confirmReauth(request({ password: 'right' }), PASSWORD_USER, 'password');
    expect(logAuthEvent).not.toHaveBeenCalled();
    await confirmReauth(request({ password: 'wrong' }), PASSWORD_USER, 'password');
    expect(logAuthEvent.mock.calls).toEqual([failed('login_fail', PASSWORD_USER)]);
  });

  it('logs no address that is not one, as a proxy may have written it', async () => {
    await confirmReauth(request({ password: 'wrong' }, 'not-an-address'), PASSWORD_USER, 'password');
    await confirmReauth(request({ totpCode: '000000' }, `2001:db8::1%${'x'.repeat(60)}`), TOTP_USER, 'totp');
    expect(logAuthEvent.mock.calls).toEqual([failed('login_fail', PASSWORD_USER, null), failed('totp_fail', TOTP_USER, null)]);
  });
});

describe('confirming with a sign-in through single sign-on', () => {
  const refused = { refusal: { status: 400, body: { error: 'Confirm through single sign-on first; a confirmation counts for 10 minutes', reauth: 'oidc' } } };
  const signedIn = (msAgo, providerId = CORP.id) => {
    const session = {};
    recordOidcConfirmation(session, providerId, Date.now() - msAgo);
    return session;
  };

  it('takes one in the last 10 minutes, through a provider the user has an identity at, and names it', async () => {
    const session = signedIn(OIDC_CONFIRMATION_MS - 1000);
    expect(await confirmReauth(request({}, undefined, session), SSO_USER, 'oidc')).toEqual({ confirmedWith: 'oidc', oidcProviderId: CORP.id });
  });

  it('refuses none, one too old or from the future, one through another provider, or one turned off since', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    for (const session of [
      {}, signedIn(OIDC_CONFIRMATION_MS + 1000), signedIn(-60_000), signedIn(1000, 'c0c0c0c0-0000-4000-8000-000000000002'),
      { oidcConfirmedAt: String(Date.now()), oidcConfirmedProviderId: CORP.id }, { oidcConfirmedAt: Date.now() },
    ]) {
      expect(await confirmReauth(request({ password: 'right' }, undefined, session), SSO_USER, 'oidc'), JSON.stringify(session)).toEqual(refused);
    }
    linked.set(SSO_USER.id, []);
    expect(await confirmReauth(request({}, undefined, signedIn(1000)), SSO_USER, 'oidc')).toEqual(refused);
    expect(compare).not.toHaveBeenCalled();
    expect(rs.store.size).toBe(0);
  });

  it('tells the form which providers to confirm with, and until when the last sign-in counts', async () => {
    const session = signedIn(60_000);
    expect(await oidcConfirmationState({ session }, SSO_USER)).toEqual({
      providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: new Date(session.oidcConfirmedAt + OIDC_CONFIRMATION_MS).toISOString(),
    });
    expect(await oidcConfirmationState({ session: signedIn(OIDC_CONFIRMATION_MS + 1) }, SSO_USER)).toEqual({ providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: null });
    expect(await oidcConfirmationState({ session: {} }, PASSWORD_USER)).toEqual({ providers: [], confirmedUntil: null });
  });
});
