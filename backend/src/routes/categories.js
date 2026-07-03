import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { invalidateSocialDomainCache, backfillCategories, aiClassifyMessage, BUILTIN_SETS } from '../services/categorizer.js';
import { validateHost } from '../services/hostValidation.js';

const router = Router();

// Validate that a URL is a safe external HTTPS URL (no private/loopback IPs).
// Returns an error string or null if valid. Async because it performs DNS resolution.
async function validateSubscriptionUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return 'Invalid URL'; }
  if (url.protocol !== 'https:') return 'URL must use HTTPS';
  const err = await validateHost(url.hostname);
  if (err) return 'URL host not allowed';
  return null;
}

// Fetch a plain-text domain list from a URL.
// Returns { domains: string[], error: string|null }.
async function fetchDomainList(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mailflow/1.0' } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { domains: [], error: `HTTP ${res.status}` };

    // Limit response to 512 KB to prevent memory abuse
    const MAX_BYTES = 512 * 1024;
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        reader.cancel();
        return { domains: [], error: 'Response too large (max 512 KB)' };
      }
      chunks.push(value);
    }

    const text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
    const domains = text
      .split(/\r?\n/)
      .map(line => line.replace(/#.*$/, '').trim().toLowerCase())
      .filter(line => line.length > 0 && line.length <= 253 && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(line));

    return { domains, error: null };
  } catch (err) {
    return { domains: [], error: err.name === 'AbortError' ? 'Request timed out' : err.message };
  }
}

// ── List sources ──────────────────────────────────────────────────────────────

router.get('/categories/sources', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, source_type, value, label, enabled,
            array_length(resolved_domains, 1) AS domain_count,
            last_fetched_at, fetch_ok, fetch_error, created_at
     FROM category_list_sources
     WHERE user_id = $1
     ORDER BY source_type, created_at`,
    [req.session.userId]
  );
  res.json({ sources: result.rows, builtinSets: Object.keys(BUILTIN_SETS) });
});

// ── Add source ────────────────────────────────────────────────────────────────

router.post('/categories/sources', requireAuth, async (req, res) => {
  const { sourceType, value, label } = req.body;

  if (!['manual', 'builtin', 'url'].includes(sourceType)) {
    return res.status(400).json({ error: 'Invalid sourceType' });
  }
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    return res.status(400).json({ error: 'value is required' });
  }

  const trimmedValue = value.trim().toLowerCase();

  if (sourceType === 'manual') {
    // Accept domain (example.com) or full email address (noreply@example.com)
    const domainOrEmail = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmedValue)
      || /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmedValue);
    if (!domainOrEmail) return res.status(400).json({ error: 'Invalid domain or email address' });
  }

  if (sourceType === 'builtin') {
    if (!BUILTIN_SETS[trimmedValue]) {
      return res.status(400).json({ error: `Unknown built-in set: ${trimmedValue}` });
    }
  }

  if (sourceType === 'url') {
    const urlErr = await validateSubscriptionUrl(trimmedValue);
    if (urlErr) return res.status(400).json({ error: urlErr });
  }

  try {
    const result = await query(
      `INSERT INTO category_list_sources (user_id, source_type, value, label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, source_type, value) DO UPDATE SET enabled = true
       RETURNING id, source_type, value, label, enabled, last_fetched_at, fetch_ok, fetch_error, created_at`,
      [req.session.userId, sourceType, trimmedValue, label?.trim() || null]
    );
    invalidateSocialDomainCache(req.session.userId);

    const source = result.rows[0];

    // If it's a URL subscription, kick off an immediate fetch in the background
    if (sourceType === 'url') {
      (async () => {
        const { domains, error } = await fetchDomainList(trimmedValue);
        await query(
          `UPDATE category_list_sources
           SET resolved_domains = $1, last_fetched_at = NOW(), fetch_ok = $2, fetch_error = $3
           WHERE id = $4`,
          [domains, !error, error, source.id]
        );
        invalidateSocialDomainCache(req.session.userId);
      })().catch(() => {});
    }

    res.status(201).json({ source });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This entry already exists' });
    throw err;
  }
});

// ── Toggle enabled ─────────────────────────────────────────────────────────────

router.patch('/categories/sources/:id', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  const result = await query(
    `UPDATE category_list_sources SET enabled = $1
     WHERE id = $2 AND user_id = $3
     RETURNING id, source_type, value, label, enabled, last_fetched_at, fetch_ok, fetch_error`,
    [enabled, req.params.id, req.session.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Source not found' });

  invalidateSocialDomainCache(req.session.userId);
  res.json({ source: result.rows[0] });
});

// ── Delete source ─────────────────────────────────────────────────────────────

router.delete('/categories/sources/:id', requireAuth, async (req, res) => {
  const result = await query(
    'DELETE FROM category_list_sources WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.session.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Source not found' });

  invalidateSocialDomainCache(req.session.userId);
  res.json({ ok: true });
});

// ── Refresh URL subscription ──────────────────────────────────────────────────

router.post('/categories/sources/:id/refresh', requireAuth, async (req, res) => {
  const check = await query(
    'SELECT id, source_type, value FROM category_list_sources WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Source not found' });

  const source = check.rows[0];
  if (source.source_type !== 'url') return res.status(400).json({ error: 'Only URL sources can be refreshed' });

  const { domains, error } = await fetchDomainList(source.value);
  await query(
    `UPDATE category_list_sources
     SET resolved_domains = $1, last_fetched_at = NOW(), fetch_ok = $2, fetch_error = $3
     WHERE id = $4`,
    [domains, !error, error, source.id]
  );
  invalidateSocialDomainCache(req.session.userId);

  res.json({ ok: true, domainCount: domains.length, error: error || null });
});

// ── Re-categorize account messages ───────────────────────────────────────────

router.post('/categories/recategorize/:accountId', requireAuth, async (req, res) => {
  const check = await query(
    `SELECT ea.id FROM email_accounts ea
     JOIN users u ON u.id = ea.user_id
     WHERE ea.id = $1 AND ea.user_id = $2
       AND (ea.categorization_enabled = true OR (u.preferences->>'categorizationEnabled')::boolean = true)`,
    [req.params.accountId, req.session.userId]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found or categorization not enabled' });

  // Run in background — large inboxes can take a while
  const userId = req.session.userId;
  const accountId = req.params.accountId;
  (async () => {
    try {
      const processed = await backfillCategories(accountId, userId);
      console.log(`Re-categorization complete: ${processed} messages for account ${accountId}`);
    } catch (err) {
      console.error(`Re-categorization error for account ${accountId}:`, err.message);
    }
  })();

  res.status(202).json({ ok: true });
});

// ── AI-classify a single message ─────────────────────────────────────────────

const UUID_RE_CAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/categories/ai-classify/:messageId', requireAuth, async (req, res) => {
  const { messageId } = req.params;
  if (!UUID_RE_CAT.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });

  const msgResult = await query(`
    SELECT m.subject, m.from_email, m.snippet
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false
  `, [messageId, req.session.userId]);

  if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found' });
  const { subject, from_email, snippet } = msgResult.rows[0];

  const category = await aiClassifyMessage(subject, from_email, snippet);
  if (!category) return res.status(503).json({ error: 'AI classification unavailable or failed' });

  // Persist the AI-assigned category.
  await query(
    `UPDATE messages SET category = $1
     FROM email_accounts a
     WHERE messages.id = $2 AND messages.account_id = a.id AND a.user_id = $3`,
    [category === 'primary' ? null : category, messageId, req.session.userId]
  );

  res.json({ ok: true, category });
});

export default router;
