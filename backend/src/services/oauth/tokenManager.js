import { randomBytes } from 'crypto';
import { query } from '../db.js';
import { redisClient } from '../redis.js';
import { refreshMicrosoftToken } from './microsoftOAuth.js';
import { refreshGoogleToken } from './googleOAuth.js';
import { OAUTH_RECONNECT_REQUIRED_MESSAGE, isOAuthAccount } from './constants.js';

// Refresh tokens that expire within this window so a connection never starts with a
// token about to lapse mid-session.
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Cross-process refresh lock. The TTL outlives the slowest refresh (Microsoft may make
// two 10 s token calls plus DB writes) with a wide margin, so a stalled holder does not
// let a peer refresh with a superseded refresh token; a crashed holder still frees the
// account within a minute.
const LOCK_TTL_SECONDS = 60;
// Default wait for callers without a tighter deadline (SMTP send, routes). Callers that race
// the refresh against a timeout (imapManager) pass a shorter `lockWaitMs` so the wait plus the
// 10 s provider token call still fits inside their budget.
const DEFAULT_LOCK_WAIT_MS = 10000;
const DEFAULT_LOCK_POLL_MS = 200;
const RELEASE_LOCK_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

// Provider error codes that no retry can fix: only a new user consent helps.
const RECONNECT_OAUTH_ERRORS = new Set(['invalid_grant', 'missing_refresh_token']);

// Stable, secret-free error. `code` is one of: oauth_reconnect_required,
// oauth_refresh_failed, oauth_unsupported_provider, oauth_account_not_found.
export class OAuthTokenError extends Error {
  constructor(code) {
    super(code === 'oauth_reconnect_required'
      ? OAUTH_RECONNECT_REQUIRED_MESSAGE
      : `OAuth token refresh failed: ${code}`);
    this.name = 'OAuthTokenError';
    this.code = code;
  }
}

export function needsTokenRefresh(account, now = Date.now()) {
  if (!account.oauth_access_token || !account.oauth_token_expiry) return true;
  const expiryMs = new Date(account.oauth_token_expiry).getTime();
  if (!Number.isFinite(expiryMs)) return true;
  return expiryMs - now < TOKEN_REFRESH_SKEW_MS;
}

// Compare-and-set on the refresh token the provider rejected: a reconsent may commit new
// tokens while the refresh is in flight, and those must not be flagged. Returns false when
// the stored refresh token changed meanwhile.
async function markReconnectRequired(accountId, rejectedRefreshToken) {
  const result = await query(
    `UPDATE email_accounts SET oauth_reconnect_required = true, sync_error = 'oauth_reconnect_required'
     WHERE id = $1 AND oauth_refresh_token IS NOT DISTINCT FROM $2`,
    [accountId, rejectedRefreshToken ?? null],
  );
  return result?.rowCount !== 0;
}

// Refresh through the provider module, then normalize failures. Provider modules persist
// the new tokens themselves in a single UPDATE that keeps the stored refresh token when
// none is returned. The original error is intentionally not attached as `cause`: its
// message may contain the provider response.
export async function refreshOAuthToken(account) {
  let refresh;
  if (account.oauth_provider === 'microsoft') refresh = refreshMicrosoftToken;
  else if (account.oauth_provider === 'google') refresh = refreshGoogleToken;
  else throw new OAuthTokenError('oauth_unsupported_provider');

  try {
    return await refresh(account);
  } catch (err) {
    if (RECONNECT_OAUTH_ERRORS.has(err?.oauthError)) {
      if (!(await markReconnectRequired(account.id, account.oauth_refresh_token))) {
        // The grant was replaced during the provider call; the caller retries with the new row.
        console.error(`OAuth refresh for account ${account.id} (${account.oauth_provider}) raced a token update`);
        throw new OAuthTokenError('oauth_refresh_failed');
      }
      console.error(`OAuth refresh for account ${account.id} (${account.oauth_provider}) needs reconnect`);
      throw new OAuthTokenError('oauth_reconnect_required');
    }
    const reason = typeof err?.code === 'string' ? err.code : 'unknown';
    console.error(`OAuth refresh for account ${account.id} (${account.oauth_provider}) failed: ${reason}`);
    throw new OAuthTokenError('oauth_refresh_failed');
  }
}

async function acquireLock(key, { lockWaitMs, lockPollMs }) {
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    const ok = await redisClient.set(key, token, { NX: true, EX: LOCK_TTL_SECONDS });
    if (ok) return token;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, lockPollMs));
  }
}

async function releaseLock(key, token) {
  try {
    await redisClient.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [token] });
  } catch (err) {
    // The lock expires on its own; a failed release only delays the next refresh.
    console.error(`OAuth refresh lock release failed: ${err?.message || 'unknown error'}`);
  }
}

const expiryTime = (account) => {
  const ms = account?.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
};

async function refreshUnderLock(account, options) {
  const accountId = account.id;
  const key = `oauth:refresh-lock:${accountId}`;
  const token = await acquireLock(key, options);
  if (!token) throw new OAuthTokenError('oauth_refresh_failed');
  try {
    // Re-read after acquiring the lock: another process may have refreshed already,
    // and refreshing with a superseded refresh token could strand the account.
    const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    const row = rows[0];
    if (!row) throw new OAuthTokenError('oauth_account_not_found');
    if (row.oauth_reconnect_required) throw new OAuthTokenError('oauth_reconnect_required');
    // A forced refresh means the provider rejected the caller's token: reuse the row only when
    // it already holds a newer token than the rejected one (a peer refreshed in the meantime).
    if (!needsTokenRefresh(row) && (!options.force || expiryTime(row) > expiryTime(account))) return row;
    return await refreshOAuthToken(row);
  } finally {
    await releaseLock(key, token);
  }
}

const inFlightRefresh = new Map(); // accountId -> { promise, force }

// Return an account whose OAuth access token is valid for at least the skew window.
// Non-OAuth and still-fresh accounts are returned unchanged. The returned access token
// may be plaintext (just refreshed) or encrypted (re-read row); decrypt() handles both.
// `force: true` bypasses the skew window; pass it when the provider rejected the token the
// caller holds (IMAP AUTHENTICATE or SMTP AUTH failure).
export function ensureFreshOAuthAccount(account, options = {}) {
  if (!isOAuthAccount(account)) return Promise.resolve(account);
  const force = !!options.force;
  if (!force && !needsTokenRefresh(account)) return Promise.resolve(account);

  const existing = inFlightRefresh.get(account.id);
  if (existing) {
    if (!force || existing.force) return existing.promise;
    // A non-forced refresh may resolve to the stored row without calling the provider, and that
    // row can hold the very token this caller just had rejected. Take its result only when it is
    // newer than the rejected token; otherwise run a forced refresh once it has settled.
    return existing.promise.then((row) => (
      expiryTime(row) > expiryTime(account) ? row : ensureFreshOAuthAccount(account, options)
    ));
  }

  const promise = refreshUnderLock(account, {
    force,
    lockWaitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    lockPollMs: options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
  }).finally(() => inFlightRefresh.delete(account.id));
  inFlightRefresh.set(account.id, { promise, force });
  return promise;
}
