import { randomBytes } from 'crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query, withTransaction } from '../services/db.js';
import { findOwnedAccount } from '../services/ownership.js';
import { imapManager } from '../index.js';
import { providerProfile, PROVIDERS } from '../services/imapManager.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { redactEmail } from '../utils/redact.js';
import { getMsConfig, getMsDeviceClient, msBuiltinAppEnabled, msRefreshClient, ownAppAdmitsPersonal } from '../services/microsoftOAuthClient.js';
import { MAILFLOW_MS_CLIENT_ID } from '../services/microsoftBuiltinApp.js';
import { getGoogleConfig } from '../services/oauthEnv.js';
import { classifyRefreshFailure, clearRefreshFailure, isPersonalMicrosoftAccount, noteFreshToken, terminalRefreshError } from '../services/accountErrorCode.js';
import { isUuid } from '../utils/uuid.js';
import { reportConnect } from '../services/connectReport.js';

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

// Signing in again to repair an account (a "Sign in again" action) names that account. If the
// person signs in to the provider as someone else, nothing is stored: the sign-in would
// otherwise quietly add a second account and leave the broken one as it was.
export class WrongAccountError extends Error {
  constructor(signedInAs, expected) {
    super(`Signed in as ${signedInAs}, not ${expected}`);
    this.signedInAs = signedInAs;
    this.expected = expected;
  }
}

// The account a repair sign-in is for, if it is this user's and uses this provider. A repair
// request for anything else is refused up front rather than at the end of the sign-in.
async function repairTarget(userId, accountId, provider) {
  if (accountId === undefined || accountId === null || accountId === '') return null;
  // Not a UUID cannot be an account: refuse it as one that does not exist, before the query.
  if (!isUuid(String(accountId))) throw Object.assign(new Error('Account not found'), { status: 404 });
  const row = await findOwnedAccount(userId, String(accountId), {
    columns: 'id, email_address, oauth_provider, oauth_client_id, oauth_tenant_id',
  });
  if (!row || row.oauth_provider !== provider) {
    throw Object.assign(new Error('Account not found'), { status: 404 });
  }
  return row;
}

// How a redirect sign-in ended is kept in the session for the page to fetch (GET
// /oauth/result), not put in the URL: addresses and server text do not belong in access logs
// or browser history. The URL carries only a short code.
function rememberResult(req, result) {
  if (req.session) req.session.oauthResult = result;
}
function wrongAccountRedirect(req, err) {
  rememberResult(req, { error: 'wrong_account', signedInAs: err.signedInAs, expected: err.expected });
  return '/?oauth_error=wrong_account&oauth_result=1';
}

// The outcome of the last redirect sign-in, once: read and forgotten.
router.get('/result', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = req.session.oauthResult || null;
  delete req.session.oauthResult;
  res.json({ result });
});

// How long the redirect callback waits for the mailbox before answering: shorter than the
// device-code poll's, so the token exchange, the key fetch and this wait fit well inside the
// proxy's 60-second read timeout for /oauth/.
const CALLBACK_CONNECT_WAIT_MS = 15000;

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com';

// In-memory store for pending device code flows — keyed by userId.
// Device codes expire in 15 minutes so no persistence is needed.
const deviceFlows = new Map();

// Step 1: redirect user to Microsoft login
router.get('/microsoft', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { clientId, tenantId, redirectUri } = getMsConfig();
  if (!clientId || !tenantId || !redirectUri) {
    return res.status(500).json({ error: 'Microsoft OAuth not configured. Set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REDIRECT_URI in .env' });
  }
  let repair;
  try { repair = await repairTarget(req.session.userId, req.query.accountId, 'microsoft'); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

  // Generate a random CSRF nonce for the state parameter and store it alongside
  // the userId so the callback can verify it without trusting the state value.
  const oauthNonce = randomBytes(16).toString('hex');
  req.session.oauthNonce  = oauthNonce;
  req.session.oauthUserId = req.session.userId;
  req.session.oauthRepairAccountId = repair?.id ?? null;

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
  const repairAccountId = req.session.oauthRepairAccountId ?? null;
  delete req.session.oauthNonce;
  delete req.session.oauthUserId;
  delete req.session.oauthRepairAccountId;

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

    // Authorization-code flow uses the client secret → confidential client.
    const signedIn = await processMicrosoftTokens(userId, tokens, { tenantId, clientId, publicClient: false, repairAccountId });

    // Back to the app once the mailbox has answered (bounded), with how it went: the page that
    // started the sign-in shows "connected" only when it is.
    const report = await connectReportFor(signedIn, CALLBACK_CONNECT_WAIT_MS);
    rememberResult(req, { provider: 'microsoft', accountId: signedIn.accountId, email: signedIn.email, ...report });
    res.redirect('/?oauth_success=microsoft&oauth_result=1');
  } catch (err) {
    if (err instanceof WrongAccountError) return res.redirect(wrongAccountRedirect(req, err));
    console.error('Microsoft OAuth callback error:', err);
    res.redirect(`/?oauth_error=${err.publicMessage ? encodeURIComponent(err.publicMessage) : 'Authentication+failed'}`);
  }
});

