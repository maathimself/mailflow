import { randomBytes } from 'crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { redactEmail } from '../utils/redact.js';

// Cache JWKS fetchers per tenant — createRemoteJWKSet handles caching internally.
const jwksCache = new Map();
function getMsJwks(tenantId) {
  if (!jwksCache.has(tenantId)) {
    jwksCache.set(tenantId, createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
    ));
  }
  return jwksCache.get(tenantId);
}

const router = Router();

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com';

// In-memory store for pending device code flows — keyed by userId.
// Device codes expire in 15 minutes so no persistence is needed.
const deviceFlows = new Map();

function getMsConfig() {
  return {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI,
  };
}

// Step 1: redirect user to Microsoft login
router.get('/microsoft', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { clientId, tenantId, redirectUri } = getMsConfig();
  if (!clientId || !tenantId || !redirectUri) {
    return res.status(500).json({ error: 'Microsoft OAuth not configured. Set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REDIRECT_URI in .env' });
  }

  // Generate a random CSRF nonce for the state parameter and store it alongside
  // the userId so the callback can verify it without trusting the state value.
  const oauthNonce = randomBytes(16).toString('hex');
  req.session.oauthNonce  = oauthNonce;
  req.session.oauthUserId = req.session.userId;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    state: oauthNonce,
    prompt: 'select_account',
  });

  // Save session before redirecting so the nonce is committed to the store
  // before the external provider redirects back with the authorization code.
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  res.redirect(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/authorize?${params}`);
});

// Step 2: Microsoft redirects back here with auth code
router.get('/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('Microsoft OAuth error:', error, error_description);
    return res.redirect(`/?oauth_error=${encodeURIComponent(error_description || error)}`);
  }

  // Validate CSRF nonce BEFORE making any external requests
  if (!state || state !== req.session.oauthNonce) {
    return res.redirect(`/?oauth_error=${encodeURIComponent('Invalid OAuth state — please try again')}`);
  }
  const userId = req.session.oauthUserId;
  if (!userId) return res.redirect(`/?oauth_error=${encodeURIComponent('OAuth session expired — please try again')}`);
  delete req.session.oauthNonce;
  delete req.session.oauthUserId;

  const { clientId, clientSecret, tenantId, redirectUri } = getMsConfig();

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10000),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');
    }

    await processMicrosoftTokens(userId, tokens, { tenantId, clientId });

    // Redirect back to app with success
    res.redirect('/?oauth_success=microsoft');
  } catch (err) {
    console.error('Microsoft OAuth callback error:', err);
    res.redirect('/?oauth_error=Authentication+failed');
  }
});

// Shared: validate tokens, upsert account, connect IMAP.
async function processMicrosoftTokens(userId, tokens, { tenantId, clientId }) {
  const { access_token, refresh_token, expires_in, id_token } = tokens;
  const expiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + expiresInSecs * 1000);

  // Validate the id_token via Microsoft's JWKS, then extract user info.
  // The access_token is scoped to outlook.office.com (IMAP/SMTP) and cannot be used
  // with graph.microsoft.com, so id_token is the right source for email/name.
  let email = null;
  let displayName = null;
  if (id_token) {
    const jwks = getMsJwks(tenantId);
    const verifyOpts = { audience: clientId };
    // For multi-tenant ('common'/'organizations'/'consumers'), issuers vary per tenant,
    // so we skip issuer validation and rely on audience + signature instead.
    const fixedTenants = new Set(['common', 'organizations', 'consumers']);
    if (!fixedTenants.has(tenantId)) {
      verifyOpts.issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    }
    try {
      const { payload } = await jwtVerify(id_token, jwks, verifyOpts);
      email = payload.email || payload.preferred_username || null;
      displayName = payload.name || null;
    } catch (jwtErr) {
      console.error('Microsoft id_token validation failed:', jwtErr.message);
      throw new Error('Could not validate Microsoft identity token — please try again', { cause: jwtErr });
    }
  }

  if (!email) throw new Error('Could not retrieve email address from Microsoft profile — ensure the openid, email, and profile scopes are granted');

  const existing = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = $2',
    [userId, email]
  );

  let accountId;
  if (existing.rows.length) {
    accountId = existing.rows[0].id;
    await query(`
      UPDATE email_accounts SET
        oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expiry = $3,
        name = $4, sync_error = NULL
      WHERE id = $5
    `, [encrypt(access_token), encrypt(refresh_token), expiry, displayName || email, accountId]);
  } else {
    const colors = ['#0078d4', '#106ebe', '#005a9e', '#004578'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const result = await query(`
      INSERT INTO email_accounts (
        user_id, name, email_address, color, protocol,
        imap_host, imap_port, imap_tls,
        smtp_host, smtp_port, smtp_tls,
        auth_user,
        oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry
      ) VALUES ($1,$2,$3,$4,'imap',
        'outlook.office365.com', 993, true,
        'smtp.office365.com', 587, 'STARTTLS',
        $3,
        'microsoft', $5, $6, $7)
      RETURNING *
    `, [userId, displayName, email, color, encrypt(access_token), encrypt(refresh_token), expiry]);
    accountId = result.rows[0].id;
  }

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
  imapManager.connectAccount(accountResult.rows[0]).catch(err =>
    console.error(`OAuth connect failed for ${redactEmail(email)}:`, err.message)
  );
  return email;
}

// Step 1: initiate device code flow — returns user_code + verification_uri to the frontend.
router.post('/microsoft/device', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { clientId, tenantId } = getMsConfig();
  if (!clientId || !tenantId) {
    return res.status(400).json({ error: 'Microsoft integration not configured. Set Client ID and Tenant ID in the Integrations tab.' });
  }

  try {
    const dcRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
      }),
      signal: AbortSignal.timeout(10000),
    });
    const dc = await dcRes.json();
    if (!dcRes.ok) {
      throw new Error(dc.error_description || dc.error || 'Failed to start device code flow');
    }

    deviceFlows.set(req.session.userId, {
      deviceCode: dc.device_code,
      tenantId,
      clientId,
      expiresAt: Date.now() + dc.expires_in * 1000,
    });

    res.json({
      userCode: dc.user_code,
      verificationUri: dc.verification_uri,
      expiresIn: dc.expires_in,
      interval: dc.interval || 5,
    });
  } catch (err) {
    console.error('Device code init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: poll for token — called repeatedly by the frontend until resolved.
router.get('/microsoft/device/poll', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const flow = deviceFlows.get(req.session.userId);
  if (!flow) return res.status(400).json({ status: 'error', error: 'No pending device code flow' });
  if (Date.now() > flow.expiresAt) {
    deviceFlows.delete(req.session.userId);
    return res.json({ status: 'expired' });
  }

  try {
    const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${flow.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: flow.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const tokens = await tokenRes.json();

    if (tokens.error === 'authorization_pending') return res.json({ status: 'pending' });
    if (tokens.error === 'authorization_declined') {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'declined' });
    }
    if (tokens.error === 'expired_token') {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'expired' });
    }
    if (!tokenRes.ok) {
      deviceFlows.delete(req.session.userId);
      return res.json({ status: 'error', error: tokens.error_description || tokens.error || 'Token exchange failed' });
    }

    deviceFlows.delete(req.session.userId);
    await processMicrosoftTokens(req.session.userId, tokens, { tenantId: flow.tenantId, clientId: flow.clientId });
    res.json({ status: 'success' });
  } catch (err) {
    console.error('Device code poll error:', err.message);
    deviceFlows.delete(req.session.userId);
    res.json({ status: 'error', error: err.message });
  }
});

// Refresh an expired Microsoft token
export async function refreshMicrosoftToken(account) {
  const { clientId, clientSecret, tenantId } = getMsConfig();

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) throw new Error('OAuth refresh token is missing or corrupted — please reconnect your account');

  const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    }),
    signal: AbortSignal.timeout(10000),
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token refresh failed');

  const { access_token, refresh_token, expires_in } = tokens;
  const refreshExpiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + refreshExpiresInSecs * 1000);

  await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3
    WHERE id = $4
  `, [encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expiry, account.id]);

  // Return plaintext tokens so callers can use them immediately without decrypting
  return { ...account, oauth_access_token: access_token, oauth_token_expiry: expiry };
}

export default router;
