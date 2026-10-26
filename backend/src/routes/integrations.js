import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';
import { clearRefreshFailure } from '../services/accountErrorCode.js';
import { getMsConfig, msBuiltinAppEnabled, msBuiltinAppShipped, msPersonalAccountsAvailable, msPersonalSignInVia, msWorkAccountsAvailable } from '../services/microsoftOAuthClient.js';
import { getGoogleConfig, isOAuthSetting } from '../services/oauthEnv.js';

const router = Router();
router.use(requireAuth);

// After an admin changes a provider's app (a new secret, a removed or replaced app, the shared
// app switched), that provider's OAuth accounts get a fresh start: remembered refresh failures
// and connect backoffs are forgotten, and the ones showing an error reconnect now instead of
// waiting out a backoff that may be hours long. Runs in the background, three at a time.
export async function recoverProviderAccounts(engine, provider) {
  const { rows } = await query('SELECT * FROM email_accounts WHERE oauth_provider = $1', [provider]);
  const broken = [];
  for (const account of rows) {
    clearRefreshFailure(account.id);
    engine?.clearConnectCooldown?.(account.id);
    if (account.enabled && account.sync_error) broken.push(account);
  }
  if (!engine?.connectAccount) return broken.length;
  const queue = [...broken];
  const worker = async () => {
    for (let account = queue.shift(); account; account = queue.shift()) {
      await engine.connectAccount(account).catch(err => console.error(`Reconnect after ${provider} app change failed:`, err.message));
    }
  };
  Promise.all([worker(), worker(), worker()]).catch(() => {});
  return broken.length;
}
const recoverAfterChange = (req, provider) =>
  recoverProviderAccounts(req.app?.get?.('imapManager'), provider)
    .catch(err => console.error(`Could not reset ${provider} accounts after an app change:`, err.message));

// Maps each provider's stored config keys to the process.env vars the OAuth routes
// read. Config can arrive from this UI or straight from .env; both converge here,
// so getMsConfig()/getGoogleConfig() only ever need to look at process.env.
const PROVIDER_ENV = {
  microsoft: {
    clientId: 'MS_CLIENT_ID',
    clientSecret: 'MS_CLIENT_SECRET',
    tenantId: 'MS_TENANT_ID',
    redirectUri: 'MS_REDIRECT_URI',
  },
  google: {
    clientId: 'GOOGLE_CLIENT_ID',
    clientSecret: 'GOOGLE_CLIENT_SECRET',
    redirectUri: 'GOOGLE_REDIRECT_URI',
  },
};

// Whether MailFlow's built-in Microsoft app is offered for personal accounts (#674). The
// admin's choice in Settings has its own system_settings row, not a place in the microsoft
// config, so removing the instance's own app does not quietly turn the shared app back on.
// Once set, it takes precedence over MS_BUILTIN_APP in .env.
const MS_BUILTIN_APP_KEY = 'ms_builtin_app';

// What .env gave each variable, before any stored config was applied over it. A field left
// empty in Settings, or a provider's config removed there, falls back to it, as it does on
// the next restart (#676).
const ENV_DEFAULTS = Object.fromEntries(
  Object.values(PROVIDER_ENV).flatMap(Object.values).map(envVar => [envVar, process.env[envVar]]),
);

function restoreEnvDefault(envVar) {
  if (ENV_DEFAULTS[envVar] === undefined) delete process.env[envVar];
  else process.env[envVar] = ENV_DEFAULTS[envVar];
}

// A stored value wins field by field; a field without one keeps what .env says. "Without one"
// is the test the OAuth routes read with (isOAuthSetting), so a blank stored value does not
// hide the .env value behind something the routes then treat as unset.
function applyConfigToEnv(provider, config) {
  const map = PROVIDER_ENV[provider];
  if (!map) return;
  for (const [key, envVar] of Object.entries(map)) {
    // clientSecret is stored encrypted; decrypt() passes plaintext through unchanged
    const value = key === 'clientSecret' && config[key] ? decrypt(config[key]) : config[key];
    if (isOAuthSetting(value)) process.env[envVar] = value;
    else restoreEnvDefault(envVar);
  }
}

// Google's only sign-in is on its own page, which needs a redirect URI. Saved without one, the
// app looked configured while every sign-in failed with redirect_uri_mismatch, or fell back to
// a placeholder from .env. A real one in .env will do. Microsoft's redirect URI stays optional:
// without it the instance's app signs in over the device-code flow, which needs none.
function missingRequired(provider, config) {
  if (provider !== 'google') return null;
  if (isOAuthSetting(config.redirectUri) || isOAuthSetting(ENV_DEFAULTS.GOOGLE_REDIRECT_URI)) return null;
  return 'Google needs a redirect URI: the one registered on the OAuth client, ending in /oauth/google/callback.';
}

function clearConfigFromEnv(provider) {
  const map = PROVIDER_ENV[provider];
  if (!map) return;
  for (const envVar of Object.values(map)) restoreEnvDefault(envVar);
}

