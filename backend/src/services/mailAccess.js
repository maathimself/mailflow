// Safe, fixed mail/account read capabilities for plugins (v3.0 plugin platform).
//
// A plugin never runs raw SQL. Instead it calls this reviewed, bounded set of read functions
// (surfaced through the plugin-api barrel). Each is a specific, auditable query — never an
// arbitrary statement — so the surface a plugin can reach is exactly what's here and nothing more.
//
// Scoping: user-entry reads (loadOwnedMessage, listUserAccounts, getOwnedAccount) are keyed by
// userId and enforce ownership. Account-scoped reads take an accountId the caller has already
// established it owns (via one of the user-keyed reads) and only ever read within that account —
// they never span accounts or users.
import { query } from './db.js';

// A message the user owns (joined through their accounts), or null. Full row (m.*).
export async function loadOwnedMessage(userId, messageId) {
  const { rows } = await query(
    `SELECT m.*
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId]
  );
  return rows[0] || null;
}

// One of the user's accounts by id (ownership enforced), or null. Full row.
export async function getOwnedAccount(userId, accountId) {
  const { rows } = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, userId]
  );
  return rows[0] || null;
}

// All of the user's accounts (light columns for listing/iteration). The caller filters by its
// own per-account config (e.g. which accounts have a feature enabled).
export async function listUserAccounts(userId) {
  const { rows } = await query(
    `SELECT id, email_address, folder_mappings, include_in_unified_inbox, enabled
       FROM email_accounts
      WHERE user_id = $1
      ORDER BY sort_order, created_at`,
    [userId]
  );
  return rows;
}

// The account's own addresses (login address + aliases) as raw strings. The caller normalizes.
export async function getAccountAddresses(accountId) {
  const { rows } = await query(
    `SELECT email_address AS addr FROM email_accounts WHERE id = $1
     UNION ALL
     SELECT email AS addr FROM account_aliases WHERE account_id = $1`,
    [accountId]
  );
  return rows.map((r) => r.addr);
}

// Distinct thread keys for a set of row ids within an account.
export async function getThreadKeysForMessageIds(accountId, ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await query(
    `SELECT DISTINCT thread_key FROM messages
      WHERE account_id = $1 AND id = ANY($2::uuid[])`,
    [accountId, ids]
  );
  return rows.map((r) => r.thread_key);
}

// Distinct thread keys for the live messages currently in a set of folders within an account.
export async function getThreadKeysInFolders(accountId, folders) {
  if (!folders || folders.length === 0) return [];
  const { rows } = await query(
    `SELECT DISTINCT thread_key FROM messages
      WHERE account_id = $1 AND folder = ANY($2::text[]) AND is_deleted = false`,
    [accountId, folders]
  );
  return rows.map((r) => r.thread_key);
}

// Distinct thread keys for messages matching any of the given RFC Message-IDs within an account.
export async function getThreadKeysForMessageIdHeaders(accountId, messageIdHeaders) {
  if (!messageIdHeaders || messageIdHeaders.length === 0) return [];
  const { rows } = await query(
    `SELECT DISTINCT thread_key FROM messages
      WHERE account_id = $1 AND message_id = ANY($2::text[]) AND is_deleted = false`,
    [accountId, messageIdHeaders]
  );
  return rows.map((r) => r.thread_key);
}

// The live messages of a set of threads within an account (fields a labeler needs to decide
// recency/sender). Excludes deleted rows.
export async function getMessagesByThreadKeys(accountId, threadKeys) {
  if (!threadKeys || threadKeys.length === 0) return [];
  const { rows } = await query(
    `SELECT thread_key, uid, folder, from_email, date, id
       FROM messages
      WHERE account_id = $1 AND thread_key = ANY($2::text[]) AND is_deleted = false`,
    [accountId, threadKeys]
  );
  return rows;
}

// The thread key of a single message identified by its (uid, folder) within an account, or null.
export async function getThreadKeyForUid(accountId, uid, folder) {
  const { rows } = await query(
    'SELECT thread_key FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 LIMIT 1',
    [accountId, uid, folder]
  );
  return rows[0]?.thread_key ?? null;
}

// The distinct folders that currently hold a live copy of a message (by RFC Message-ID) in an
// account — i.e. which label folders a thread is present in.
export async function getMessageCopyFolders(accountId, messageIdHeader) {
  const { rows } = await query(
    'SELECT DISTINCT folder FROM messages WHERE account_id = $1 AND message_id = $2 AND is_deleted = false',
    [accountId, messageIdHeader]
  );
  return rows.map((r) => r.folder);
}

// Display/summarize fields for a set of message rows within an account (the body is the text body
// falling back to the snippet). Used e.g. to feed a summarizer.
export async function getMessageFields(accountId, ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await query(
    `SELECT id, subject, from_name, from_email,
            COALESCE(NULLIF(body_text, ''), snippet) AS content
       FROM messages
      WHERE id = ANY($1::uuid[]) AND account_id = $2`,
    [ids, accountId]
  );
  return rows;
}

// A plugin's own per-message annotations for a set of message ids within an account, as
// { [messageId]: <the plugin's annotation object> }. Reads only this plugin's namespace.
export async function getMessageAnnotations(accountId, ids, pluginId) {
  if (!ids || ids.length === 0) return {};
  const { rows } = await query(
    'SELECT id, plugin_annotations -> $3 AS ann FROM messages WHERE account_id = $1 AND id = ANY($2::uuid[])',
    [accountId, ids, pluginId]
  );
  const out = {};
  for (const r of rows) if (r.ann != null) out[r.id] = r.ann;
  return out;
}

// Label-folder membership for a bounded set of message rows. Targets are scoped to one account;
// their live siblings are joined by the stored thread key so plugins can decorate existing rows
// without adding feature-specific joins to the core message-list query.
export async function getLabelMetadata(accountId, messageIds, labelFolders) {
  if (!messageIds?.length || !labelFolders?.length) return [];
  const { rows } = await query(
    `SELECT target.id AS message_id, sibling.folder, MAX(sibling.date) AS date
       FROM messages target
       JOIN messages sibling
         ON sibling.account_id = target.account_id
        AND sibling.thread_key = target.thread_key
        AND sibling.folder = ANY($3::text[])
        AND sibling.is_deleted = false
      WHERE target.account_id = $1
        AND target.id = ANY($2::uuid[])
      GROUP BY target.id, sibling.folder
      ORDER BY target.id, sibling.folder`,
    [accountId, messageIds, labelFolders]
  );
  return rows.map(row => ({
    messageId: row.message_id,
    folder: row.folder,
    date: row.date == null ? null : new Date(row.date).toISOString(),
  }));
}

// Merge `patch` into a plugin's namespace of a message's annotations (creating the namespace if
// absent). Only ever touches plugin_annotations -> pluginId. Returns rows updated (0 if the
// message isn't in the account). The annotation cache is cleaned with the message row on delete.
export async function setMessageAnnotation(accountId, messageId, pluginId, patch) {
  const { rowCount } = await query(
    `UPDATE messages
        SET plugin_annotations = jsonb_set(
              COALESCE(plugin_annotations, '{}'::jsonb),
              ARRAY[$3::text],
              COALESCE(plugin_annotations -> $3, '{}'::jsonb) || $4::jsonb,
              true)
      WHERE id = $2 AND account_id = $1`,
    [accountId, messageId, pluginId, JSON.stringify(patch)]
  );
  return rowCount;
}
