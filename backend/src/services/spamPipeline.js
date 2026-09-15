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
//
// Auto-move: skipped entirely when the caller defers it (`deferAutoMove`, used by
// the backfill path). A reindex classifies a whole mailbox at once, and that many
// concurrent moves would fight over the pooled connections the rest of the app
// uses — each 10s overflow loser opening a fresh login at the provider. The
// deferred intent is recorded in spam_details (PR review, 2026-09-15).

import { query } from './db.js';
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import { scoreRules } from './spamRules.js';
import { extractAuthservIds, normalizeAuthservId } from './spamParser.js';
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
 *   @param {boolean} [opts.deferAutoMove=false] — tag only: compute the verdict and
 *     record whether a move was warranted, but never move. Set by the backfill path,
 *     which classifies a whole mailbox at once (see the auto-move note below).
 *   @param {Object} [opts.imap] — injected imapManager facade for the
 *     auto-move: moveMessage(account, uid, fromFolder, toFolder),
 *     _guardMoveUid(accountId, folder, uid), _unguardMoveUid(...),
 *     broadcast(payload, userId). Without it the message is only tagged.
 * @returns {Promise<Object|null>} summary or null when skipped.
 */
export async function classifyAndTagMessage(messageId, opts = {}) {
  const data = await query(`
    SELECT m.*, a.user_id AS owner_id, a.email_address AS account_email,
           a.antispam_enabled, a.folder_mappings, a.trusted_authserv_id,
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

  // Authentication-Results is only honored when its authserv-id is the one this
  // account trusts (email_accounts.trusted_authserv_id). With none configured,
  // the auth signal is neutral — a forged header can neither add pass weights
  // nor silence the AUTH_*_FAIL rules (PR review, 2026-08-25).
  const trustedAuthservId = normalizeAuthservId(row.trusted_authserv_id);
  const observedAuthservIds = extractAuthservIds(msg.headers);

  const tokens = tokenize(msg);
  const flagFeatures = extractFlagFeatures(msg, { trustedAuthservIds: trustedAuthservId });

  // Layer 1: rules — always evaluated, sole scorer below 50 records.
  const rules = scoreRules(msg, {
    userContacts: new Set(),
    trustedAuthservIds: trustedAuthservId,
  });

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

  // Persisted verdicts must use the vocabulary the schema already defines
  // (migration 0021 CHECK): spam | ham | unsure | pending. The ambiguous middle
  // band is therefore 'unsure', not 'uncertain' — writing 'uncertain' violated
  // the constraint and silently dropped the verdict on the UPDATE.
  const verdict = blended >= SPAM_THRESHOLD ? 'spam' : blended < 0.3 ? 'ham' : 'unsure';

  const spamFolder = row.folder_mappings?.spam || null;

  // Auto-move ONLY on very high confidence AND with a configured spam folder.
  // Computed before `details` so the deferred intent is recorded alongside the verdict.
  const wouldAutoMove = verdict === 'spam'
    && blended >= AUTO_MOVE_THRESHOLD
    && mlActive
    && Boolean(spamFolder)
    && row.folder !== spamFolder;

  // When the caller defers the move (the backfill path), the message is TAGGED but
  // never moved: a reindex classifies a whole mailbox at once, and that many
  // concurrent moves would fight over the 2 pooled connections, each 10s overflow
  // loser opening a fresh login (PR review, 2026-09-15). The verdict, the score and
  // `autoMoveDeferred` are all persisted, so the intent is not lost — moving stays a
  // property of normal ingest, where messages arrive a few at a time.
  const deferAutoMove = Boolean(opts.deferAutoMove);
  const shouldMove = wouldAutoMove && !deferAutoMove;

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
    // Auth provenance, for the "Why?" modal and the trusted-authserv-id helper
    // in the account form. `authservIds` lists what the headers actually said;
    // `trustedAuthservId` is the id that was honored (null = none, so the auth
    // signal was treated as absent) and `authTrusted` reflects that decision.
    authservIds: observedAuthservIds,
    trustedAuthservId,
    authTrusted: trustedAuthservId !== null && observedAuthservIds.includes(trustedAuthservId),
    // True when this message WOULD have been auto-moved but the caller deferred it
    // (backfill). Lets the "Why?" view and a future deliberate catch-up pass tell a
    // deferred decision apart from one that was never eligible.
    autoMoveDeferred: wouldAutoMove && deferAutoMove,
  };

  await query(
    `UPDATE messages SET
       spam_verdict = $1, spam_score_ml = $2, spam_analyzed_at = NOW(), spam_details = $3
     WHERE id = $4`,
    [verdict, mlProbability ?? rules.score, JSON.stringify(details), messageId],
  );

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
    autoMoveDeferred: wouldAutoMove && deferAutoMove,
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
      await query(
        'UPDATE messages SET folder = $1, uid = $2 WHERE id = $3',
        [spamFolder, newUid, messageId],
      );
    } else {
      // Non-UIDPLUS server: DB holds the stale source UID at the destination.
      // Guard it so reconcileDeletes does not treat it as an orphan before the
      // next sync corrects it — the same guard the manual /spam path applies in
      // routes/mail.js, mirrored here so an auto-moved verdict survives reconcile.
      imap._guardMoveUid?.(row.account_id, spamFolder, row.uid);
      await query(
        'UPDATE messages SET folder = $1 WHERE id = $2',
        [spamFolder, messageId],
      );
      setTimeout(
        () => imap._unguardMoveUid?.(row.account_id, spamFolder, row.uid),
        10_000,
      );
    }
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