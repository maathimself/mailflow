// Tags on messages: definitions, and which messages carry which tag. A tag belongs to a user; a
// message belongs to the user's account. Every read and write here is scoped to the owning user.
//
// A tag follows the email's Message-ID, not the row, so it survives a move and a resync. Known limits:
//   - Mail without a Message-ID is keyed by its row id ('row:<uuid>'). A move to Trash or Archive, or a
//     restore that recreates rows, gives it a new id, so it loses its tags.
//   - Different messages that share a Message-ID in one account share their tags.
//   - Tags of an email that is gone are pruned after a 7-day grace period; mail that comes back later
//     starts untagged.
import { query } from '../db.js';

const DEF_COLUMNS = 'id, name, color';

export async function listDefinitions(userId) {
  const { rows } = await query(
    `SELECT ${DEF_COLUMNS} FROM tag_definitions WHERE user_id = $1 ORDER BY created_at, id`,
    [userId]
  );
  return rows;
}

// Returns null when the user already has a tag with that name (compared without regard to case).
export async function createDefinition(userId, { name, color = '#6b7280' }) {
  const { rows } = await query(
    `INSERT INTO tag_definitions (user_id, name, color) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, lower(name)) DO NOTHING
     RETURNING ${DEF_COLUMNS}`,
    [userId, name, color]
  );
  return rows[0] || null;
}

// Returns the updated tag, null when it is not the user's, or 'duplicate' when the new name is taken.
export async function updateDefinition(userId, id, patch) {
  const sets = [];
  const params = [userId, id];
  for (const field of ['name', 'color']) {
    if (!(field in patch)) continue;
    params.push(patch[field]);
    sets.push(`${field} = $${params.length}`);
  }
  if (!sets.length) return null;
  try {
    const { rows } = await query(
      `UPDATE tag_definitions SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2 RETURNING ${DEF_COLUMNS}`,
      params
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === '23505') return 'duplicate';
    throw err;
  }
}

export async function deleteDefinition(userId, id) {
  const { rowCount } = await query('DELETE FROM tag_definitions WHERE user_id = $1 AND id = $2', [userId, id]);
  return rowCount > 0;
}

// Tags currently on each message, for messages the user owns. A tag belongs to the email (account +
// Message-ID, see tag_email_key), so it shows on every row of that email.
export async function tagsForMessages(userId, messageIds) {
  if (!messageIds.length) return {};
  const { rows } = await query(
    `SELECT m.id AS message_id, d.id AS tag_id, d.name, d.color
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       JOIN message_tags mt ON mt.account_id = m.account_id AND mt.email_key = tag_email_key(m.message_id, m.id)
       JOIN tag_definitions d ON d.id = mt.tag_id
      WHERE m.id = ANY($1::uuid[]) AND a.user_id = $2 AND d.user_id = $2
      ORDER BY d.created_at, d.id`,
    [messageIds, userId]
  );
  const out = {};
  for (const r of rows) {
    (out[r.message_id] ||= []).push({ tagId: r.tag_id, name: r.name, color: r.color });
  }
  pruneOrphanTagsSometimes().catch((err) => console.warn('[tags] pruning orphaned tags failed:', err.message));
  return out;
}

// The user adds or removes a tag by hand on a message. Returns false when the message or the tag is not
// the user's.
export async function setManualTag(userId, messageId, tagId, on) {
  const { rows } = await query(
    `WITH owned AS (
       SELECT m.account_id, tag_email_key(m.message_id, m.id) AS email_key
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
        WHERE m.id = $1 AND a.user_id = $3
          AND EXISTS (SELECT 1 FROM tag_definitions d WHERE d.id = $2 AND d.user_id = $3)
     ), added AS (
       INSERT INTO message_tags (account_id, email_key, tag_id)
       SELECT account_id, email_key, $2::uuid FROM owned WHERE $4::boolean
       ON CONFLICT (account_id, email_key, tag_id) DO UPDATE SET orphaned_at = NULL
       RETURNING 1
     ), removed AS (
       DELETE FROM message_tags mt USING owned o
        WHERE NOT $4::boolean AND mt.account_id = o.account_id AND mt.email_key = o.email_key AND mt.tag_id = $2
       RETURNING 1
     )
     SELECT 1 FROM owned`,
    [messageId, tagId, userId, on]
  );
  return rows.length > 0;
}

// Every row of the same email that the user has (the same message in another folder, or in All Inboxes),
// including `messageId` itself. Empty when the message is not the user's.
export async function copiesOfMessage(userId, messageId) {
  const { rows } = await query(
    `SELECT c.id
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       JOIN messages c ON c.account_id = m.account_id
        AND (c.id = m.id OR (NULLIF(m.message_id, '') IS NOT NULL AND c.message_id = m.message_id))
      WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId]
  );
  return rows.map((r) => r.id);
}

// ── orphans ───────────────────────────────────────────────────────────────────
const ORPHAN_GRACE = "interval '7 days'";
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
let lastPrune = 0;

// Tags whose email no longer exists (permanently deleted) are removed after a grace period. A move is a
// delete followed by an insert, so a row is only marked when no message matches, unmarked if one comes
// back, and deleted when it has stayed marked for the whole grace period.
export async function pruneOrphanTags() {
  // Compare the uuid, not 'row:' || id::text, so both halves can use an index. The CASE keeps the
  // cast away from Message-ID keys, which an AND would not guarantee.
  const exists = `EXISTS (SELECT 1 FROM messages m WHERE m.account_id = message_tags.account_id
                           AND (m.message_id = message_tags.email_key
                                OR m.id = CASE WHEN message_tags.email_key LIKE 'row:%' THEN substr(message_tags.email_key, 5)::uuid END))`;
  await query(`UPDATE message_tags SET orphaned_at = NOW() WHERE orphaned_at IS NULL AND NOT ${exists}`);
  await query(`UPDATE message_tags SET orphaned_at = NULL WHERE orphaned_at IS NOT NULL AND ${exists}`);
  const { rowCount } = await query(`DELETE FROM message_tags WHERE orphaned_at IS NOT NULL AND orphaned_at < NOW() - ${ORPHAN_GRACE}`);
  return rowCount;
}

async function pruneOrphanTagsSometimes() {
  if (Date.now() - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = Date.now();
  await pruneOrphanTags();
}
