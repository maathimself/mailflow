import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_MAIL_SCOPE = 'https://mail.google.com/';
export const GOOGLE_SCOPES = `openid email profile ${GOOGLE_MAIL_SCOPE}`;

// Errors carry a stable `code` (safe to show and to put in redirect URLs) and, when the
// provider returned one, its OAuth error code in `oauthError`. The message never includes
// the provider response body, authorization codes or tokens.
export class GoogleOAuthError extends Error {
  constructor(code, { oauthError } = {}) {
    super(`Google OAuth failed: ${code}`);
    this.name = 'GoogleOAuthError';
    this.code = code;
    if (oauthError) this.oauthError = oauthError;
  }
}

export function getGoogleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
  };
}

export function isGoogleConfigured() {
  const { clientId, clientSecret, redirectUri } = getGoogleConfig();
  return !!(clientId && clientSecret && redirectUri);
}

// createRemoteJWKSet caches and rotates keys internally; build it once per process.
let googleJwks = null;
function getGoogleJwks() {
  if (!googleJwks) googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleJwks;
}

export function hasGoogleMailScope(scope) {
  if (typeof scope !== 'string') return false;
  return scope.split(/\s+/).includes(GOOGLE_MAIL_SCOPE);
}

export function buildGoogleAuthorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
  const { clientId } = getGoogleConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${GOOGLE_AUTH_URL}?${params}`;
}

function expiryFrom(expiresIn) {
  const secs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return new Date(Date.now() + secs * 1000);
}

// POST to the token endpoint. Secrets travel only in the form body, never in the URL.
async function postToken(params) {
  let res;
  let body;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(10000),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    throw new GoogleOAuthError('authentication_failed');
  }
  if (!res.ok) {
    const oauthError = typeof body?.error === 'string' ? body.error : undefined;
    throw new GoogleOAuthError('authentication_failed', { oauthError });
  }
  return body || {};
}

export async function exchangeGoogleCode({ code, codeVerifier, redirectUri }) {
  const { clientId, clientSecret } = getGoogleConfig();
  if (!clientId || !clientSecret) throw new GoogleOAuthError('not_configured');

  const tokens = await postToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  }));
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new GoogleOAuthError('authentication_failed');
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null,
    expiresAt: expiryFrom(tokens.expires_in),
    scope: typeof tokens.scope === 'string' ? tokens.scope : '',
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
  };
}

export async function verifyGoogleIdToken({ idToken, clientId }) {
  if (!idToken || !clientId) throw new GoogleOAuthError('authentication_failed');

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getGoogleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    }));
  } catch {
    throw new GoogleOAuthError('authentication_failed');
  }

  if (typeof payload.email !== 'string' || !payload.email.includes('@')) {
    throw new GoogleOAuthError('authentication_failed');
  }
  // Strict boolean check: only a Google-verified address may be bound to a mailbox.
  if (payload.email_verified !== true) throw new GoogleOAuthError('email_not_verified');

  return {
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : null,
    sub: payload.sub,
  };
}

// Refresh a Google access token and persist the result. The stored refresh token is
// kept when Google does not return a new one. Returns the account with the plaintext
// access token, matching refreshMicrosoftToken.
export async function refreshGoogleToken(account) {
  const { clientId, clientSecret } = getGoogleConfig();
  if (!clientId || !clientSecret) throw new GoogleOAuthError('not_configured');

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) {
    throw new GoogleOAuthError('authentication_failed', { oauthError: 'missing_refresh_token' });
  }

  const tokens = await postToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: storedRefreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }));
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new GoogleOAuthError('authentication_failed');
  }

  const expiry = expiryFrom(tokens.expires_in);
  const newRefreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token
    ? tokens.refresh_token
    : null;

  await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3
    WHERE id = $4
  `, [encrypt(tokens.access_token), newRefreshToken ? encrypt(newRefreshToken) : null, expiry, account.id]);

  return { ...account, oauth_access_token: tokens.access_token, oauth_token_expiry: expiry };
}
