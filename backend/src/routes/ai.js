import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';

const router = Router();

// ── Admin: AI provider configuration ──────────────────────────────────────────

router.get('/admin/ai', requireAdmin, async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!result.rows.length) return res.json({ config: null });
  try {
    const cfg = JSON.parse(result.rows[0].value);
    res.json({ config: { ...cfg, apiKey: cfg.apiKey ? '••••••••' : '' } });
  } catch {
    res.json({ config: null });
  }
});

router.patch('/admin/ai', requireAdmin, async (req, res) => {
  const { enabled, baseUrl, apiKey, model, features } = req.body;

  let existingKey = null;
  const existing = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (existing.rows.length) {
    try { existingKey = JSON.parse(existing.rows[0].value).apiKey; } catch { /* keep null */ }
  }

  const encryptedKey = apiKey && apiKey !== '••••••••'
    ? encrypt(apiKey)
    : (existingKey || null);

  const trimmedBaseUrl = (baseUrl || '').trim().replace(/\/+$/, '');
  if (trimmedBaseUrl) {
    let urlHost;
    try { urlHost = new URL(trimmedBaseUrl).hostname; } catch {
      return res.status(400).json({ error: 'Invalid base URL' });
    }
    const policy = await getConnectionPolicy();
    const hostErr = await validateHost(urlHost, { allowPrivate: policy.allowPrivateHosts });
    if (hostErr) return res.status(400).json({ error: `Base URL: ${hostErr}` });
  }

  const cfg = {
    enabled: enabled !== false,
    baseUrl: trimmedBaseUrl,
    apiKey: encryptedKey,
    model: (model || '').trim(),
    features: {
      compose: features?.compose !== false,
      summarize: features?.summarize !== false,
    },
  };

  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('ai_config', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(cfg)]
  );
  console.log(`[admin] ${req.session.username} updated AI config`);
  res.json({ ok: true });
});

router.delete('/admin/ai', requireAdmin, async (req, res) => {
  await query("DELETE FROM system_settings WHERE key = 'ai_config'");
  res.json({ ok: true });
});

router.post('/admin/ai/test', requireAdmin, async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!result.rows.length) return res.status(400).json({ error: 'No AI provider configured' });

  let cfg;
  try { cfg = JSON.parse(result.rows[0].value); } catch {
    return res.status(500).json({ error: 'Corrupted AI config' });
  }

  if (!cfg.baseUrl || !cfg.model) {
    return res.status(400).json({ error: 'Base URL and model name are required' });
  }

  const apiKey = cfg.apiKey ? decrypt(cfg.apiKey) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const testRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'Reply with only the word "ok".' }],
        max_tokens: 5,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!testRes.ok) {
      const errText = await testRes.text();
      return res.status(400).json({ error: `Provider returned ${testRes.status}: ${errText.slice(0, 300)}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Authenticated: AI status (used by compose & message pane) ─────────────────

router.get('/ai/status', requireAuth, async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!result.rows.length) return res.json({ enabled: false, features: {} });
  try {
    const cfg = JSON.parse(result.rows[0].value);
    res.json({
      enabled: cfg.enabled === true && !!cfg.baseUrl && !!cfg.model,
      features: cfg.features || {},
    });
  } catch {
    res.json({ enabled: false, features: {} });
  }
});

// ── Authenticated: streaming chat proxy ───────────────────────────────────────

router.post('/ai/chat', requireAuth, async (req, res) => {
  const cfgResult = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!cfgResult.rows.length) return res.status(503).json({ error: 'AI provider not configured' });

  let cfg;
  try { cfg = JSON.parse(cfgResult.rows[0].value); } catch {
    return res.status(500).json({ error: 'Corrupted AI config' });
  }

  if (!cfg.enabled) return res.status(503).json({ error: 'AI features are disabled' });
  if (!cfg.baseUrl || !cfg.model) return res.status(503).json({ error: 'AI provider not fully configured' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  for (const msg of messages) {
    if (!msg.role || typeof msg.content !== 'string') {
      return res.status(400).json({ error: 'Each message must have role and content' });
    }
    if (!['system', 'user', 'assistant'].includes(msg.role)) {
      return res.status(400).json({ error: 'Invalid message role' });
    }
    if (msg.content.length > 32000) {
      return res.status(400).json({ error: 'Message content exceeds maximum length' });
    }
  }

  const apiKey = cfg.apiKey ? decrypt(cfg.apiKey) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const aiRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, messages, stream: true }),
      signal: AbortSignal.timeout(120000),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(502).json({ error: `AI provider error (${aiRes.status}): ${errText.slice(0, 300)}` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.destroyed) { reader.cancel(); break; }
        res.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: `AI request failed: ${err.message}` });
    }
  }
});

export default router;
