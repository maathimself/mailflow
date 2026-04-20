import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Ensure the integrations config table exists
async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS integration_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, provider)
    )
  `);
}

// Get all integration configs for this user (secrets redacted)
router.get('/', async (req, res) => {
  await ensureTable();
  const result = await query(
    'SELECT provider, config, updated_at FROM integration_config WHERE user_id = $1',
    [req.session.userId]
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

// Save/update integration config
router.post('/:provider', async (req, res) => {
  await ensureTable();
  const { provider } = req.params;
  const allowed = ['microsoft', 'google'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });

  const config = req.body;

  // If clientSecret is redacted, keep the existing value
  if (config.clientSecret === '••••••••') {
    const existing = await query(
      'SELECT config FROM integration_config WHERE user_id = $1 AND provider = $2',
      [req.session.userId, provider]
    );
    if (existing.rows.length) {
      config.clientSecret = existing.rows[0].config.clientSecret;
    } else {
      delete config.clientSecret;
    }
  }

  await query(`
    INSERT INTO integration_config (user_id, provider, config)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, provider) DO UPDATE
    SET config = $3, updated_at = NOW()
  `, [req.session.userId, provider, config]);

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

// Delete integration config
router.delete('/:provider', async (req, res) => {
  await ensureTable();
  await query(
    'DELETE FROM integration_config WHERE user_id = $1 AND provider = $2',
    [req.session.userId, req.params.provider]
  );
  res.json({ ok: true });
});

// Load saved configs into process.env on startup
export async function loadIntegrationConfigs() {
  try {
    await ensureTable();
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