// Shared: validate tokens, upsert account, connect IMAP.
async function processMicrosoftTokens(userId, tokens, { tenantId, clientId, publicClient = false, repairAccountId = null }) {
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
      // For multi-tenant configs the issuer check is skipped above, so validate that
      // the iss claim matches the token's own tid.  This prevents cross-tenant identity
      // injection where an attacker creates a Microsoft tenant with the victim's email,
      // obtains a JWT signed by Microsoft, and submits it to a MailFlow instance
      // configured for 'common'.
      if (fixedTenants.has(tenantId) && payload.tid && payload.iss) {
        const expectedIss = `https://login.microsoftonline.com/${payload.tid}/v2.0`;
        if (payload.iss !== expectedIss) {
          throw new Error(`id_token issuer mismatch: expected ${expectedIss}, got ${payload.iss}`);
        }
      }
      email = payload.email || payload.preferred_username || null;
      displayName = payload.name || null;
    } catch (jwtErr) {
      console.error('Microsoft id_token validation failed:', jwtErr.message);
      throw new Error('Could not validate Microsoft identity token — please try again', { cause: jwtErr });
    }
  }

  if (!email) throw new Error('Could not retrieve email address from Microsoft profile — ensure the openid, email, and profile scopes are granted');

  // Serialize the check-then-insert per (user, email) with a transaction-scoped
  // advisory lock. Two OAuth callbacks racing for the same mailbox would otherwise
  // both miss the SELECT and each INSERT, producing duplicate account rows. The
  // second waiter blocks until the first commits, then sees the row and updates it.
  const account = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`oauth-account:${userId}:${email.toLowerCase()}`]);

    // A repair updates the account it was started for, and only when the person signed in as
    // that account's address (compared without case: providers do not preserve it).
    const existing = repairAccountId
      ? await findOwnedAccount(userId, repairAccountId, { columns: 'id, imap_host, oauth_provider, email_address', client })
      : (await client.query(
        'SELECT id, imap_host, oauth_provider FROM email_accounts WHERE user_id = $1 AND email_address = $2',
        [userId, email])).rows[0];
    if (repairAccountId) {
      if (!existing) throw Object.assign(new Error('Account not found'), { publicMessage: 'Account not found' });
      if (existing.email_address.trim().toLowerCase() !== email.trim().toLowerCase()) {
        throw new WrongAccountError(email, existing.email_address);
      }
    }

    let accountId;
    if (existing) {
      // A Microsoft account can use any address as its sign-in name, a Gmail one included.
      // Switching a mailbox hosted elsewhere to XOAUTH2 would break it, and oauth_provider
      // cannot be changed back from the account settings. The user is told why.
      if (providerProfile(existing) !== PROVIDERS.microsoft) {
        const reason = 'An account with this address is already set up on a non-Microsoft mail server';
        throw Object.assign(new Error(reason), { publicMessage: reason });
      }
      accountId = existing.id;
      await client.query(`
        UPDATE email_accounts SET
          oauth_provider = 'microsoft',
          oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expiry = $3,
          name = $4, oauth_public_client = $5, sync_error = NULL, sync_error_code = NULL,
          oauth_client_id = $7, oauth_tenant_id = $8
        WHERE id = $6
      `, [encrypt(access_token), encrypt(refresh_token), expiry, displayName || email, publicClient, accountId, clientId, tenantId]);
    } else {
      const colors = ['#0078d4', '#106ebe', '#005a9e', '#004578'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const result = await client.query(`
        INSERT INTO email_accounts (
          user_id, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client, oauth_client_id, oauth_tenant_id
        ) VALUES ($1,$2,$3,$4,'imap',
          'outlook.office365.com', 993, true,
          'smtp.office365.com', 587, 'STARTTLS',
          $3,
          'microsoft', $5, $6, $7,
          $8, $9, $10)
        RETURNING *
      `, [userId, displayName, email, color, encrypt(access_token), encrypt(refresh_token), expiry, publicClient, clientId, tenantId]);
      accountId = result.rows[0].id;
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return accountResult.rows[0];
  });

  // Signing in again is how a user fixes an account that stopped connecting, so drop any
  // backoff first. Auth failures back off for up to six hours, and connectAccount would
  // return early on it with sync_error already cleared: a silent no-op.
  imapManager.clearConnectCooldown(account.id);
  clearRefreshFailure(account.id);
  noteFreshToken(account.id);
  const connecting = imapManager.connectAccount(account).catch((err) => {
    console.error(`OAuth connect failed for ${redactEmail(email)}:`, err.message);
    return false;
  });
  // The address as stored on the account, not as typed at the provider (case can differ).
  return { email: account.email_address || email, accountId: account.id, connecting };
}

