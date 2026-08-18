// Antispam admin/status endpoints (v0.2) — V2-7.
//
// Namespace /api/spam/*: status, per-user thresholds, decay threshold,
// retrain-now, per-user master enable, GDPR reset (all accounts), audit
// trail of deletions, and the explain payload for the "Why?" modal.
// Per-account reset lives on /api/accounts/:id/spam/reset-training (design
// §16, GDPR) — exported separately and mounted by index.js.
//
// Design: .hermes/design/spam-classifier-v0.2.md §11.7, §6.3, §16.

import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { tokenize, extractFlagFeatures } from '../services/spamTokenizer.js';
import { scoreRules } from '../services/spamRules.js';
import { classifyMessage, extractTopTokens } from '../services/spamModel.js';
import { getModelForUser, invalidateModelCache } from '../services/spamModelStore.js';
import { runFullRetrain } from '../services/spamScheduler.js';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hardcoded structural thresholds (design §6.3 — not user-configurable).
const DEFAULT_THRESHOLDS = {
  minRecords: 50,
  softRecords: 500,
  hardRecords: 500,
  spamThreshold: 0.85,
  autoMoveThreshold: 0.95,
};
const DEFAULT_DECAY_DAYS = 90;

async function getUserPreferences(userId) {
  const result = await query('SELECT preferences FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.preferences || {};
}

// Read per-user spam thresholds from users.preferences (JSONB), merged over
// defaults. Unknown/missing keys fall back silently.
async function readThresholds(userId) {
  const prefs = await getUserPreferences(userId);
  const stored = prefs.spam_thresholds && typeof prefs.spam_thresholds === 'object'
    ? prefs.spam_thresholds : {};
  return {
    minRecords: stored.minRecords ?? DEFAULT_THRESHOLDS.minRecords,
    softRecords: stored.softRecords ?? DEFAULT_THRESHOLDS.softRecords,
    hardRecords: stored.hardRecords ?? DEFAULT_THRESHOLDS.hardRecords,
    spamThreshold: stored.spamThreshold ?? DEFAULT_THRESHOLDS.spamThreshold,
    autoMoveThreshold: stored.autoMoveThreshold ?? DEFAULT_THRESHOLDS.autoMoveThreshold,
  };
}

async function writeThresholds(userId, patch) {
  await query(
    `UPDATE users
     SET preferences = jsonb_set(
       COALESCE(preferences, '{}'::jsonb),
       '{spam_thresholds}',
       (COALESCE(preferences->'spam_thresholds', '{}'::jsonb) || $2::jsonb)
     )
     WHERE id = $1`,
    [userId, JSON.stringify(patch)],
  );
}

// ── GET /api/spam/status ────────────────────────────────────────────────────
router.get('/status', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const [model, accounts, prefs] = await Promise.all([
      getModelForUser(userId),
      query('SELECT count(*)::int AS n FROM email_accounts WHERE user_id = $1 AND antispam_enabled = true', [userId]),
      getUserPreferences(userId),
    ]);
    const enabled = prefs.spamEnabled !== false && accounts.rows[0].n > 0;
    res.json({
      enabled,
      masterEnabled: prefs.spamEnabled !== false,
      antispamAccounts: accounts.rows[0].n,
      modelVersion: model?.modelVersion ?? null,
      trainingRecords: model?.trainingRecords ?? 0,
      lastTrainedAt: model?.lastTrainedAt ?? null,
      decayThresholdDays: model?.decayThresholdDays ?? DEFAULT_DECAY_DAYS,
      maturity: model?.trainingRecords >= 500
        ? 'mature' : model?.trainingRecords >= 50 ? 'fresh' : 'insufficient',
    });
  } catch (err) { next(err); }
});

// ── GET/PATCH /api/spam/thresholds ─────────────────────────────────────────
router.get('/thresholds', async (req, res, next) => {
  try {
    res.json(await readThresholds(req.session.userId));
  } catch (err) { next(err); }
});

