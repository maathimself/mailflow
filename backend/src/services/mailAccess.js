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
import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function snapshotVersion(snapshot) {
  const canonical = JSON.stringify(canonicalValue({
    userId: snapshot.userId,
    pluginId: snapshot.pluginId,
    anchorId: snapshot.anchorId,
    account: snapshot.account,
    config: snapshot.config,
    configUpdatedAt: snapshot.configUpdatedAt,
    activated: snapshot.activated,
    threadKey: snapshot.threadKey,
    rows: snapshot.rows,
  }));
  return createHash('sha256').update(canonical).digest('hex');
}

export async function readPluginThreadSnapshot(tx, userId, messageId, pluginId) {
  const anchorResult = await tx.query(
    `SELECT m.id AS anchor_id, m.account_id, m.thread_key,
            jsonb_build_object(
              'id', a.id,
              'user_id', a.user_id,
              'enabled', a.enabled,
              'folder_mappings', COALESCE(a.folder_mappings, '{}'::jsonb),
              'mailbox_topology_generation', a.mailbox_topology_generation
            ) AS account,
            COALESCE(pac.config, '{}'::jsonb) AS plugin_config,
            pac.updated_at AS plugin_config_updated_at,
            COALESCE(u.preferences -> 'enabledPlugins', '[]'::jsonb) AS enabled_plugins
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       JOIN users u ON u.id = a.user_id
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       LEFT JOIN plugin_account_config pac
         ON pac.account_id = a.id AND pac.plugin_id = $3
      WHERE m.id = $1 AND a.user_id = $2
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL`,
    [messageId, userId, pluginId],
  );
  const anchor = anchorResult.rows[0];
  if (!anchor?.thread_key) return null;
  const threadResult = await tx.query(
    `SELECT m.id, m.account_id, m.thread_key, m.uid, m.folder, m.message_id, m.is_read,
            m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation,
            f.topology_identity AS folder_topology_identity
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.account_id = $1 AND m.thread_key = $2
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL
      ORDER BY m.folder, m.uid, m.id`,
    [anchor.account_id, anchor.thread_key],
  );
  const enabledPlugins = Array.isArray(anchor.enabled_plugins) ? anchor.enabled_plugins : [];
  const snapshot = {
    userId,
    pluginId,
    anchorId: anchor.anchor_id,
    account: anchor.account,
    config: anchor.plugin_config || {},
    configUpdatedAt: anchor.plugin_config_updated_at || null,
    activated: enabledPlugins.includes(pluginId),
    threadKey: anchor.thread_key,
    rows: threadResult.rows || [],
  };
  if (!snapshot.rows.some(row => row.id === snapshot.anchorId)) return null;
  return { ...snapshot, version: snapshotVersion(snapshot) };
}

export async function loadPluginThreadSnapshot(userId, messageId, pluginId) {
  return withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return readPluginThreadSnapshot(tx, userId, messageId, pluginId);
  });
}

export async function validatePluginThreadSnapshot(snapshot) {
  const current = await loadPluginThreadSnapshot(
    snapshot.userId, snapshot.anchorId, snapshot.pluginId,
  );
  if (!current || current.version !== snapshot.version) {
    const error = new Error('Plugin thread snapshot was superseded');
    error.code = 'PLUGIN_THREAD_SNAPSHOT_SUPERSEDED';
    error.retryable = true;
    throw error;
  }
  return current;
}

// A message the user owns (joined through their accounts), or null. Full row (m.*).
export async function loadOwnedMessage(userId, messageId) {
  const { rows } = await query(
    `SELECT m.*, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.id = $1 AND a.user_id = $2
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL`,
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
    `SELECT m.thread_key, m.uid, m.folder, m.from_email, m.date, m.id,
            m.account_id, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.account_id = $1 AND m.thread_key = ANY($2::text[])
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL`,
    [accountId, threadKeys]
  );
  return rows;
}

