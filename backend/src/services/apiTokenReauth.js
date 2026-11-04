import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { redisClient } from './redis.js';
import { consume, release, reset } from './rateLimiter.js';
import { authLimiterConfig } from './authLimiter.js';
import { logAuthEvent } from './authEvents.js';
import { EXPIRY_CHOICES, normalizeIp } from './apiTokens.js';
import { clearOidcConfirmation, freshOidcConfirmation, OIDC_CONFIRMATION_MS } from './oidcConfirmation.js';

// Confirming who is at the browser before an API token is created (#617). A token can do what its
// scopes allow for as long as it lasts, past sign-out and past the session, so an unlocked browser
// must not be able to mint one quietly, and a token must not get round the server's sign-in
// policy. Linking a single sign-on identity takes the same confirmation (#714): an identity signs
// in as the account past a password reset and without its two-factor code. This module is the
// whole of that rule; routes/apiTokens.js and routes/oidc.js only ask it.
//
// - 'oidc' when the account cannot sign in with a password: password sign-in is off, or it has
//   none. Only its single sign-on provider vouches for it, so creating a token needs a sign-in
//   made through the provider in the last 10 minutes from the form's Confirm button, which makes
//   the provider ask for credentials again (oidcConfirmation.js; routes/oidc.js, action=reauth),
//   and each such sign-in confirms one token or one link. An ordinary sign-in does not count, and
//   a provider that sends no auth_time (Entra ID without that optional claim) cannot confirm at
//   all. Such a token lasts 30 days at most, which bounds how long it can outlive the provider
//   deprovisioning the user, which MailFlow cannot see.
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

// The user with what reauthFor and confirmReauth look at; undefined when there is no such user.
export const userForReauth = async userId => (await query(
  'SELECT id, username, password_hash, totp_enabled, totp_secret FROM users WHERE id = $1',
  [userId]
)).rows[0];

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
  const counts = fresh && fresh.userId === user.id && providers.some(p => p.id === fresh.providerId);
  return {
    providers: providers.map(({ slug, name }) => ({ slug, name })),
    confirmedUntil: counts ? fresh.until.toISOString() : null,
  };
}

// { confirmedWith, oidcProvider } once confirmed, oidcProvider being the single sign-on provider
// (id, issuerUrl, clientId as the confirmation saw them) when that confirmed it; or
// { refusal: { status, body, headers } } to answer with. Never 401: the web client takes a 401 for
// an expired session and signs out.
export async function confirmReauth(req, user, reauth) {
  if (reauth === 'totp') return confirmTotp(req, user, req.body?.totpCode);
  if (reauth === 'password') return confirmPassword(req, user, req.body?.password);
  if (reauth === 'oidc') return confirmOidc(req, user);
  return { refusal: { status: 403, body: { error: 'This server requires two-factor authentication. Set up an authenticator app first.', reauth } } };
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
// the sign-in (and again under locks when the token is stored, apiTokens.js). A confirmation makes
// one token, or one link: the session forgets it here, and Redis keeps its nonce as spent for as
// long as it could have counted, so two requests carrying the same one cannot both pass, as
// confirmTotp keeps a two-factor code from being used twice.
async function confirmOidc(req, user) {
  const fresh = freshOidcConfirmation(req.session);
  if (fresh && fresh.userId === user.id && (await linkedProviders(user.id)).some(p => p.id === fresh.providerId)) {
    clearOidcConfirmation(req.session);
    const firstUse = await redisClient.set(`oidc_confirmation_used:${fresh.nonce}`, '1', { NX: true, EX: Math.ceil(OIDC_CONFIRMATION_MS / 1000) });
    if (firstUse) {
      return { confirmedWith: 'oidc', oidcProvider: { id: fresh.providerId, issuerUrl: fresh.issuerUrl, clientId: fresh.clientId } };
    }
  }
  return { refusal: { status: 400, body: { error: 'Confirm through single sign-on first; each confirmation can be used once, within 10 minutes', reauth: 'oidc' } } };
}

const tooManyAttempts = (reauth, resetMs) => ({
  status: 429,
  headers: { 'Retry-After': String(Math.max(1, Math.ceil(resetMs / 1000))) },
  body: { error: 'Too many attempts. Try again later.', reauth },
});