// How the first connection after a sign-in went, waited for (bounded) so the sign-in reports
// "connected" only once the mailbox has accepted the login.
function connectReportFor({ accountId, connecting }, waitMs) {
  return reportConnect(connecting, accountId, { waitMs, isConnected: () => !!imapManager.isConnected?.(accountId) });
}

// How the account's connection stands now, for an answer given after the wait ended: it may
// have connected, or recorded its failure, since.
async function connectionNow(accountId, report) {
  if (report.connection !== 'connecting') return report;
  if (imapManager.isConnected?.(accountId)) return { connection: 'connected' };
  return reportConnect(Promise.resolve(false), accountId);
}

// The client a repair signs in through: the one the account was connected with when it is
// still offered, else the one that signs this kind of account in now.
function msRepairClient(repair) {
  if (repair?.oauth_client_id === MAILFLOW_MS_CLIENT_ID && msBuiltinAppEnabled()) {
    return { clientId: MAILFLOW_MS_CLIENT_ID, tenantId: 'consumers', builtin: true };
  }
  const config = getMsConfig();
  const personal = isPersonalMicrosoftAccount(repair);
  if (repair?.oauth_client_id && repair.oauth_client_id === config.clientId) {
    // A personal account whose own app no longer accepts personal accounts (its tenant is now
    // organizations or a single tenant) signs in again the way new personal accounts do.
    if (personal && !ownAppAdmitsPersonal(config)) return getMsDeviceClient('personal');
    // Otherwise the tenant the account was connected with: the configured one may have changed.
    return { clientId: config.clientId, tenantId: repair.oauth_tenant_id || config.tenantId, builtin: false };
  }
  // No usable recorded client (an account from before clients were recorded, or one whose app
  // was replaced): pick by the kind of address. Without the sign-in's own claims, a personal
  // Microsoft account on a non-Microsoft address cannot be told from a work one and is tried
  // as work.
  return getMsDeviceClient(personal ? 'personal' : 'work');
}

// The kind of account a new device-code sign-in is for, as the page says: 'personal' or 'work'.
// Anything else keeps the behavior from before kinds existed.
const DEVICE_KINDS = new Set(['personal', 'work']);

