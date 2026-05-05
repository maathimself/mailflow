import { randomBytes, createHash } from 'crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query, pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt, isEncrypted } from '../services/encryption.js';
import { imapManager } from '../index.js';
import { validateHostLiteral } from '../services/hostValidation.js';

// In-memory OIDC discovery cache keyed by issuerUrl
const discoveryCache = new Map();
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

async function getDiscovery(issuerUrl) {
  const parsed = new URL(issuerUrl);
  if (parsed.protocol !== 'https:') throw new Error('OIDC issuer URL must use HTTPS');

  const cached = discoveryCache.get(issuerUrl);
  if (cached && Date.now() - cached.cachedAt < DISCOVERY_TTL_MS) {
    return { doc: cached.doc, jwks: cached.jwks };
  }
  const wellKnown = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const res = await fetch(wellKnown, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`OIDC discovery blocked (${res.status}): the server cannot reach ${wellKnown} — ensure the well-known endpoint is publicly accessible from the MailFlow server`);
    }
    throw new Error(`OIDC discovery failed for ${issuerUrl}: ${res.status}`);
  }
  const doc = await res.json();
  const normConfigured = issuerUrl.replace(/\/$/, '');
  const normDiscovered = (doc.issuer || '').replace(/\/$/, '');
  if (normDiscovered !== normConfigured) {
    throw new Error(`OIDC issuer mismatch: configured "${normConfigured}", got "${normDiscovered}"`);
  }
  // Validate that all discovered endpoint URLs use HTTPS and don't point at
  // internal/private hosts — a compromised discovery doc could otherwise
  // redirect token or JWKS fetches to internal HTTPS services.
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const url = doc[field];
    if (!url) throw new Error(`OIDC discovery missing required field: ${field}`);
    let parsed;
    try { parsed = new URL(url); } catch {
      throw new Error(`OIDC discovery returned invalid URL for ${field}: ${url}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`OIDC discovery returned non-HTTPS ${field}: ${url}`);
    }
    const hostErr = validateHostLiteral(parsed.hostname);
    if (hostErr) throw new Error(`OIDC discovery ${field} points to a disallowed host: ${hostErr}`);
  }
  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  discoveryCache.set(issuerUrl, { doc, jwks, cachedAt: Date.now() });
  return { doc, jwks };
}

function generatePKCE() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function getRedirectUri(provider) {
  return `${process.env.APP_URL}/auth/oidc/${provider.slug}/callback`;
}

// ── Public API router (mounted at /api/auth/oidc) ─────────────────────────────

const oidcApiRouter = Router();

// List enabled providers — shown on login page, no auth required
oidcApiRouter.get('/providers', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, slug FROM oidc_providers WHERE enabled = true ORDER BY name ASC'
    );
    res.json({ providers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load providers' });
  }
});

// List identities linked to the current user
oidcApiRouter.get('/identities', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT ui.id, ui.issuer, ui.email, ui.created_at, ui.last_used_at,
              op.name AS provider_name, op.slug AS provider_slug
       FROM user_identities ui
       JOIN oidc_providers op ON op.id = ui.provider_id
       WHERE ui.user_id = $1
       ORDER BY ui.created_at ASC`,
      [req.session.userId]
    );
    res.json({ identities: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load identities' });
  }
});

// Unlink an identity from the current user
oidcApiRouter.delete('/identities/:id', requireAuth, async (req, res) => {
  try {
    // Prevent removing the last login method when no password is set
    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    const hasPassword = !!userResult.rows[0]?.password_hash;
    if (!hasPassword) {
      const countResult = await query(
        'SELECT COUNT(*) AS count FROM user_identities WHERE user_id = $1',
        [req.session.userId]
      );
      if (parseInt(countResult.rows[0].count) <= 1) {
        return res.status(400).json({ error: 'Cannot unlink your only login method. Set a password first.' });
      }
    }
    await query(
      'DELETE FROM user_identities WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlink identity' });
  }
});

export default oidcApiRouter;

// ── Browser router (mounted at /auth/oidc — no /api prefix) ──────────────────
// These routes produce browser redirects, not JSON responses.

export const oidcBrowserRouter = Router();

// Error redirect: login-flow errors go to /login?oidc_error= (shown on LoginPage);
// link-flow errors go to /?oidc_error= (shown as a toast inside MailApp).
function oidcError(res, action, message) {
  const base = action === 'link' ? '/' : '/login';
  return res.redirect(`${base}?oidc_error=${encodeURIComponent(message)}`);
}

