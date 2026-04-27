import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Get all integration configs (secrets redacted)
router.get('/', async (req, res) => {
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

// Save/update integration config — admin only (writes affect global OAuth env vars)
router.post('/:provider', requireAdmin, async (req, res) => {
  const { provider } = req.params;
  const allowed = ['microsoft', 'google'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const config = req.body;

  // If clientSecret is redacted, keep the existing value
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

  await query(`
    INSERT INTO integration_config (provider, config)
    VALUES ($1, $2)
    ON CONFLICT (provider) DO UPDATE
    SET config = EXCLUDED.config, updated_at = NOW()
  `, [provider, config]);

  // Write to process.env so oauth routes pick them up immediately
  if (provider === 'microsoft') {
    if (config.clientId) process.env.MS_CLIENT_ID = config.clientId;
    if (config.clientSecret && config.clientSecret !== '••••••••') {
      process.env.MS_CLIENT_SECRET = config.clientSecret;
    }
    if (config.tenantId) process.env.MS_TENANT_ID = config.tenantId;
    if (config.redirectUri) process.env.MS_REDIRECT_URI = config.redirectUri;
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
        if (c.clientSecret) process.env.MS_CLIENT_SECRET = c.clientSecret;
        if (c.tenantId) process.env.MS_TENANT_ID = c.tenantId;
        if (c.redirectUri) process.env.MS_REDIRECT_URI = c.redirectUri;
      }
    }
    console.log('Integration configs loaded');
  } catch (err) {
    console.error('Failed to load integration configs:', err.message);
  }
}

export default router;
