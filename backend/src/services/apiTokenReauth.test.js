import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real rate limiter and replay guard run against this in-memory key store.
const { rs, settings, linked } = vi.hoisted(() => ({
  rs: { store: new Map() },
  settings: { internalAuthDisabled: 'false', mfaEnforcement: 'off' },
  // Enabled providers each user has an identity at, as the query returns them.
  linked: new Map(),
}));
vi.mock('./kvStore.js', () => ({
  kv: {
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
    const refusal = { status: 403, body: { error: 'This server requires two-factor authentication. Set up an authenticator app first.', reauth: 'totpSetup' } };
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
  const refused = { refusal: { status: 400, body: { error: 'Confirm through single sign-on first; each confirmation can be used once, within 10 minutes', reauth: 'oidc' } } };
  const signedIn = (msAgo, providerId = CORP.id) => {
    const session = {};
    recordOidcConfirmation(session, SSO_USER.id, { id: providerId, issuer_url: 'https://corp.example.com', client_id: 'mailflow' }, Date.now() - msAgo);
    return session;
  };
  const confirmed = { confirmedWith: 'oidc', oidcProvider: { id: CORP.id, issuerUrl: 'https://corp.example.com', clientId: 'mailflow' } };

  it('takes one in the last 10 minutes, through a provider the user has an identity at, and names it with the issuer and client it had', async () => {
    const session = signedIn(OIDC_CONFIRMATION_MS - 1000);
    expect(await confirmReauth(request({}, undefined, session), SSO_USER, 'oidc')).toEqual(confirmed);
  });

  it('is spent by the token it confirms: the session forgets it, and a copy carrying the same nonce is refused', async () => {
    const session = signedIn(1000);
    const copy = { oidcConfirmation: { ...session.oidcConfirmation } };
    expect(await confirmReauth(request({}, undefined, session), SSO_USER, 'oidc')).toEqual(confirmed);
    expect(session.oidcConfirmation).toBeUndefined();
    expect(rs.store.has(`oidc_confirmation_used:${copy.oidcConfirmation.nonce}`)).toBe(true);
    expect(await confirmReauth(request({}, undefined, session), SSO_USER, 'oidc')).toEqual(refused);
    expect(await confirmReauth(request({}, undefined, copy), SSO_USER, 'oidc')).toEqual(refused);
    // The next sign-in is a confirmation of its own.
    expect(await confirmReauth(request({}, undefined, signedIn(500)), SSO_USER, 'oidc')).toEqual(confirmed);
  });

  it('refuses none, one too old or from the future, one for another user or through another provider, or one turned off since', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    for (const session of [
      {}, signedIn(OIDC_CONFIRMATION_MS + 1000), signedIn(-60_000), signedIn(1000, 'c0c0c0c0-0000-4000-8000-000000000002'),
      { oidcConfirmation: { ...signedIn(1000).oidcConfirmation, userId: PASSWORD_USER.id } },
      { oidcConfirmation: { ...signedIn(1000).oidcConfirmation, at: String(Date.now()) } },
      { oidcConfirmation: { ...signedIn(1000).oidcConfirmation, nonce: undefined } },
      { oidcConfirmation: { at: Date.now(), providerId: CORP.id } },
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
      providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: new Date(session.oidcConfirmation.at + OIDC_CONFIRMATION_MS).toISOString(), totpToo: false,
    });
    expect(await oidcConfirmationState({ session: signedIn(OIDC_CONFIRMATION_MS + 1) }, SSO_USER)).toEqual({ providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: null, totpToo: false });
    expect(await oidcConfirmationState({ session: {} }, PASSWORD_USER)).toEqual({ providers: [], confirmedUntil: null, totpToo: false });
  });
});

// Single sign-on now asks a user with two-factor on for their code at sign-in (secondFactor.js),
// so a fresh sign-in through the provider alone no longer confirms for them either.
describe('confirming through single sign-on with two-factor on', () => {
  const SSO_TOTP_USER = { id: 'u-sso-totp', username: 'sue', password_hash: null, totp_enabled: true, totp_secret: SECRET };
  const signedIn = () => {
    const session = {};
    recordOidcConfirmation(session, SSO_TOTP_USER.id, { id: CORP.id, issuer_url: 'https://corp.example.com', client_id: 'mailflow' }, Date.now() - 1000);
    return session;
  };
  const wrongCode = { refusal: { status: 400, body: { error: 'Confirm with your current two-factor code', reauth: 'oidc', totpToo: true } } };
  beforeEach(() => linked.set(SSO_TOTP_USER.id, [CORP]));

  it('is asked for the code as well, and still counts as a single sign-on confirmation', async () => {
    expect(await reauthFor(SSO_TOTP_USER)).toBe('oidc');
    expect((await oidcConfirmationState({ session: signedIn() }, SSO_TOTP_USER)).totpToo).toBe(true);
    const session = signedIn();
    expect(await confirmReauth(request({ totpCode: authenticator.generate(SECRET) }, undefined, session), SSO_TOTP_USER, 'oidc'))
      .toEqual({ confirmedWith: 'oidc', oidcProvider: { id: CORP.id, issuerUrl: 'https://corp.example.com', clientId: 'mailflow' } });
    expect(session.oidcConfirmation).toBeUndefined();
  });

  it('a missing or wrong code is refused without spending the sign-in', async () => {
    const session = signedIn();
    expect(await confirmReauth(request({}, undefined, session), SSO_TOTP_USER, 'oidc')).toEqual(wrongCode);
    expect(await confirmReauth(request({ totpCode: '000000' }, undefined, session), SSO_TOTP_USER, 'oidc')).toEqual(wrongCode);
    expect(session.oidcConfirmation).toBeDefined();
  });

  it('a right code without a sign-in is refused without spending the code', async () => {
    const code = authenticator.generate(SECRET);
    expect((await confirmReauth(request({ totpCode: code }, undefined, {}), SSO_TOTP_USER, 'oidc')).refusal.body.reauth).toBe('oidc');
    expect(rs.store.has(`totp_used:${SSO_TOTP_USER.id}:${code}`)).toBe(false);
    expect(count(`totp:${SSO_TOTP_USER.id}`)).toBe(0);
  });
});
