import { randomBytes } from 'crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { encrypt, decrypt } from '../services/encryption.js';

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

function getMsConfig() {
  return {
    clientId: process.env.MS_CLIENT_ID,
    clientSecret: process.env.MS_CLIENT_SECRET,
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI,
  };
}

// Step 1: redirect user to Microsoft login
router.get('/microsoft', (req, res) => {
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
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');
    }

    const { access_token, refresh_token, expires_in, id_token } = tokens;
    const expiry = new Date(Date.now() + expires_in * 1000);

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
        throw new Error('Could not validate Microsoft identity token — please try again');
      }
    }

    if (!email) throw new Error('Could not retrieve email address from Microsoft profile — ensure the openid, email, and profile scopes are granted');

    // Check if this account already exists
    const existing = await query(
      'SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = $2',
      [userId, email]
    );

    let accountId;
    if (existing.rows.length) {
      // Update tokens
      accountId = existing.rows[0].id;
      await query(`
        UPDATE email_accounts SET
          oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expiry = $3,
          name = $4, sync_error = NULL
        WHERE id = $5
      `, [encrypt(access_token), encrypt(refresh_token), expiry, displayName || email, accountId]);
    } else {
      // Create new account
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

    // Fetch the full account row and connect it
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    const account = accountResult.rows[0];
    imapManager.connectAccount(account).catch(err =>
      console.error(`OAuth connect failed for ${email}:`, err.message)
    );

    // Redirect back to app with success
    res.redirect('/?oauth_success=microsoft');
  } catch (err) {
    console.error('Microsoft OAuth callback error:', err.message);
    res.redirect(`/?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// Refresh an expired Microsoft token
export async function refreshMicrosoftToken(account) {
  const { clientId, clientSecret, tenantId } = getMsConfig();

  const tokenRes = await fetch(`${MICROSOFT_AUTH_URL}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decrypt(account.oauth_refresh_token),
      grant_type: 'refresh_token',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    }),
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token refresh failed');

  const { access_token, refresh_token, expires_in } = tokens;
  const expiry = new Date(Date.now() + expires_in * 1000);

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
