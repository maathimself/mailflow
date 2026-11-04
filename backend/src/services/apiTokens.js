import crypto from 'crypto';
import net from 'net';
import { query, withTransaction } from './db.js';

// Personal API tokens (#617). A token is `mfat_` and 32 random bytes in base64url; only its
// SHA-256 is stored. Neither the token nor its hash may go into a log line or an Error message:
// the last error handler logs whole errors.
export const TOKEN_PREFIX = 'mfat_';
const TOKEN_RE = /^mfat_[A-Za-z0-9_-]{43}$/;
export const API_TOKEN_SCOPES = ['read', 'organize', 'draft'];
// In days. Every token expires: there is no choice of none.
export const EXPIRY_CHOICES = [7, 30, 90, 365];
export const MAX_TOKENS_PER_USER = 20;
const MAX_NAME_CHARS = 60;

export const INVALID_TOKEN_ERROR = 'Invalid or expired API token';
export const TOKENS_OFF_ERROR = 'API tokens are turned off on this server';

export function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function isTokenFormat(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// The credential of an `Authorization: Bearer mfat_…` header, or null for any other value. Only
// such a header makes a token request: a Bearer JWT that an auth proxy adds in front of MailFlow,
// Basic, or anything else is left to the cookie session, as before tokens existed.
export function apiTokenCredential(authorization) {
  if (typeof authorization !== 'string') return null;
  const space = authorization.search(/[ \t]/);
  if (space < 0 || authorization.slice(0, space).toLowerCase() !== 'bearer') return null;
  const credential = authorization.slice(space).trim();
  return credential.startsWith(TOKEN_PREFIX) ? credential : null;
}

// A non-empty list of known scopes, in canonical order, or null.
export function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) return null;
  if (scopes.some(s => !API_TOKEN_SCOPES.includes(s)) || new Set(scopes).size !== scopes.length) return null;
  return API_TOKEN_SCOPES.filter(s => scopes.includes(s));
}

// Counted in characters, as VARCHAR(60) counts them.
export function normalizeTokenName(raw) {
  if (typeof raw !== 'string') return { error: 'Give the token a name' };
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_CHARS) return { error: `Token names are 1 to ${MAX_NAME_CHARS} characters` };
  if (/\p{Cc}/u.test(name)) return { error: 'Token names cannot contain control characters' };
  return { name };
}

export function expiryDate(days, now = Date.now()) {
  return new Date(now + days * 24 * 60 * 60 * 1000);
}

// req.ip comes from X-Forwarded-For as far as trust proxy reaches, so it is whatever a proxy (or a
// client it trusts too far) wrote. Anything but an address would make a limiter key of its own
// choosing, and one longer than the VARCHAR(45) columns would make their INSERT fail.
export function normalizeIp(ip) {
  return typeof ip === 'string' && ip.length <= 45 && net.isIP(ip) ? ip : null;
}

export function answerInvalidToken(res) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="MailFlow", error="invalid_token"');
  return res.status(401).json({ error: INVALID_TOKEN_ERROR });
}

// The instance switch, read on every token request, so it is cached like connectionPolicy.js.
// A read that was already under way when the cache was invalidated is not cached: it may
// predate the change.
const SETTINGS_TTL_MS = 30_000;
let enabledCache = null;
let enabledCachedAt = 0;
let settingsGeneration = 0;

export async function apiTokensEnabled() {
  const now = Date.now();
  if (enabledCache !== null && now - enabledCachedAt < SETTINGS_TTL_MS) return enabledCache;
  const generation = settingsGeneration;
  const { rows } = await query("SELECT value FROM system_settings WHERE key = 'api_tokens_enabled'");
  const enabled = rows[0]?.value === 'true';
  if (generation === settingsGeneration) {
    enabledCache = enabled;
    enabledCachedAt = now;
  }
  return enabled;
}

// Call after PATCH /api/admin/settings, so turning tokens off takes effect at once.
export function invalidateApiTokenSettingsCache() {
  settingsGeneration++;
  enabledCache = null;
}

// last_used_at / last_used_ip, written at most once per token per minute, as lastSeen.js does
// for users. Fire-and-forget: a failed write only leaves the time a little older.
export const RECORD_USE_EVERY_MS = 60 * 1000;
const useRecorded = new Map();