// Step 1: initiate device code flow — returns user_code + verification_uri to the frontend.
router.post('/microsoft/device', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // { accountId } signs in again to repair that account; without it a sign-in adds or updates
  // the account for whichever address the person signs in as.
  let repair;
  try { repair = await repairTarget(req.session.userId, req.body?.accountId, 'microsoft'); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  // The instance's own app when configured, else MailFlow's built-in public client (#674).
  const kind = DEVICE_KINDS.has(req.body?.kind) ? req.body.kind : undefined;
  const client = repair ? msRepairClient(repair) : getMsDeviceClient(kind);
  if (!client) {
    return res.status(400).json({ error: 'Microsoft integration not configured. Set the Client ID and Tenant ID under Settings > Email providers.' });
  }
  const { clientId, tenantId } = client;

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
      repairAccountId: repair?.id ?? null,
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
  // Nothing pending: the flow finished, was replaced, or the server restarted mid sign-in
  // (pending flows live in memory). The sign-in may well have completed, so the page says it
  // lost track and points at the account list rather than claiming a failure.
  if (!flow) return res.json({ status: 'lost' });
  // Tokens are being stored by another poll: wait for it.
  if (flow.phase === 'storing') return res.json({ status: 'pending' });
  // Signed in already: this poll answers with how the first connection went (waited for,
  // bounded), so the page shows "checking" in between instead of announcing success early.
  if (flow.phase === 'checking') {
    const report = await connectionNow(flow.accountId, await flow.report);
    if (deviceFlows.get(req.session.userId) === flow) deviceFlows.delete(req.session.userId);
    return res.json({ status: 'success', accountId: flow.accountId, email: flow.email, ...report });
  }
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

    // Marked, not deleted, while the tokens are stored, so a new sign-in started meanwhile is
    // not overwritten by this one's result below.
    flow.phase = 'storing';
    // Device-code flow never uses a client secret → public client. Its refresh must
    // omit the secret too, or Microsoft rejects it with AADSTS90023 (#216).
    const signedIn = await processMicrosoftTokens(req.session.userId, tokens, {
      tenantId: flow.tenantId, clientId: flow.clientId, publicClient: true, repairAccountId: flow.repairAccountId,
    });
    const checking = { phase: 'checking', accountId: signedIn.accountId, email: signedIn.email, report: connectReportFor(signedIn) };
    if (deviceFlows.get(req.session.userId) === flow) deviceFlows.set(req.session.userId, checking);
    res.json({ status: 'checking', accountId: signedIn.accountId, email: signedIn.email });
  } catch (err) {
    if (deviceFlows.get(req.session.userId) === flow) deviceFlows.delete(req.session.userId);
    if (err instanceof WrongAccountError) {
      return res.json({ status: 'wrong_account', signedInAs: err.signedInAs, expected: err.expected });
    }
    console.error('Device code poll error:', err.message);
    res.json({ status: 'error', error: err.message });
  }
});

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
  // The client the account was connected with: its refresh token is valid for no other (#674).
  const { clientId, clientSecret, tenantId } = msRefreshClient(account);
  if (!clientId) throw terminalRefreshError('Microsoft integration not configured. Set the Client ID and Tenant ID under Settings > Email providers.', 'oauth_app_config');

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) throw terminalRefreshError('OAuth refresh token is missing or corrupted: please reconnect your account', 'oauth_reauth');

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
      signal: AbortSignal.timeout(10000),
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
    const message = tokens.error_description || tokens.error || 'Token refresh failed';
    const code = classifyRefreshFailure(tokens);
    throw code ? terminalRefreshError(message, code) : new Error(message);
  }

  const { access_token, refresh_token, expires_in } = tokens;
  const refreshExpiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + refreshExpiresInSecs * 1000);
  const isPublic = !!account.oauth_public_client || becamePublic;

  // An account from before the identity was recorded has just proven which client it
  // belongs to. Recording it keeps the account working if MS_CLIENT_ID changes later.
  // The row must still belong to the client this refresh used: a sign-in that finished
  // meanwhile through another client stored that client's tokens, and these must not be
  // paired with its ID.
  const saved = await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3,
      oauth_public_client = $4,
      oauth_client_id = COALESCE(oauth_client_id, $6),
      oauth_tenant_id = COALESCE(oauth_tenant_id, $7)
    WHERE id = $5
      AND COALESCE(oauth_client_id, $6) = $6
      AND COALESCE(oauth_tenant_id, $7) = $7
  `, [encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expiry, isPublic, account.id, clientId, tenantId]);
  if (saved?.rowCount === 0) {
    console.warn(`Microsoft token refresh for account ${account.id} not saved: the account was signed in again through another client meanwhile`);
  }

  // Return plaintext tokens so callers can use them immediately without decrypting
  return {
    ...account,
    oauth_access_token: access_token,
    oauth_token_expiry: expiry,
    oauth_public_client: isPublic,
    oauth_client_id: account.oauth_client_id || clientId,
    oauth_tenant_id: account.oauth_tenant_id || tenantId,
  };
}

// ─── Google ──────────────────────────────────────────────────────────────────
// Gmail and Google Workspace over IMAP/SMTP with XOAUTH2. Workspace tenants can
// disable app passwords entirely, so OAuth is the only way to reach those
// mailboxes. makeClientCfg() and createAccountSmtpTransport() already accept
// oauth_provider === 'google'; this supplies the tokens they expect.

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// https://mail.google.com/ is the full IMAP/SMTP scope, and it is *restricted*,
// which constrains how the consent screen must be configured:
//   - User Type "Internal" (project owned by a Workspace org): no verification,
//     refresh tokens do not expire. This is the practical option for self-hosting.
//   - "External" + Testing: works immediately, but Google revokes refresh tokens
//     after 7 days, so the account must be reconnected weekly.
//   - "External" + In production: needs full verification including a security
//     audit before restricted scopes are granted long-lived tokens.
const GOOGLE_SCOPE = 'https://mail.google.com/ openid email profile';

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

// Step 1: redirect user to Google consent
router.get('/google', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });

  const { clientId, redirectUri } = getGoogleConfig();
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI in .env' });
  }
  let repair;
  try { repair = await repairTarget(req.session.userId, req.query.accountId, 'google'); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

  const oauthNonce = randomBytes(16).toString('hex');
  req.session.oauthNonce  = oauthNonce;
  req.session.oauthUserId = req.session.userId;
  req.session.oauthRepairAccountId = repair?.id ?? null;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE_SCOPE,
    state: oauthNonce,
    // Google only issues a refresh token when both of these are set, and only on
    // the first consent unless prompt=consent forces re-issue. Without them a
    // reconnect silently yields an access-token-only grant that dies in an hour.
    access_type: 'offline',
    prompt: 'consent select_account',
  });

  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

// Step 2: Google redirects back here with auth code
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Google OAuth error:', error);
    return res.redirect(`/?oauth_error=${encodeURIComponent(error)}`);
  }

  if (!state || state !== req.session.oauthNonce) {
    return res.redirect(`/?oauth_error=${encodeURIComponent('Invalid OAuth state — please try again')}`);
  }
  const userId = req.session.oauthUserId;
  if (!userId) return res.redirect(`/?oauth_error=${encodeURIComponent('OAuth session expired — please try again')}`);
  const repairAccountId = req.session.oauthRepairAccountId ?? null;
  delete req.session.oauthNonce;
  delete req.session.oauthUserId;
  delete req.session.oauthRepairAccountId;

  const { clientId, clientSecret, redirectUri } = getGoogleConfig();

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
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

    const signedIn = await processGoogleTokens(userId, tokens, { clientId, repairAccountId });
    // As for Microsoft: back once the mailbox has answered (bounded), with the outcome kept in
    // the session for the page to read.
    const report = await connectReportFor(signedIn, CALLBACK_CONNECT_WAIT_MS);
    rememberResult(req, { provider: 'google', accountId: signedIn.accountId, email: signedIn.email, ...report });
    res.redirect('/?oauth_success=google&oauth_result=1');
  } catch (err) {
    if (err instanceof WrongAccountError) return res.redirect(wrongAccountRedirect(req, err));
    console.error('Google OAuth callback error:', err);
    res.redirect('/?oauth_error=Authentication+failed');
  }
});

// Shared: validate tokens, upsert account, connect IMAP.
async function processGoogleTokens(userId, tokens, { clientId, repairAccountId = null }) {
  const { access_token, refresh_token, expires_in, id_token } = tokens;
  const expiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + expiresInSecs * 1000);

  if (!refresh_token) {
    // Without a refresh token the account dies silently in an hour. Fail loudly
    // instead of persisting a mailbox that will break by itself later.
    throw new Error('Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and reconnect.');
  }

  let email = null;
  let displayName = null;
  if (id_token) {
    try {
      const { payload } = await jwtVerify(id_token, googleJwks, {
        audience: clientId,
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
      });
      if (payload.email_verified === false) {
        throw new Error('Google account email is not verified');
      }
      email = payload.email || null;
      displayName = payload.name || null;
    } catch (jwtErr) {
      console.error('Google id_token validation failed:', jwtErr.message);
      throw new Error('Could not validate Google identity token — please try again', { cause: jwtErr });
    }
  }

  if (!email) throw new Error('Could not retrieve email address from Google profile — ensure the openid, email, and profile scopes are granted');

  // Same advisory-lock upsert as Microsoft: two callbacks racing for one mailbox
  // would otherwise both miss the SELECT and each INSERT a duplicate row.
  const account = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`oauth-account:${userId}:${email.toLowerCase()}`]);

    // Same repair rule as Microsoft: update the named account, and only for its own address.
    const existing = repairAccountId
      ? await findOwnedAccount(userId, repairAccountId, { columns: 'id, email_address', client })
      : (await client.query('SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = $2', [userId, email])).rows[0];
    if (repairAccountId) {
      if (!existing) throw new Error('Account not found');
      if (existing.email_address.trim().toLowerCase() !== email.trim().toLowerCase()) {
        throw new WrongAccountError(email, existing.email_address);
      }
    }

    let accountId;
    if (existing) {
      accountId = existing.id;
      await client.query(`
        UPDATE email_accounts SET
          oauth_provider = 'google',
          oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expiry = $3,
          name = $4, oauth_public_client = false, sync_error = NULL, sync_error_code = NULL
        WHERE id = $5
      `, [encrypt(access_token), encrypt(refresh_token), expiry, displayName || email, accountId]);
    } else {
      const colors = ['#ea4335', '#fbbc04', '#34a853', '#4285f4'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const result = await client.query(`
        INSERT INTO email_accounts (
          user_id, name, email_address, color, protocol,
          imap_host, imap_port, imap_tls,
          smtp_host, smtp_port, smtp_tls,
          auth_user,
          oauth_provider, oauth_access_token, oauth_refresh_token, oauth_token_expiry,
          oauth_public_client
        ) VALUES ($1,$2,$3,$4,'imap',
          'imap.gmail.com', 993, true,
          'smtp.gmail.com', 587, 'STARTTLS',
          $3,
          'google', $5, $6, $7,
          false)
        RETURNING *
      `, [userId, displayName, email, color, encrypt(access_token), encrypt(refresh_token), expiry]);
      accountId = result.rows[0].id;
    }

    const accountResult = await client.query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    return accountResult.rows[0];
  });

  // Same as Microsoft: a re-link must not wait out an auth backoff.
  imapManager.clearConnectCooldown(account.id);
  clearRefreshFailure(account.id);
  noteFreshToken(account.id);
  const connecting = imapManager.connectAccount(account).catch((err) => {
    console.error(`OAuth connect failed for ${redactEmail(email)}:`, err.message);
    return false;
  });
  return { email: account.email_address || email, accountId: account.id, connecting };
}

// Serialize refreshes per account, same reasoning as Microsoft. Google does not
// rotate the refresh token on every refresh, but concurrent IMAP and SMTP paths
// can still both trip the 5-minute expiry window at once.
const inFlightGoogleRefresh = new Map(); // accountId -> Promise
export function refreshGoogleToken(account) {
  const existing = inFlightGoogleRefresh.get(account.id);
  if (existing) return existing;
  const p = doRefreshGoogleToken(account).finally(() => inFlightGoogleRefresh.delete(account.id));
  inFlightGoogleRefresh.set(account.id, p);
  return p;
}

async function doRefreshGoogleToken(account) {
  const { clientId, clientSecret } = getGoogleConfig();

  const storedRefreshToken = decrypt(account.oauth_refresh_token);
  if (!storedRefreshToken) throw terminalRefreshError('OAuth refresh token is missing or corrupted: please reconnect your account', 'oauth_reauth');

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10000),
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    // invalid_grant means the user revoked access, changed password, or the token
    // expired from disuse. No retry will fix it — the account must be reconnected.
    if (tokens.error === 'invalid_grant') {
      throw terminalRefreshError('Google access was revoked or expired: please reconnect this account', 'oauth_reauth');
    }
    const code = classifyRefreshFailure(tokens);
    const message = tokens.error_description || tokens.error || 'Token refresh failed';
    throw code ? terminalRefreshError(message, code) : new Error(message);
  }

  const { access_token, refresh_token, expires_in } = tokens;
  const refreshExpiresInSecs = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 3600;
  const expiry = new Date(Date.now() + refreshExpiresInSecs * 1000);

  // Google normally omits refresh_token on refresh; COALESCE keeps the stored one.
  await query(`
    UPDATE email_accounts SET
      oauth_access_token = $1,
      oauth_refresh_token = COALESCE($2, oauth_refresh_token),
      oauth_token_expiry = $3
    WHERE id = $4
  `, [encrypt(access_token), refresh_token ? encrypt(refresh_token) : null, expiry, account.id]);

  return { ...account, oauth_access_token: access_token, oauth_token_expiry: expiry };
}

export default router;
