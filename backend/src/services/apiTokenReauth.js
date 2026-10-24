import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { redisClient } from './redis.js';
import { consume, release, reset } from './rateLimiter.js';
import { authLimiterConfig } from './authLimiter.js';
import { logAuthEvent } from './authEvents.js';
import { EXPIRY_CHOICES, normalizeIp } from './apiTokens.js';
import { freshOidcConfirmation } from './oidcConfirmation.js';

// Confirming who is at the browser before an API token is created (#617). A token can do what its
// scopes allow for as long as it lasts, past sign-out and past the session, so an unlocked browser
// must not be able to mint one quietly, and a token must not get round the server's sign-in
// policy. This module is the whole of that rule; routes/apiTokens.js only asks it.
//
// - 'oidc' when the account cannot sign in with a password: password sign-in is off, or it has
//   none. Only its single sign-on provider vouches for it, so creating a token needs a sign-in
//   through the provider in the last 10 minutes (oidcConfirmation.js; routes/oidc.js records it at
//   sign-in or from the form's Confirm button), and such a token lasts 30 days at most. That bounds how long it can
//   outlive the provider deprovisioning the user, which MailFlow cannot see.
// - 'totp' when the user has two-factor on: their current code, checked as the sign-in challenge
//   checks it (routes/auth.js), with the same replay guard and totp:<uid> limit.
// - 'totpSetup' when two-factor is required and the user has no authenticator: they sign in with an
//   emailed code, which the token form does not send, so they set up an authenticator first.
// - 'password' otherwise, counted against the sign-in budget auth:<ip>.
//
// A wrong code or password is logged as sign-in logs one (totp_fail, login_fail), so guessing from
// inside a session shows in the admin's security log too. What a token was confirmed with is stored
// with it, so a later change of policy can delete the tokens it no longer allows (apiTokens.js).
export async function reauthFor(user) {
  const settings = await signInSettings();
  if (!user.password_hash || settings.internal_auth_disabled === 'true') return 'oidc';
  if (user.totp_enabled) return 'totp';
  if (settings.mfa_enforcement === 'required') return 'totpSetup';
  return 'password';
}

const SSO_EXPIRY_CHOICES = [7, 30];

export function expiryChoicesFor(reauth) {
  return reauth === 'oidc' ? SSO_EXPIRY_CHOICES : EXPIRY_CHOICES;
}

async function signInSettings() {
  const { rows } = await query(
    "SELECT key, value FROM system_settings WHERE key IN ('internal_auth_disabled', 'mfa_enforcement')"
  );
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

// Enabled providers the user has an identity at, which are the ones a sign-in can confirm with.
const linkedProviders = async userId => (await query(
  `SELECT DISTINCT op.id, op.slug, op.name FROM user_identities ui
     JOIN oidc_providers op ON op.id = ui.provider_id
    WHERE ui.user_id = $1 AND op.enabled = true
    ORDER BY op.name, op.slug`,
  [userId]
)).rows;

// For the token form when it asks for 'oidc': the providers to confirm with, and until when the
// last sign-in through one counts (null when it does not).
export async function oidcConfirmationState(req, user) {
  const providers = await linkedProviders(user.id);
  const fresh = freshOidcConfirmation(req.session);
  const counts = fresh && providers.some(p => p.id === fresh.providerId);
  return {
    providers: providers.map(({ slug, name }) => ({ slug, name })),
    confirmedUntil: counts ? fresh.until.toISOString() : null,
  };
}

// { confirmedWith, oidcProviderId } once confirmed, or { refusal: { status, body, headers } } to
// answer with. Never 401: the web client takes a 401 for an expired session and signs out.
export async function confirmReauth(req, user, reauth) {
  if (reauth === 'totp') return confirmTotp(req, user, req.body?.totpCode);
  if (reauth === 'password') return confirmPassword(req, user, req.body?.password);
  if (reauth === 'oidc') return confirmOidc(req, user);
  return { refusal: { status: 403, body: { error: 'This server requires two-factor authentication. Set up an authenticator app to create API tokens.', reauth } } };
}

const TOTP_WINDOW_MS = 15 * 60 * 1000;

// Only for an answer that was given and is wrong: a missing one guesses nothing.
const logWrongAnswer = (eventType, req, user) => logAuthEvent(eventType, {
  userId: user.id, username: user.username, ip: normalizeIp(req.ip), success: false,
});

async function confirmTotp(req, user, totpCode) {
  const limitKey = `totp:${user.id}`;
  const limit = await consume(limitKey, 5, TOTP_WINDOW_MS);
  if (limit.limited) return { refusal: tooManyAttempts('totp', limit.resetMs) };
  const wrong = { refusal: { status: 400, body: { error: 'Confirm with your current two-factor code', reauth: 'totp' } } };
  const code = String(totpCode ?? '').replace(/\s/g, '');
  if (!code) return wrong;
  if (!user.totp_secret || !authenticator.verify({ token: code, secret: decrypt(user.totp_secret) })) {
    logWrongAnswer('totp_fail', req, user);
    return wrong;
  }
  const firstUse = await redisClient.set(`totp_used:${user.id}:${code}`, '1', { NX: true, EX: 90 });
  if (!firstUse) {
    logWrongAnswer('totp_fail', req, user);
    return wrong;
  }
  await reset(limitKey);
  return { confirmedWith: 'totp' };
}

async function confirmPassword(req, user, password) {
  const limitKey = `auth:${req.ip}`;
  const limit = await consume(limitKey, authLimiterConfig.maxRequests, authLimiterConfig.windowMs);
  if (limit.limited) return { refusal: tooManyAttempts('password', limit.resetMs) };
  const wrong = { refusal: { status: 400, body: { error: 'Incorrect password', reauth: 'password' } } };
  if (typeof password !== 'string' || password === '') return wrong;
  if (!(await bcrypt.compare(password, user.password_hash))) {
    logWrongAnswer('login_fail', req, user);
    return wrong;
  }
  // Only the right password gives its slot back, as for CardDAV.
  await release(limitKey);
  return { confirmedWith: 'password' };
}

// The provider is checked again here: it may have been turned off, or the identity unlinked, since
// the sign-in.
async function confirmOidc(req, user) {
  const fresh = freshOidcConfirmation(req.session);
  if (fresh && (await linkedProviders(user.id)).some(p => p.id === fresh.providerId)) {
    return { confirmedWith: 'oidc', oidcProviderId: fresh.providerId };
  }
  return { refusal: { status: 400, body: { error: 'Confirm with single sign-on first: a sign-in counts for 10 minutes', reauth: 'oidc' } } };
}

const tooManyAttempts = (reauth, resetMs) => ({
  status: 429,
  headers: { 'Retry-After': String(Math.max(1, Math.ceil(resetMs / 1000))) },
  body: { error: 'Too many attempts. Try again later.', reauth },
});
