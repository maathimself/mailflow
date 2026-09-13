import { randomBytes } from 'crypto';
import { query } from '../db.js';
import { redisClient } from '../redis.js';
import { refreshMicrosoftToken } from './microsoftOAuth.js';
import { refreshGoogleToken } from './googleOAuth.js';

// Refresh tokens that expire within this window so a connection never starts with a
// token about to lapse mid-session.
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Cross-process refresh lock. The TTL outlives the slowest refresh (Microsoft may make
// two 10 s token calls plus DB writes) with a wide margin, so a stalled holder does not
// let a peer refresh with a superseded refresh token; a crashed holder still frees the
// account within a minute.
const LOCK_TTL_SECONDS = 60;
// The default wait stays under the 15 s timeouts that imapManager wraps token refreshes
// in, so the wait ends before the caller gives up. Callers with a longer budget pass
// `lockWaitMs`.
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
      ? 'OAuth access was revoked or expired — reconnect the account'
      : `OAuth token refresh failed: ${code}`);
    this.name = 'OAuthTokenError';
    this.code = code;
  }
}

const OAUTH_PROVIDERS = new Set(['microsoft', 'google']);

export function needsTokenRefresh(account, now = Date.now()) {
  if (!account.oauth_access_token || !account.oauth_token_expiry) return true;
  const expiryMs = new Date(account.oauth_token_expiry).getTime();
  if (!Number.isFinite(expiryMs)) return true;
  return expiryMs - now < TOKEN_REFRESH_SKEW_MS;
}

async function markReconnectRequired(accountId) {
  await query(
    `UPDATE email_accounts SET oauth_reconnect_required = true, sync_error = 'oauth_reconnect_required' WHERE id = $1`,
    [accountId],
  );
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
      await markReconnectRequired(account.id);
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

async function refreshUnderLock(accountId, options) {
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
    if (!needsTokenRefresh(row)) return row;
    return await refreshOAuthToken(row);
  } finally {
    await releaseLock(key, token);
  }
}

const inFlightRefresh = new Map(); // accountId -> Promise

// Return an account whose OAuth access token is valid for at least the skew window.
// Non-OAuth and still-fresh accounts are returned unchanged. The returned access token
// may be plaintext (just refreshed) or encrypted (re-read row); decrypt() handles both.
export function ensureFreshOAuthAccount(account, options = {}) {
  if (!account || !OAUTH_PROVIDERS.has(account.oauth_provider)) return Promise.resolve(account);
  if (!needsTokenRefresh(account)) return Promise.resolve(account);

  const existing = inFlightRefresh.get(account.id);
  if (existing) return existing;

  const p = refreshUnderLock(account.id, {
    lockWaitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    lockPollMs: options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
  }).finally(() => inFlightRefresh.delete(account.id));
  inFlightRefresh.set(account.id, p);
  return p;
}