export function recordTokenUse(tokenId, ip, { now = Date.now(), write = query } = {}) {
  const previous = useRecorded.get(tokenId);
  if (previous !== undefined && now - previous < RECORD_USE_EVERY_MS) return;
  if (useRecorded.size >= 10_000) {
    for (const [id, at] of useRecorded) if (now - at >= RECORD_USE_EVERY_MS) useRecorded.delete(id);
  }
  useRecorded.set(tokenId, now);
  Promise.resolve()
    .then(() => write('UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1', [tokenId, ip]))
    .catch(err => {
      useRecorded.delete(tokenId);
      console.warn('[apiToken] could not record token use:', err.message);
    });
}

export function resetTokenUseForTests() {
  useRecorded.clear();
}

const knownScopes = scopes => (Array.isArray(scopes) ? scopes.filter(s => API_TOKEN_SCOPES.includes(s)) : []);

// The token a hash belongs to, with its owner's name, or null. `expired` is decided by the
// database clock, the one expires_at is compared with everywhere else.
export async function findTokenByHash(tokenHash) {
  const { rows: [row] } = await query(
    `SELECT t.id, t.user_id, t.name, t.scopes, t.created_at, t.expires_at,
            t.expires_at <= NOW() AS expired, u.username
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [tokenHash]
  );
  return row ? { ...row, scopes: knownScopes(row.scopes) } : null;
}

// Whether a token that authenticated a request still would: it has not been revoked or expired
// since, and tokens are still turned on.
export async function tokenStillValid(tokenId) {
  if (!(await apiTokensEnabled())) return false;
  const { rows } = await query(
    'SELECT 1 FROM api_tokens WHERE id = $1 AND expires_at > NOW()',
    [tokenId]
  );
  return rows.length > 0;
}

const TOKEN_COLUMNS = `id, name, scopes, created_at, expires_at, last_used_at, last_used_ip,
  expires_at <= NOW() AS expired`;

export function publicToken(row) {
  return {
    id: row.id,
    name: row.name,
    scopes: knownScopes(row.scopes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    expired: row.expired === true,
  };
}

// Newest first. Expired tokens are listed until they are revoked, and count towards the limit.
export async function listTokens(userId) {
  const { rows } = await query(
    `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC, id`,
    [userId]
  );
  return rows.map(publicToken);
}

export async function countTokens(userId) {
  const { rows: [{ count }] } = await query('SELECT COUNT(*)::int AS count FROM api_tokens WHERE user_id = $1', [userId]);
  return count;
}

const POLICY_CHANGED = Object.freeze({ policyChanged: true });
const SIGN_IN_CHANGED = Object.freeze({ signInChanged: true });

// Whether the users row still says what it did when the confirmation was checked against it. A
// password reset or set changes the hash; two-factor turned off changes the flag and the secret,
// and set up anew the secret; each of those deletes the user's tokens, or the ones it confirmed.
const sameSignIn = (current, confirmed) => current.password_hash === confirmed.password_hash
  && current.totp_enabled === confirmed.totp_enabled && current.totp_secret === confirmed.totp_secret;

// Returns { token, apiToken } with the secret, which is never available again; null when the user
// already has MAX_TOKENS_PER_USER tokens; { policyChanged: true } when the server's sign-in policy
// no longer allows a token confirmed this way; or { signInChanged: true } when what confirmed it no
// longer holds. `user` is the users row the confirmation was checked against (id, password_hash,
// totp_enabled, totp_secret); confirmedWith is what it was confirmed with, and oidcProvider the
// provider when that was single sign-on, with the issuer and client it had (apiTokenReauth.js).
export async function createToken(user, { name, scopes, expiresAt, confirmedWith, oidcProvider = null }) {
  const token = generateToken();
  const result = await withTransaction(async client => {
    // One creation at a time per user, so two at once cannot both pass the limit. It is also the
    // lock every change to how the user signs in takes first (a password reset or set, two-factor
    // turned off, an identity unlinked, each deleting tokens in its own transaction): one that
    // committed before this shows in the row and refuses the token; one still to come waits here,
    // then sees the token and deletes it with the rest.
    const { rows: [current] } = await client.query(
      'SELECT password_hash, totp_enabled, totp_secret FROM users WHERE id = $1 FOR UPDATE', [user.id]
    );
    if (!current || !sameSignIn(current, user)) return SIGN_IN_CHANGED;
    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*)::int AS count FROM api_tokens WHERE user_id = $1',
      [user.id]
    );
    if (count >= MAX_TOKENS_PER_USER) return null;
    if (confirmedWith === 'oidc') {
      // The provider, held shared: an admin turning it off or pointing it at another issuer or
      // client (routes/admin.js, which deletes its tokens in the same transaction) either
      // committed first and shows here, or waits for this commit and then takes this token too.
      // Deleting the provider waits the same way, then cascades to it.
      const { rows: [provider] } = await client.query(
        'SELECT enabled, issuer_url, client_id FROM oidc_providers WHERE id = $1 FOR SHARE', [oidcProvider.id]
      );
      if (!provider?.enabled || provider.issuer_url !== oidcProvider.issuerUrl || provider.client_id !== oidcProvider.clientId) {
        return SIGN_IN_CHANGED;
      }
      // The user's identities there, held against deletion: FOR KEY SHARE stops an unlink, which
      // takes the users lock above anyway, and not a sign-in updating last_used_at. None left means
      // an unlink committed first.
      const { rows: identities } = await client.query(
        'SELECT 1 FROM user_identities WHERE user_id = $1 AND provider_id = $2 FOR KEY SHARE', [user.id, oidcProvider.id]
      );
      if (!identities.length) return SIGN_IN_CHANGED;
    }
    // The sign-in policy, checked again here and held shared until the commit. routes/apiTokens.js
    // checked it before the confirmation, but an admin may have required two-factor or turned
    // password sign-in off since; their change (routes/admin.js, which updates these rows and
    // deletes the tokens it no longer allows in one transaction) now waits for this insert and
    // sees the row, or this read waits for it and refuses. Both rows are seeded by migrations.
    const { rows: policy } = await client.query(
      "SELECT key, value FROM system_settings WHERE key IN ('mfa_enforcement', 'internal_auth_disabled') FOR SHARE"
    );
    if (!confirmationAllowed(Object.fromEntries(policy.map(r => [r.key, r.value])), confirmedWith)) return POLICY_CHANGED;
    const { rows: [inserted] } = await client.query(
      `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at, confirmed_with, oidc_provider_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING ${TOKEN_COLUMNS}`,
      [user.id, name, hashToken(token), JSON.stringify(scopes), expiresAt, confirmedWith, oidcProvider?.id ?? null]
    );
    return inserted;
  });
  if (!result) return null;
  if (result === POLICY_CHANGED || result === SIGN_IN_CHANGED) return result;
  return { token, apiToken: publicToken(result) };
}

// The revoked token's name, or null when the user has no such token.
export async function deleteToken(userId, tokenId) {
  const { rows: [row] } = await query(
    'DELETE FROM api_tokens WHERE id = $1 AND user_id = $2 RETURNING name',
    [tokenId, userId]
  );
  return row ? row.name : null;
}

// A change to the server's sign-in policy deletes the tokens it no longer allows (#617), by what
// each was confirmed with when it was made. Deleting rather than suspending them means turning the
// policy off again cannot bring them back. Each of these runs in the caller's transaction, so the
// setting and the tokens it removes change together, and returns how many tokens it deleted.
const POLICY_CONFIRMATIONS = {
  // Password sign-in is off, so only the single sign-on provider vouches for anyone.
  ssoOnly: ['oidc'],
  // Two-factor required: a password alone no longer does. Single sign-on stays, as it does at
  // sign-in, which leaves two-factor to the provider.
  mfaRequired: ['totp', 'oidc'],
};

// Whether a token confirmed this way may exist under the sign-in policy in `settings`: the
// system_settings rows mfa_enforcement and internal_auth_disabled, by key. The same rule
// revokeTokensForPolicy applies after the fact.
export function confirmationAllowed(settings, confirmedWith) {
  if (settings.internal_auth_disabled === 'true' && !POLICY_CONFIRMATIONS.ssoOnly.includes(confirmedWith)) return false;
  if (settings.mfa_enforcement === 'required' && !POLICY_CONFIRMATIONS.mfaRequired.includes(confirmedWith)) return false;
  return true;
}

export async function revokeTokensForPolicy(client, policy) {
  const allowed = POLICY_CONFIRMATIONS[policy];
  if (!allowed) throw new Error(`No API token policy named ${policy}`);
  const { rowCount } = await client.query(
    'DELETE FROM api_tokens WHERE NOT (confirmed_with = ANY($1::text[]))',
    [allowed]
  );
  return rowCount;
}

// The tokens confirmed through a single sign-on provider that is being turned off. Deleting the
// provider deletes them too, by the foreign key.
export async function revokeProviderTokens(client, providerId) {
  const { rowCount } = await client.query('DELETE FROM api_tokens WHERE oidc_provider_id = $1', [providerId]);
  return rowCount;
}

// ", and deleted 3 API tokens" for the [admin] log line that reports the change, or nothing.
export const revokedTokensNote = count => (count > 0 ? `, and deleted ${count} API token${count === 1 ? '' : 's'}` : '');