// Get all integration configs (secrets redacted) — admin only (exposes OAuth client IDs)
router.get('/', requireAdmin, async (req, res) => {
  const result = await query(
    'SELECT provider, config, updated_at FROM integration_config'
  );

  // Redact secrets from response
  const configs = {};
  for (const row of result.rows) {
    const cfg = { ...row.config };
    if (cfg.clientSecret) cfg.clientSecret = '••••••••';
    configs[row.provider] = { ...cfg, updated_at: row.updated_at };
  }
  res.json(configs);
});

// Capability check for any authenticated user (non-admins included). Reports only
// whether each provider is configured — never the client ID, secret, or any other
// credential. This lets a non-admin see that Microsoft OAuth is available and enable
// the connect buttons, while the config read/write/delete endpoints stay admin-only.
// The OAuth connect routes already require only an authenticated session and bind the
// resulting mailbox to that user, so no privilege is granted here. (#315)
//
// configured is the instance's own app. builtinApp is whether MailFlow's built-in app may be
// offered: this build ships one (builtinAppShipped) and the admin has not opted out. Without
// an own app, personal accounts connect through the built-in one over the device-code flow.
// personalAccounts says whether a personal account can sign in at all right now. (#674)
router.get('/status', async (req, res) => {
  const msConfig = getMsConfig();
  const google = getGoogleConfig();
  res.json({
    microsoft: {
      configured: !!msConfig.clientId,
      builtinApp: msBuiltinAppEnabled(),
      builtinAppShipped: msBuiltinAppShipped(),
      personalAccounts: msPersonalAccountsAvailable(),
      // Which app signs personal accounts in: 'own', 'shared' (MailFlow's), or null.
      personalVia: msPersonalSignInVia(),
      // Work and school accounts need the instance's own app on a tenant that admits them;
      // with a secret and redirect URI it can also sign in through Microsoft's page (redirect).
      workAccounts: msWorkAccountsAvailable(),
      workRedirect: msWorkAccountsAvailable() && !!msConfig.clientSecret && !!msConfig.redirectUri,
      // The same for personal accounts when the own app signs them in: its page is then the
      // main path, as in v4.0.4, since such an app may not allow public client flows.
      personalRedirect: msPersonalSignInVia() === 'own' && !!msConfig.clientSecret && !!msConfig.redirectUri,
    },
    google: {
      configured: !!google.clientId,
      // Everything the sign-in on Google's page needs: Add account offers it only then.
      signIn: !!google.clientId && !!google.clientSecret && !!google.redirectUri,
      // A usable redirect URI in .env, so Settings may leave the field empty.
      envRedirectUri: isOAuthSetting(ENV_DEFAULTS.GOOGLE_REDIRECT_URI),
    },
  });
});

// Offer MailFlow's built-in Microsoft app for personal accounts, or stop offering it (#674).
// Turning it off stops new sign-ins through it; accounts already connected keep refreshing
// through the client they were connected with. Admin only.
router.put('/microsoft/builtin-app', requireAdmin, async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [MS_BUILTIN_APP_KEY, String(enabled)],
  );
  process.env.MS_BUILTIN_APP = String(enabled);
  await recoverAfterChange(req, 'microsoft');
  res.json({ ok: true });
});

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req, res) => {
  const { provider } = req.params;
  if (!PROVIDER_ENV[provider]) return res.status(400).json({ error: 'Unknown provider' });

  const config = req.body;
  const missing = missingRequired(provider, config);
  if (missing) return res.status(400).json({ error: missing, code: 'redirect_uri_required' });

  // If clientSecret is redacted, keep the existing stored value (already encrypted or legacy plaintext)
  if (config.clientSecret === '••••••••') {
    const existing = await query(
      'SELECT config FROM integration_config WHERE provider = $1',
      [provider]
    );
    if (existing.rows.length) {
      config.clientSecret = existing.rows[0].config.clientSecret;
    } else {
      delete config.clientSecret;
    }
  }

  // Encrypt clientSecret at rest — handles both new writes and migration of legacy plaintext values
  if (config.clientSecret && !isEncrypted(config.clientSecret)) {
    config.clientSecret = encrypt(config.clientSecret);
  }

  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = EXCLUDED.config, updated_at = NOW()
  `, [provider, config]);

  // Write plaintext values to process.env so oauth routes pick them up immediately
  applyConfigToEnv(provider, config);
  await recoverAfterChange(req, provider);

  res.json({ ok: true });
});

// Delete integration config — admin only
router.delete('/:provider', requireAdmin, async (req, res) => {
  await query(
    'DELETE FROM integration_config WHERE provider = $1',
    [req.params.provider]
  );
  clearConfigFromEnv(req.params.provider);
  if (PROVIDER_ENV[req.params.provider]) await recoverAfterChange(req, req.params.provider);
  res.json({ ok: true });
});

// Load saved configs into process.env on startup
export async function loadIntegrationConfigs() {
  try {
    const result = await query('SELECT provider, config FROM integration_config');
    for (const row of result.rows) {
      // decrypt() returns the value unchanged for plaintext (migration fallback)
      applyConfigToEnv(row.provider, row.config);
    }
    const builtin = await query('SELECT value FROM system_settings WHERE key = $1', [MS_BUILTIN_APP_KEY]);
    if (builtin.rows.length) process.env.MS_BUILTIN_APP = builtin.rows[0].value;
    console.log('Integration configs loaded');
  } catch (err) {
    console.error('Failed to load integration configs:', err.message);
  }
}

export default router;