// Exact immutable worklist for a thread mutation. The caller first establishes ownership by
// loading the acted row and account; this capability stays within that account and returns only
// verified live rows plus the identity/state needed by core mutation primitives. Late arrivals
// are intentionally not included: /done acts on the snapshot it authorized, never on a moving
// thread-key target.
export async function listLiveThreadRows(accountId, threadKey) {
  const { rows } = await query(
    `SELECT m.id, m.account_id, m.thread_key, m.uid, m.folder, m.message_id, m.is_read,
            m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.account_id = $1 AND m.thread_key = $2
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL
      ORDER BY m.folder, m.uid, m.id`,
    [accountId, threadKey]
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
    `SELECT m.id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
            m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation,
            COALESCE(NULLIF(m.body_text, ''), m.snippet) AS content
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.id = ANY($1::uuid[]) AND m.account_id = $2
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL`,
    [ids, accountId]
  );
  return rows;
}

function messageFieldsSnapshotValues(snapshot) {
  return [
    snapshot.uid,
    snapshot.folder,
    snapshot.read_revision,
    snapshot.star_revision,
    snapshot.folder_uid_validity,
    snapshot.folder_observation_generation,
    snapshot.subject ?? null,
    snapshot.from_name ?? null,
    snapshot.from_email ?? null,
    snapshot.content ?? null,
  ];
}

function messageFieldsSnapshotPredicate(startIndex) {
  const p = Array.from({ length: 10 }, (_, index) => `$${startIndex + index}`);
  return `m.uid = ${p[0]} AND m.folder = ${p[1]}
        AND m.read_revision = ${p[2]} AND m.star_revision = ${p[3]}
        AND f.uid_validity = ${p[4]} AND f.observation_generation = ${p[5]}
        AND m.subject IS NOT DISTINCT FROM ${p[6]}
        AND m.from_name IS NOT DISTINCT FROM ${p[7]}
        AND m.from_email IS NOT DISTINCT FROM ${p[8]}
        AND COALESCE(NULLIF(m.body_text, ''), m.snippet) IS NOT DISTINCT FROM ${p[9]}`;
}

// Recheck the exact live row snapshot immediately before an external/content-derived action.
// Returning false (rather than a partially refreshed row) makes callers explicitly restart from
// a fresh actionable read after any row revision, folder epoch, or summarized-content change.
export async function validateMessageFieldsSnapshot(accountId, snapshot) {
  if (!accountId || !snapshot?.id) return false;
  const { rows } = await query(
    `SELECT 1
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.account_id = $1 AND m.id = $2
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL
        AND ${messageFieldsSnapshotPredicate(3)}
      LIMIT 1`,
    [accountId, snapshot.id, ...messageFieldsSnapshotValues(snapshot)],
  );
  return rows.length === 1;
}

// Snapshot-CAS variant for content-derived annotations. The second validation in the caller is
// intentionally backed by this predicate again so a row cannot become stale in the final await
// gap between validation and UPDATE.
export async function setMessageAnnotationForSnapshot(accountId, snapshot, pluginId, patch) {
  if (!accountId || !snapshot?.id) return 0;
  const { rowCount } = await query(
    `UPDATE messages m
        SET plugin_annotations = jsonb_set(
              COALESCE(m.plugin_annotations, '{}'::jsonb),
              ARRAY[$3::text],
              COALESCE(m.plugin_annotations -> $3, '{}'::jsonb) || $4::jsonb,
              true)
       FROM folders f
      WHERE m.account_id = $1 AND m.id = $2
        AND f.account_id = m.account_id AND f.path = m.folder
        AND m.is_deleted = false AND m.metadata_complete = true
        AND f.is_present = true AND f.uid_validity IS NOT NULL
        AND ${messageFieldsSnapshotPredicate(5)}`,
    [
      accountId, snapshot.id, pluginId, JSON.stringify(patch),
      ...messageFieldsSnapshotValues(snapshot),
    ],
  );
  return rowCount;
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
