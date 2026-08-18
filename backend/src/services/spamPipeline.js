// Anti-spam auto-classification pipeline (v0.2) — V2-6.
//
// Called right after a NEW message row is inserted (imapManager processMsg,
// is_new branch). Performs the hybrid classification and, on very high
// confidence, optionally moves the message to the account spam folder.
//
// Layers (design §2 / §9):
//   3. messages.spam_user_override — ALWAYS wins, skip if set (user intent)
//   2. per-user MNB model — active when training_records >= 50
//   1. 14-rule engine — always on, sole classifier below 50 records
//
// The move is delegated to the caller via an injected `imap` facade so this
// module never imports imapManager (avoids an import cycle mail.js ↔ index):
//   classifyAndTagMessage(id, { imap: { moveMessage, broadcast, _guardMoveUid,
//                                       _unguardMoveUid }, headers })
//
// IMPORTANT: auto-classified verdicts NEVER write to spam_training_log. Only
// explicit user feedback (/spam, /ham) trains the model — auto-verdicts fed
// back would poison it (see reports.md V2-5 note).

import { query } from './db.js';
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import { scoreRules } from './spamRules.js';
import { getModelForUser } from './spamModelStore.js';
import {
  classifyMessage,
  blendScores,
  extractTopTokens,
} from './spamModel.js';

// Thresholds (design §6.3 defaults; per-user configurability ships in V2-7).
export const SPAM_THRESHOLD = 0.85; // verdict spam when blended score >= this
export const AUTO_MOVE_THRESHOLD = 0.95; // auto-move to spam folder when >= this
export const MIN_TRAINING_RECORDS = 50; // below: rules-only

const round = (n, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * Classify a freshly-inserted message; optionally auto-move it.
 *
 * @param {string} messageId — messages.id
 * @param {Object} [opts]
 *   @param {Object} [opts.headers] — raw headers from the parsed message
 *     (Authentication-Results etc.); optional, auth flags stay neutral.
 *   @param {Object} [opts.imap] — injected imapManager facade for the
 *     auto-move: moveMessage(account, uid, fromFolder, toFolder),
 *     _guardMoveUid(accountId, folder, uid), _unguardMoveUid(...),
 *     broadcast(payload, userId). Without it the message is only tagged.
 * @returns {Promise<Object|null>} summary or null when skipped.
 */
export async function classifyAndTagMessage(messageId, opts = {}) {
  const data = await query(`
    SELECT m.*, a.user_id AS owner_id, a.email_address AS account_email,
           a.antispam_enabled, a.folder_mappings,
           u.preferences->>'spamEnabled' AS master_spam_enabled
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN users u ON u.id = a.user_id
    WHERE m.id = $1
  `, [messageId]);
  const row = data.rows[0];
  if (!row) return null;

  // Layer 3: user intent always wins.
  if (row.spam_user_override) return { skipped: 'user_override' };

  // Per-user master switch (users.preferences.spamEnabled, default on) AND
  // per-account feature toggle (default OFF on install; opt-in).
  if (row.master_spam_enabled === 'false' || !row.antispam_enabled) {
    return { skipped: row.master_spam_enabled === 'false' ? 'spam_disabled' : 'antispam_disabled' };
  }

  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const msg = {
    subject: row.subject || '',
    body: row.body_text || '',
    bodyHtml: row.body_html || '',
    from: row.from_email ? `<${row.from_email}>` : null,
    replyTo: null,
    attachments,
    headers: opts.headers || [],
  };

  const tokens = tokenize(msg);
  const flagFeatures = extractFlagFeatures(msg);

  // Layer 1: rules — always evaluated, sole scorer below 50 records.
  const rules = scoreRules(msg, { userContacts: new Set() });

  // Layer 2: per-user MNB model when mature enough.
  const model = await getModelForUser(row.owner_id);
  const trainingRecords = model?.trainingRecords ?? 0;
  const mlActive = trainingRecords >= MIN_TRAINING_RECORDS;

  let mlProbability = null;
  let mlConfidence = null;
  let blended = rules.score;
  let method = 'rules';
  if (mlActive) {
    const ml = classifyMessage(model, tokens, flagFeatures);
    mlProbability = ml.probability;
    mlConfidence = ml.confidence;
    blended = blendScores(ml.probability, rules.score, trainingRecords);
    method = 'blended';
  }

  const verdict = blended >= SPAM_THRESHOLD ? 'spam' : blended < 0.3 ? 'ham' : 'uncertain';

  const details = {
    method,
    blendedScore: round(blended),
    rulesScore: round(rules.score),
    rulesFired: rules.fired.map(r => ({ name: r.name, weight: r.weight })),
    mlProbability: mlProbability == null ? null : round(mlProbability),
    mlConfidence: mlConfidence == null ? null : round(mlConfidence),
    topTokens: extractTopTokens(model, tokens, 5).map(t => ({
      token: t.token,
      contribution: round(t.contribution),
    })),
  };

  await query(
    `UPDATE messages SET
       spam_verdict = $1, spam_score_ml = $2, spam_analyzed_at = NOW(), spam_details = $3
     WHERE id = $4`,
    [verdict, mlProbability ?? rules.score, JSON.stringify(details), messageId],
  );

  const spamFolder = row.folder_mappings?.spam || null;

  // Auto-move ONLY on very high confidence AND with a configured spam folder.
  const shouldMove = verdict === 'spam'
    && blended >= AUTO_MOVE_THRESHOLD
    && mlActive
    && Boolean(spamFolder)
    && row.folder !== spamFolder;

  let moved = false;
  if (shouldMove && opts.imap) {
    try {
      moved = await autoMove(row, spamFolder, opts.imap, messageId);
    } catch (err) {
      console.warn(`spam auto-move failed for message ${messageId}:`, err.message);
    }
  }

  return {
    verdict,
    blendedScore: round(blended),
    method,
    mlProbability,
    shouldMove,
    moved,
    skipped: null,
  };
}

async function autoMove(row, spamFolder, imap, messageId) {
  imap._guardMoveUid?.(row.account_id, row.folder, row.uid);
  try {
    const newUid = await imap.moveMessage(
      { id: row.account_id, email_address: row.account_email },
      row.uid, row.folder, spamFolder,
    );
    if (newUid != null) {
      await query(
        'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4',
        [row.account_id, newUid, spamFolder, messageId],
      );
    }
    await query(
      'UPDATE messages SET folder = $1, uid = $2 WHERE id = $3',
      [spamFolder, newUid ?? row.uid, messageId],
    );
    imap.broadcast?.(
      { type: 'folder_updated', folder: spamFolder, accountId: row.account_id },
      row.owner_id,
    );
    return true;
  } finally {
    imap._unguardMoveUid?.(row.account_id, row.folder, row.uid);
  }
}

// Exported for tests.
export { autoMove };