router.patch('/thresholds', requireAdmin, async (req, res, next) => {
  try {
    const { minRecords, softRecords, hardRecords, spamThreshold, autoMoveThreshold } = req.body;
    const patch = {};
    if (minRecords != null) patch.minRecords = minRecords;
    if (softRecords != null) patch.softRecords = softRecords;
    if (hardRecords != null) patch.hardRecords = hardRecords;
    if (spamThreshold !== undefined) {
      if (typeof spamThreshold !== 'number' || spamThreshold < 0.5 || spamThreshold > 0.99) {
        return res.status(400).json({ error: 'spamThreshold must be between 0.5 and 0.99' });
      }
      patch.spamThreshold = spamThreshold;
    }
    if (autoMoveThreshold !== undefined) {
      if (typeof autoMoveThreshold !== 'number' || autoMoveThreshold < 0.7 || autoMoveThreshold > 0.99) {
        return res.status(400).json({ error: 'autoMoveThreshold must be between 0.7 and 0.99' });
      }
      patch.autoMoveThreshold = autoMoveThreshold;
    }
    await writeThresholds(req.session.userId, patch);
    res.json(await readThresholds(req.session.userId));
  } catch (err) { next(err); }
});

// ── GET/PATCH /api/spam/decay-threshold ────────────────────────────────────
router.get('/decay-threshold', async (req, res, next) => {
  try {
    const model = await getModelForUser(req.session.userId);
    res.json({ decayThresholdDays: model?.decayThresholdDays ?? DEFAULT_DECAY_DAYS });
  } catch (err) { next(err); }
});

router.patch('/decay-threshold', async (req, res, next) => {
  try {
    const value = req.body?.decayThresholdDays;
    const days = parseInt(value, 10);
    if (!Number.isInteger(days) || days < 7 || days > 365) {
      return res.status(400).json({ error: 'decayThresholdDays must be an integer between 7 and 365' });
    }
    // Decay lives on the spam_models row; ensure one exists so the value
    // survives until the next patch (retrainUser reads it from there).
    const existing = await getModelForUser(req.session.userId);
    await query(
      `INSERT INTO spam_models (user_id, decay_threshold_days)
       VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET decay_threshold_days = $2`,
      [req.session.userId, days],
    );
    invalidateModelCache(req.session.userId);
    res.json({ decayThresholdDays: days });
    void existing;
  } catch (err) { next(err); }
});