// Step 1: redirect the browser to the OIDC provider's authorization endpoint
oidcBrowserRouter.get('/:slug/start', async (req, res) => {
  const { slug } = req.params;
  const isLink = req.query.action === 'link';
  const action = isLink ? 'link' : 'login';

  if (isLink && !req.session?.userId) {
    return oidcError(res, action, 'Not authenticated');
  }

  try {
    const provResult = await query(
      'SELECT * FROM oidc_providers WHERE slug = $1 AND enabled = true',
      [slug]
    );
    if (!provResult.rows.length) {
      return oidcError(res, action, 'SSO provider not found');
    }
    const provider = provResult.rows[0];
    const { doc } = await getDiscovery(provider.issuer_url);

    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const { verifier, challenge } = generatePKCE();

    req.session.oidcPending = {
      state,
      nonce,
      verifier,
      providerId: provider.id,
      action,
      linkUserId: isLink ? req.session.userId : undefined,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };

    const params = new URLSearchParams({
      client_id: provider.client_id,
      response_type: 'code',
      redirect_uri: getRedirectUri(provider),
      scope: provider.scopes || 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    // Save session before redirecting so the PKCE verifier and state nonce are
    // committed to the store before the provider redirects back with the code.
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    res.redirect(`${doc.authorization_endpoint}?${params}`);
  } catch (err) {
    console.error('OIDC start error:', err.message);
    return oidcError(res, action, 'Failed to initiate SSO');
  }
});

// Step 2: handle the authorization code callback from the OIDC provider
oidcBrowserRouter.get('/:slug/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  const pending = req.session.oidcPending;
  const pendingAction = pending?.action || 'login';

  if (error) {
    console.error('OIDC provider error:', error, error_description);
    return oidcError(res, pendingAction, error_description || error);
  }

  if (!pending || Date.now() > pending.expiresAt) {
    delete req.session.oidcPending;
    return oidcError(res, pendingAction, 'SSO session expired — please try again');
  }
  if (!state || state !== pending.state) {
    delete req.session.oidcPending;
    return oidcError(res, pendingAction, 'Invalid SSO state — please try again');
  }
  if (!code) {
    delete req.session.oidcPending;
    return oidcError(res, pendingAction, 'No authorization code received');
  }

  // Clear the pending state before any async work so it cannot be replayed
  delete req.session.oidcPending;

  const client = await pool.connect();
  try {
    const provResult = await client.query(
      'SELECT * FROM oidc_providers WHERE id = $1 AND enabled = true',
      [pending.providerId]
    );
    if (!provResult.rows.length) {
      return oidcError(res, pending.action, 'SSO provider not found or disabled');
    }
    const provider = provResult.rows[0];
    const { doc, jwks } = await getDiscovery(provider.issuer_url);
    const redirectUri = getRedirectUri(provider);
    const clientSecret = isEncrypted(provider.client_secret)
      ? decrypt(provider.client_secret)
      : provider.client_secret;

    // Exchange authorization code for tokens
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.client_id,
      client_secret: clientSecret,
      code_verifier: pending.verifier,
    });
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenParams.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('OIDC token exchange failed:', tokenRes.status, body);
      return oidcError(res, pending.action, 'Token exchange failed');
    }
    const tokenData = await tokenRes.json();

    // Verify id_token — strict issuer + audience validation
    let payload;
    try {
      const { payload: p } = await jwtVerify(tokenData.id_token, jwks, {
        issuer: doc.issuer,
        audience: provider.client_id,
      });
      payload = p;
    } catch (err) {
      console.error('OIDC id_token verification failed:', err.message);
      return oidcError(res, pending.action, 'Token verification failed');
    }

    if (payload.nonce !== pending.nonce) {
      return oidcError(res, pending.action, 'Nonce mismatch — please try again');
    }

    const subject = payload.sub;
    const issuer = payload.iss;
    const email = payload.email || null;
    const emailVerified = payload.email_verified === true;

    // Require verified email for login flows (skip for link, and skip if provider opts out)
    if (!emailVerified && pending.action !== 'link' && provider.require_email_verified !== false) {
      return oidcError(res, pending.action, 'Your email address must be verified with this SSO provider');
    }

    // Enforce allowed_domains if configured — requires verified email for all flows including link
    if (provider.allowed_domains) {
      const allowed = provider.allowed_domains.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
      if (allowed.length > 0) {
        if (!email || (!emailVerified && provider.require_email_verified !== false)) {
          return oidcError(res, pending.action, 'A verified email address is required for this SSO provider');
        }
        const domain = email.split('@')[1]?.toLowerCase();
        if (!allowed.includes(domain)) {
          return oidcError(res, pending.action, 'Your email domain is not permitted for this SSO provider');
        }
      }
    }

    // ── Link action: add this identity to an already-authenticated account ────
    if (pending.action === 'link') {
      if (!pending.linkUserId) {
        return oidcError(res, 'link', 'Link session invalid');
      }
      try {
        await client.query(
          `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, email_verified, last_used_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [pending.linkUserId, provider.id, issuer, subject, email, emailVerified]
        );
      } catch (err) {
        if (err.code === '23505') {
          return oidcError(res, 'link', 'This identity is already linked to another account');
        }
        throw err;
      }
      return res.redirect('/?oidc_success=linked');
    }

    // ── Login action: find or provision a MailFlow user ───────────────────────
    const existingId = await client.query(
      'SELECT user_id FROM user_identities WHERE issuer = $1 AND subject = $2',
      [issuer, subject]
    );

    if (existingId.rows.length) {
      // Known identity — look up the user and log in
      const userId = existingId.rows[0].user_id;
      const userRow = await client.query(
        'SELECT id, username, is_admin FROM users WHERE id = $1',
        [userId]
      );
      if (!userRow.rows.length) {
        return oidcError(res, 'login', 'Account not found');
      }
      const user = userRow.rows[0];
      await client.query(
        'UPDATE user_identities SET last_used_at = NOW() WHERE issuer = $1 AND subject = $2',
        [issuer, subject]
      );
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.isAdmin = user.is_admin;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      imapManager.connectAllForUser(user.id);
      return res.redirect('/?oidc_success=login');
    }

    // No existing identity — consult provisioning_mode
    const mode = provider.provisioning_mode;

    if (mode === 'disabled') {
      return oidcError(res, 'login', 'SSO login is not enabled for new users on this server');
    }

    if (mode === 'login_existing_only') {
      // Match by email to an existing account and link automatically
      if (!email || (!emailVerified && provider.require_email_verified !== false)) {
        return oidcError(res, 'login', 'No account found. Contact your administrator.');
      }
      const userByEmail = await client.query(
        'SELECT id, username, is_admin FROM users WHERE username = $1',
        [email.toLowerCase()]
      );
      if (!userByEmail.rows.length) {
        return oidcError(res, 'login', 'No account found matching this email. Contact your administrator.');
      }
      const user = userByEmail.rows[0];
      await client.query(
        `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, email_verified, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (issuer, subject) DO UPDATE SET last_used_at = NOW()`,
        [user.id, provider.id, issuer, subject, email, emailVerified]
      );
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.isAdmin = user.is_admin;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      imapManager.connectAllForUser(user.id);
      return res.redirect('/?oidc_success=login');
    }

    if (mode === 'open') {
      // Create a new MailFlow account from the SSO identity
      if (!email || !emailVerified) {
        return oidcError(res, 'login', 'A verified email address is required to create an account via SSO');
      }
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(7936352)');
        // Reuse existing account if username (email) already taken
        const existingUser = await client.query(
          'SELECT id, username, is_admin FROM users WHERE username = $1',
          [email.toLowerCase()]
        );
        let user;
        if (existingUser.rows.length) {
          user = existingUser.rows[0];
        } else {
          const countRow = await client.query('SELECT COUNT(*) AS count FROM users');
          const isFirstUser = parseInt(countRow.rows[0].count) === 0;
          const newUser = await client.query(
            'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, NULL, $2) RETURNING id, username, is_admin',
            [email.toLowerCase(), isFirstUser]
          );
          user = newUser.rows[0];
          if (isFirstUser) {
            await client.query(
              `INSERT INTO system_settings (key, value, updated_at) VALUES ('registration_open', 'false', NOW())
               ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW()`
            );
          }
        }
        await client.query(
          `INSERT INTO user_identities (user_id, provider_id, issuer, subject, email, email_verified, last_used_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (issuer, subject) DO UPDATE SET last_used_at = NOW()`,
          [user.id, provider.id, issuer, subject, email, emailVerified]
        );
        await client.query('COMMIT');
        await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.isAdmin = user.is_admin;
        await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
        imapManager.connectAllForUser(user.id);
        return res.redirect('/?oidc_success=login');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    return oidcError(res, 'login', 'Unknown provisioning configuration');
  } catch (err) {
    console.error('OIDC callback error:', err.message);
    return oidcError(res, pending?.action || 'login', 'Authentication failed. Please try again.');
  } finally {
    client.release();
  }
});
