// Detected Authentication-Results authserv-ids for one account (v0.2).
//
// The trusted authserv-id (email_accounts.trusted_authserv_id) has to be typed
// by an admin, which is awkward: most people do not know what "authserv-id"
// means, let alone which value their mail provider stamps. Every classification
// already records the ids it saw in messages.spam_details (spamPipeline), so
// this helper reads them back and reports the ids that actually appear on the
// account's recently classified mail, most frequent first.
//
// Advisory only — nothing here is trusted automatically. A sender can inject an
// Authentication-Results header with any authserv-id they like, so an id that
// appears on a minority of messages is more likely forged than genuine; the
// caller shows the share so the admin can judge (the account's real receiving
// MTA is on essentially every message).

import { query } from './db.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_REPORTED = 5;

function parseDetails(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

/**
 * Aggregate the authserv-ids recorded in spam_details over the account's most
 * recent classified messages.
 *
 * @param {string} accountId
 * @param {Object} [opts]
 *   @param {number} [opts.limit] — messages to scan (default 200, max 500).
 * @returns {Promise<{ analyzed: number, detected: Array<{id: string, count: number}> }>}
 *   `analyzed` = classified messages looked at (0 = no data yet, e.g. antispam
 *   never ran for this account), `detected` = ids sorted by frequency.
 */
export async function detectAuthservIds(accountId, opts = {}) {
  const requested = Number(opts.limit);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const { rows } = await query(`
    SELECT spam_details
      FROM messages
     WHERE account_id = $1 AND spam_details IS NOT NULL
     ORDER BY date DESC NULLS LAST, uid DESC
     LIMIT $2
  `, [accountId, limit]);

  const counts = new Map();
  for (const row of rows) {
    const ids = parseDetails(row.spam_details)?.authservIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }

  const detected = [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, MAX_REPORTED);

  return { analyzed: rows.length, detected };
}