// ── POST /api/spam/retrain-now (admin) ─────────────────────────────────────
router.post('/retrain-now', requireAdmin, async (req, res, next) => {
  try {
    const result = await runFullRetrain();
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── POST /api/spam/enable (per-user master switch) ─────────────────────────
router.post('/enable', async (req, res, next) => {
  try {
    const enabled = req.body?.enabled === true;
    await query(
      `UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [req.session.userId, JSON.stringify({ spamEnabled: enabled })],
    );
    res.json({ enabled });
  } catch (err) { next(err); }
});

// ── POST /api/spam/reset-training-all (GDPR, confirm required) ─────────────
router.post('/reset-training-all', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const userId = req.session.userId;
    const [logRes, modelRes] = await Promise.all([
      query('DELETE FROM spam_training_log WHERE user_id = $1', [userId]),
      query('DELETE FROM spam_models WHERE user_id = $1', [userId]),
    ]);
    await query(
      `INSERT INTO spam_training_deletions (user_id, scope, records_deleted, ip_address, user_agent)
       VALUES ($1, 'all', $2, $3::inet, $4)`,
      [userId, logRes.rowCount, ipOf(req), truncateUserAgent(req)],
    );
    invalidateModelCache(userId);
    const accounts = await query(
      'SELECT count(*)::int AS n, count(*) FILTER (WHERE antispam_enabled)::int AS enabled_n FROM email_accounts WHERE user_id = $1',
      [userId],
    );
    res.json({
      ok: true,
      deletedTrainingRecords: logRes.rowCount,
      deletedModels: modelRes.rowCount,
      affectedAccounts: accounts.rows[0].n,
    });
  } catch (err) { next(err); }
});

// ── GET /api/spam/deletions (audit trail, own rows only) ──────────────────
router.get('/deletions', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT scope, records_deleted, reason, requested_at, account_id
       FROM spam_training_deletions WHERE user_id = $1
       ORDER BY requested_at DESC LIMIT 100`,
      [req.session.userId],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── GET /api/spam/explain?messageId=… (for the "Why?" modal) ───────────────
router.get('/explain', async (req, res, next) => {
  try {
    const { messageId } = req.query;
    if (!messageId || !UUID_RE.test(messageId)) {
      return res.status(400).json({ error: 'Invalid messageId' });
    }
    const data = await query(
      `SELECT m.*, a.user_id AS owner_id, a.folder_mappings
       FROM messages m JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = $1 AND a.user_id = $2`,
      [messageId, req.session.userId],
    );
    const row = data.rows[0];
    if (!row) return res.status(404).json({ error: 'Message not found' });

    const msg = {
      subject: row.subject || '',
      body: row.body_text || '',
      bodyHtml: row.body_html || '',
      from: row.from_email ? `<${row.from_email}>` : null,
      replyTo: null,
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      headers: [],
    };
    const tokens = tokenize(msg);
    const flagFeatures = extractFlagFeatures(msg);

    const rules = scoreRules(msg, { userContacts: new Set() });
    const model = await getModelForUser(row.owner_id);
    const trainingRecords = model?.trainingRecords ?? 0;
    const mlActive = trainingRecords >= 50;
    let mlResult = null;
    if (mlActive) mlResult = classifyMessage(model, tokens, flagFeatures);

    res.json({
      verdict: row.spam_verdict,
      storedScore: row.spam_score_ml ?? null,
      method: mlActive ? 'blended' : 'rules',
      confidence: mlResult?.confidence ?? rules.score,
      rulesFired: rules.fired.map(r => ({ name: r.name, weight: r.weight })),
      rulesScore: rules.score,
      mlProbability: mlResult?.probability ?? null,
      mlTopTokens: extractTopTokens(model, tokens, 5).map(t => ({
        token: t.token, contribution: Math.round(t.contribution * 1000) / 1000,
      })),
      storedDetails: typeof row.spam_details === 'string'
        ? JSON.parse(row.spam_details)
        : (row.spam_details ?? null),
    });
  } catch (err) { next(err); }
});

// ── Per-account reset (mounted separately at /api/accounts) ────────────────
// POST /api/accounts/:id/spam/reset-training — scope per-account (§16).
export const accountSpamRouter = Router();
accountSpamRouter.use(requireAuth);

accountSpamRouter.post('/:id/spam/reset-training', async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid account id' });
    const userId = req.session.userId;

    // Ownership check.
    const owned = await query(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });

    const logRes = await query(
      'DELETE FROM spam_training_log WHERE user_id = $1 AND account_id = $2',
      [userId, id],
    );
    // The model is per-user: this reset clears the user's whole vocabulary
    // (documented in the UI) rather than keeping a half-trained model.
    const modelRes = await query('DELETE FROM spam_models WHERE user_id = $1', [userId]);
    await query(
      `INSERT INTO spam_training_deletions (user_id, account_id, scope, records_deleted, ip_address, user_agent)
       VALUES ($1, $2, 'per_account', $3, $4::inet, $5)`,
      [userId, id, logRes.rowCount, ipOf(req), truncateUserAgent(req)],
    );
    invalidateModelCache(userId);

    res.json({
      ok: true,
      deletedTrainingRecords: logRes.rowCount,
      deletedModel: modelRes.rowCount > 0,
    });
  } catch (err) { next(err); }
});

function ipOf(req) {
  const ip = req.ip || req.socket?.remoteAddress;
  if (!ip) return null;
  // ::ffff:1.2.3.4 → 1.2.3.4
  const plain = ip.replace(/^::ffff:/, '');
  if (plain === '::1' || plain === '127.0.0.1') return '127.0.0.1';
  return ip;
}

function truncateUserAgent(req) {
  const ua = req.headers?.['user-agent'] || '';
  return ua.slice(0, 300) || null;
}

export default router;