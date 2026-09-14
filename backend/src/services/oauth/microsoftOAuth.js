import { query } from '../db.js';
import { encrypt, decrypt } from '../encryption.js';
import { PROVIDER_FETCH_TIMEOUT_MS } from './constants.js';

export const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com';

export function getMsConfig() {
  return {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI,
  };
}

// Serialize refreshes per account so concurrent callers share one token-endpoint
// call — AAD rotates the refresh token on each refresh, and two racing refreshes
// would strand a superseded refresh token and lock the account out.
const inFlightMsRefresh = new Map(); // accountId -> Promise
export function refreshMicrosoftToken(account) {
  const existing = inFlightMsRefresh.get(account.id);
  if (existing) return existing;
  const p = doRefreshMicrosoftToken(account).finally(() => inFlightMsRefresh.delete(account.id));
  inFlightMsRefresh.set(account.id, p);
  return p;
}

// Refresh an expired Microsoft token
async function doRefreshMicrosoftToken(account) {
  const { clientId, clientSecret, tenantId } = getMsConfig();

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) {
    const err = new Error('OAuth refresh token is missing or corrupted — please reconnect your account');
    // Machine-readable marker: without a refresh token only a new consent helps.
    err.oauthError = 'missing_refresh_token';
    throw err;
  }

  // Public clients (device-code flow — personal Outlook.com/Hotmail) must NOT send a
  // client_secret on refresh: Microsoft rejects it with AADSTS90023 ("Public clients
  // can't send a client secret"). Confidential clients (auth-code flow) must send it.
  // Key this on the account's recorded flow, not on whether a secret is configured
  // globally, since one instance can host both kinds. (#216)
  const tokenUrl = `${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`;
  const postRefresh = (withSecret) => {
    const params = new URLSearchParams({
      client_id: clientId,
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    });
    if (withSecret) params.set('client_secret', clientSecret);
    return fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
  };

  const sendSecret = !!clientSecret && !account.oauth_public_client;
  let tokenRes = await postRefresh(sendSecret);
  let tokens = await tokenRes.json();
  let becamePublic = false;

  // Self-heal accounts predating the oauth_public_client column: if we sent a secret
  // and Microsoft says a public client can't (AADSTS90023), this is really a public
  // (device-code) client — retry without the secret and record it so future refreshes
  // skip the secret straight away.
  if (!tokenRes.ok && sendSecret && /AADSTS90023/i.test(tokens.error_description || tokens.error || '')) {
    tokenRes = await postRefresh(false);
    tokens = await tokenRes.json();
    becamePublic = tokenRes.ok;
  }

  if (!tokenRes.ok) {
    const err = new Error(tokens.error_description || 'Token refresh failed');
    // Keep the provider's OAuth error code (e.g. invalid_grant) so the token manager
    // can classify the failure without parsing the human-readable description.
    if (typeof tokens.error === 'string') err.oauthError = tokens.error;
    throw err;
  }

  const { access_token, refresh_token, expires_in } = tokens;
  const refreshExpiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + refreshExpiresInSecs * 1000);
  const isPublic = !!account.oauth_public_client || becamePublic;

  await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3,
      oauth_public_client = $4
    WHERE id = $5
  `, [encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expiry, isPublic, account.id]);

  // Return plaintext tokens so callers can use them immediately without decrypting
  return { ...account, oauth_access_token: access_token, oauth_token_expiry: expiry, oauth_public_client: isPublic };
}
