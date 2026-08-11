import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';

const router = Router();
router.use(requireAuth);

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

function applyConfigToEnv(provider, config) {
  const map = PROVIDER_ENV[provider];
  if (!map) return;
  for (const [key, envVar] of Object.entries(map)) {
    if (!config[key]) continue;
    // clientSecret is stored encrypted; decrypt() passes plaintext through unchanged
    process.env[envVar] = key === 'clientSecret' ? decrypt(config[key]) : config[key];
  }
}

function clearConfigFromEnv(provider) {
  const map = PROVIDER_ENV[provider];
  if (!map) return;
  for (const envVar of Object.values(map)) delete process.env[envVar];
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
router.get('/status', async (req, res) => {
  res.json({
    microsoft: {
      configured: !!process.env.MS_CLIENT_ID,
    },
    google: {
      configured: !!process.env.GOOGLE_CLIENT_ID,
    },
  });
});

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req, res) => {
  const { provider } = req.params;
  if (!PROVIDER_ENV[provider]) return res.status(400).json({ error: 'Unknown provider' });

  const config = req.body;

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

  res.json({ ok: true });
});

// Delete integration config — admin only
router.delete('/:provider', requireAdmin, async (req, res) => {
  await query(
    'DELETE FROM integration_config WHERE provider = $1',
    [req.params.provider]
  );
  clearConfigFromEnv(req.params.provider);
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
    console.log('Integration configs loaded');
  } catch (err) {
    console.error('Failed to load integration configs:', err.message);
  }
}

export default router;
