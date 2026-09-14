import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';
import { isGoogleConfigured } from '../services/oauth/googleOAuth.js';

const router = Router();

// Placeholder sent instead of a stored client secret; posting it back keeps the stored value.
const REDACTED_SECRET = '••••••••';

// Google config fields and the env vars the OAuth routes read them from.
const GOOGLE_ENV = {
  clientId: 'GOOGLE_CLIENT_ID',
  clientSecret: 'GOOGLE_CLIENT_SECRET',
  redirectUri: 'GOOGLE_REDIRECT_URI',
};

// Mirror a stored Google config into process.env. Unset fields clear their env var so
// /status never reports a half-removed config as ready.
function applyGoogleEnv(config) {
  for (const [field, envName] of Object.entries(GOOGLE_ENV)) {
    const value = field === 'clientSecret' ? decrypt(config?.[field]) : config?.[field];
    if (value) process.env[envName] = value;
    else delete process.env[envName];
  }
}

router.use(requireAuth);

// Get all integration configs (secrets redacted) — admin only (exposes OAuth client IDs)
router.get('/', requireAdmin, async (req, res) => {
  const result = await query(
    'SELECT provider, config, updated_at FROM integration_config'
  );

  // Redact secrets from response
  const configs = {};
  for (const row of result.rows) {
    const cfg = { ...row.config };
    if (cfg.clientSecret) cfg.clientSecret = REDACTED_SECRET;
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
router.get('/status', async (req, res) => {
  res.json({
    microsoft: {
      configured: !!process.env.MS_CLIENT_ID,
    },
    google: {
      configured: isGoogleConfigured(),
    },
  });
});

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req, res) => {
  const { provider } = req.params;
  const allowed = ['microsoft', 'google'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });

  let config = req.body;
  if (provider === 'google') {
    // Store only the documented fields; string values only.
    const body = req.body || {};
    config = {};
    for (const field of Object.keys(GOOGLE_ENV)) {
      if (typeof body[field] === 'string' && body[field].trim()) config[field] = body[field].trim();
    }
  }

  // A secret that contains the redaction bullet but is not exactly the placeholder was typed into
  // (or around) the redacted field; storing it would silently replace the real secret with junk.
  if (typeof config.clientSecret === 'string'
    && config.clientSecret !== REDACTED_SECRET
    && config.clientSecret.includes('•')) {
    return res.status(400).json({
      error: 'Client secret contains the redaction placeholder; enter the full secret',
      code: 'client_secret_redacted',
    });
  }

  // If clientSecret is redacted, keep the existing stored value (already encrypted or legacy plaintext)
  if (config.clientSecret === REDACTED_SECRET) {
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
  if (provider === 'microsoft') {
    if (config.clientId) process.env.MS_CLIENT_ID = config.clientId;
    if (config.clientSecret) process.env.MS_CLIENT_SECRET = decrypt(config.clientSecret);
    if (config.tenantId) process.env.MS_TENANT_ID = config.tenantId;
    if (config.redirectUri) process.env.MS_REDIRECT_URI = config.redirectUri;
  } else if (provider === 'google') {
    applyGoogleEnv(config);
  }

  res.json({ ok: true });
});

// Delete integration config — admin only
router.delete('/:provider', requireAdmin, async (req, res) => {
  await query(
    'DELETE FROM integration_config WHERE provider = $1',
    [req.params.provider]
  );
  if (req.params.provider === 'microsoft') {
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_REDIRECT_URI;
  } else if (req.params.provider === 'google') {
    applyGoogleEnv(null);
  }
  res.json({ ok: true });
});

// Load saved configs into process.env on startup
export async function loadIntegrationConfigs() {
  try {
    const result = await query('SELECT provider, config FROM integration_config');
    for (const row of result.rows) {
      if (row.provider === 'microsoft') {
        const c = row.config;
        if (c.clientId) process.env.MS_CLIENT_ID = c.clientId;
        // decrypt() returns value unchanged for plaintext (migration fallback)
        if (c.clientSecret) process.env.MS_CLIENT_SECRET = decrypt(c.clientSecret);
        if (c.tenantId) process.env.MS_TENANT_ID = c.tenantId;
        if (c.redirectUri) process.env.MS_REDIRECT_URI = c.redirectUri;
      } else if (row.provider === 'google') {
        applyGoogleEnv(row.config);
      }
    }
    console.log('Integration configs loaded');
  } catch (err) {
    console.error('Failed to load integration configs:', err.message);
  }
}

export default router;
