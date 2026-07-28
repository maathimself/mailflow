// Account/alias/compose/outbox SQL seam for MCP write tools. Callers pass account
// ids or a user id already resolved from the bearer token; every lookup keeps
// that boundary in SQL.
import { query } from '../services/db.js';
import { safeAccount, SAFE_FIELDS } from '../services/accountFields.js';
import { sanitizeSignature } from '../services/emailSanitizer.js';
import {
  DEFAULT_GTD_FOLDERS,
  findGtdFolderCollisions,
  invalidateGtdConfigCache,
  sanitizeGtdFoldersDetailed,
} from '../services/gtdConfig.js';
import { invalidateOwnerAddressesCache } from '../services/gtdTransitions.js';
import { applyInboxRules, toRuleMessage } from '../services/inboxRules.js';
import { DETAIL_COLUMNS } from './engineAdapter.js';

const COMPOSE_SOURCE_COLUMNS = DETAIL_COLUMNS +
  ', m.uid, m.reply_to, m.in_reply_to, m.thread_references';

export async function getAccountRow(accountId, accountIds) {
  if (!accountIds?.includes(accountId)) return null;
  const { rows } = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND id = ANY($2)',
    [accountId, accountIds],
  );
  return rows[0] || null;
}

export async function getAccountByEmail(email, accountIds) {
  if (!accountIds?.length) return { error: `account_not_found: ${email}` };
  const { rows } = await query(
    'SELECT * FROM email_accounts WHERE email_address = $1 AND id = ANY($2)',
    [email, accountIds],
  );
  return rows[0] || { error: `account_not_found: ${email}` };
}

export async function listAliases(accountId) {
  const { rows } = await query(
    'SELECT * FROM account_aliases WHERE account_id = $1 ORDER BY created_at',
    [accountId],
  );
  return rows;
}

export async function resolveAlias(accountId, aliasEmail) {
  // Keep the same predicate as mail/identity.js intentionally: this adapter lets
  // MCP tools preflight an email selector as row-or-null, while identity.js must
  // still hard-fail aliasId/aliasEmail selectors for existing REST service callers.
  const { rows } = await query(
    'SELECT * FROM account_aliases WHERE account_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1',
    [accountId, aliasEmail],
  );
  return rows[0] || null;
}

export async function getComposeSource(messageId, accountIds) {
  if (!accountIds?.length) return null;
  const { rows } = await query(
    `SELECT ${COMPOSE_SOURCE_COLUMNS}
     FROM messages m
     WHERE m.id = $1 AND m.account_id = ANY($2)`,
    [messageId, accountIds],
  );
  return rows[0] || null;
}

export async function getOutboxRowByMessageId(messageId, userId) {
  const { rows } = await query(
    `SELECT *
     FROM outbox_messages
     WHERE message_id = $1 AND user_id = $2 AND status = 'pending'
     LIMIT 1`,
    [messageId, userId],
  );
  return rows[0] || null;
}

export async function deleteMessageRow(accountId, uid, folder) {
  const result = await query(
    'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [accountId, uid, folder],
  );
  return result.rowCount;
}

export async function listDraftRows(accountId, { limit, offset, folder } = {}) {
  const params = [accountId];
  const where = ['account_id = $1', 'is_deleted = false'];
  if (folder) {
    params.push(folder);
    where.push(`folder = $${params.length}`);
  }
  params.push(limit, offset);
  const limitParam = `$${params.length - 1}`;
  const offsetParam = `$${params.length}`;
  const { rows } = await query(
    `SELECT * FROM messages
     WHERE ${where.join(' AND ')}
     ORDER BY date DESC NULLS LAST
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );
  return rows;
}

export async function getDraftRow(accountId, folder, uid) {
  const { rows } = await query(
    `SELECT * FROM messages
     WHERE account_id = $1 AND folder = $2 AND uid = $3 AND is_deleted = false
     LIMIT 1`,
    [accountId, folder, uid],
  );
  return rows[0] || null;
}

export async function getUserPreferences(userId) {
  const { rows } = await query(
    'SELECT preferences FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.preferences || {};
}

export async function listAccountsSafe(accountIds) {
  if (!accountIds?.length) return [];
  const { rows } = await query(
    `SELECT ${SAFE_FIELDS.join(', ')}
     FROM email_accounts
     WHERE id = ANY($1)
     ORDER BY sort_order, created_at`,
    [accountIds],
  );

  const aliasesByAccount = new Map();
  if (rows.length) {
    const aliases = await query(
      `SELECT id, account_id, name, email, reply_to, signature, created_at
       FROM account_aliases WHERE account_id = ANY($1) ORDER BY created_at`,
      [rows.map((account) => account.id)],
    );
    for (const alias of aliases.rows) {
      if (!aliasesByAccount.has(alias.account_id)) aliasesByAccount.set(alias.account_id, []);
      aliasesByAccount.get(alias.account_id).push({
        ...alias,
        signature: alias.signature ? sanitizeSignature(alias.signature) : alias.signature,
      });
    }
  }

  return rows.map((row) => ({
    ...safeAccount(row),
    aliases: aliasesByAccount.get(row.id) || [],
  }));
}

const MCP_ACCOUNT_UPDATE_FIELDS = [
  'name',
  'sender_name',
  'color',
  'sort_order',
  'folder_mappings',
  'signature',
  'categorization_enabled',
  'gtd_enabled',
  'gtd_folders',
  'enabled',
];

export async function updateAccountSettings({ accountId, accountIds, updates }) {
  if (!accountIds?.includes(accountId)) return { error: 'Account not found', status: 404 };
  const check = await query(
    'SELECT id, gtd_folders FROM email_accounts WHERE id = $1 AND id = ANY($2)',
    [accountId, accountIds],
  );
  if (!check.rows.length) return { error: 'Account not found', status: 404 };

  let gtdFoldersValue;
  let gtdRejected = [];
  let gtdFoldersChanged = false;
  if ('gtd_folders' in updates) {
    const { folders, rejected, reserved } = sanitizeGtdFoldersDetailed(updates.gtd_folders);
    if (reserved.length) {
      return {
        error: 'A GTD state cannot map to a reserved system folder',
        reserved,
        status: 400,
      };
    }
    const collisions = findGtdFolderCollisions({
      ...DEFAULT_GTD_FOLDERS,
      ...folders,
    });
    if (collisions.length) {
      return {
        error: 'Two GTD states cannot map to the same folder',
        collisions,
        status: 400,
      };
    }
    gtdFoldersValue = folders;
    gtdRejected = rejected;
    const before = sanitizeGtdFoldersDetailed(check.rows[0].gtd_folders).folders;
    gtdFoldersChanged = JSON.stringify(before) !== JSON.stringify(folders);
  }

  const sets = [];
  const values = [];
  for (const key of MCP_ACCOUNT_UPDATE_FIELDS) {
    if (!(key in updates)) continue;
    sets.push(`${key} = $${values.length + 1}`);
    const value = key === 'signature'
      ? sanitizeSignature(updates[key]) || null
      : key === 'gtd_enabled'
        ? !!updates[key]
        : key === 'gtd_folders'
          ? gtdFoldersValue
          : updates[key];
    values.push(value);
  }
  if (!sets.length) return { error: 'No valid fields to update', status: 400 };

  const idParam = values.length + 1;
  const scopeParam = values.length + 2;
  values.push(accountId, accountIds);
  const result = await query(
    `UPDATE email_accounts SET ${sets.join(', ')}
     WHERE id = $${idParam} AND id = ANY($${scopeParam}) RETURNING *`,
    values,
  );
  if (!result.rows.length) return { error: 'Account not found', status: 404 };

  const updated = result.rows[0];
  const account = safeAccount(updated);
  if ('gtd_folders' in updates) account.gtd_folders_rejected = gtdRejected;
  if ('gtd_enabled' in updates || 'gtd_folders' in updates) {
    invalidateGtdConfigCache(accountId);
  }
  if ('enabled' in updates || 'gtd_enabled' in updates || 'gtd_folders' in updates) {
    const { reconcileConnectionState } = await import('../services/accountService.js');
    reconcileConnectionState({
      id: accountId,
      updates,
      before: { gtdFoldersChanged },
      updated,
    });
  }
  return { account };
}

async function accountOwnedByUser(accountId, accountIds, userId) {
  if (!accountIds?.includes(accountId)) return false;
  const { rows } = await query(
    'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 AND id = ANY($3)',
    [accountId, userId, accountIds],
  );
  return rows.length > 0;
}

export async function createAlias({
  accountId,
  accountIds,
  userId,
  fields,
}) {
  if (!(await accountOwnedByUser(accountId, accountIds, userId))) return null;
  const result = await query(
    `INSERT INTO account_aliases (account_id, name, email, reply_to, signature)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      accountId,
      fields.name,
      fields.email,
      fields.reply_to || null,
      sanitizeSignature(fields.signature) || null,
    ],
  );
  invalidateOwnerAddressesCache(accountId);
  return result.rows[0];
}

async function ownedAlias(accountId, accountIds, userId, aliasId) {
  if (!accountIds?.includes(accountId)) return null;
  const { rows } = await query(
    `SELECT a.id, a.account_id FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.user_id = $2 AND e.id = $3 AND e.id = ANY($4)`,
    [aliasId, userId, accountId, accountIds],
  );
  return rows[0] || null;
}

export async function updateAlias({
  accountId,
  accountIds,
  userId,
  aliasId,
  fields,
}) {
  const owned = await ownedAlias(accountId, accountIds, userId, aliasId);
  if (!owned) return null;
  const result = await query(
    `UPDATE account_aliases
     SET name = $1, email = $2, reply_to = $3, signature = $4
     WHERE id = $5 RETURNING *`,
    [
      fields.name,
      fields.email,
      fields.reply_to || null,
      sanitizeSignature(fields.signature) || null,
      aliasId,
    ],
  );
  invalidateOwnerAddressesCache(accountId);
  return result.rows[0] || null;
}

export async function deleteAlias({
  accountId,
  accountIds,
  userId,
  aliasId,
}) {
  const owned = await ownedAlias(accountId, accountIds, userId, aliasId);
  if (!owned) return false;
  await query('DELETE FROM account_aliases WHERE id = $1', [aliasId]);
  invalidateOwnerAddressesCache(accountId);
  return true;
}

export async function listRules({ userId, accountId }) {
  const params = [userId];
  const accountFilter = accountId
    ? ' AND (account_id IS NULL OR account_id = $2)'
    : '';
  if (accountId) params.push(accountId);
  const { rows } = await query(
    `SELECT * FROM inbox_rules WHERE user_id = $1${accountFilter}
     ORDER BY priority, created_at`,
    params,
  );
  return rows;
}

async function moveDestinationError(accountId, actions) {
  const moveAction = actions.find(
    (action) => action.type === 'move' && action.value?.trim(),
  );
  if (!moveAction || !accountId) return null;
  const { rows } = await query(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
     FROM folders WHERE account_id = $1`,
    [accountId, moveAction.value.trim()],
  );
  const { total, match } = rows[0];
  if (parseInt(total, 10) > 0 && parseInt(match, 10) === 0) {
    return 'Move destination folder not found for this account';
  }
  return null;
}

export async function createRule({
  userId,
  accountId,
  name,
  conditionLogic,
  conditions,
  actions,
  enabled,
  stopProcessing,
}) {
  const folderError = await moveDestinationError(accountId, actions);
  if (folderError) return { error: folderError, status: 400 };
  const countResult = await query(
    'SELECT COUNT(*) AS cnt FROM inbox_rules WHERE user_id = $1',
    [userId],
  );
  const priority = parseInt(countResult.rows[0].cnt, 10);
  const result = await query(
    `INSERT INTO inbox_rules
       (user_id, account_id, name, enabled, stop_processing, priority, condition_logic, conditions, actions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      userId,
      accountId || null,
      name || '',
      enabled !== false,
      !!stopProcessing,
      priority,
      conditionLogic === 'OR' ? 'OR' : 'AND',
      JSON.stringify(conditions),
      JSON.stringify(actions),
    ],
  );
  return result.rows[0];
}

export async function updateRule({
  userId,
  ruleId,
  accountId,
  name,
  conditionLogic,
  conditions,
  actions,
  enabled,
  stopProcessing,
}) {
  const folderError = await moveDestinationError(accountId, actions);
  if (folderError) return { error: folderError, status: 400 };
  const result = await query(
    `UPDATE inbox_rules
     SET name = $1, account_id = $2, enabled = $3, stop_processing = $4,
         condition_logic = $5, conditions = $6, actions = $7, updated_at = NOW()
     WHERE id = $8 AND user_id = $9
     RETURNING *`,
    [
      name || '',
      accountId || null,
      enabled !== false,
      !!stopProcessing,
      conditionLogic === 'OR' ? 'OR' : 'AND',
      JSON.stringify(conditions),
      JSON.stringify(actions),
      ruleId,
      userId,
    ],
  );
  return result.rows[0] || null;
}

export async function deleteRule({ userId, ruleId }) {
  const result = await query(
    'DELETE FROM inbox_rules WHERE id = $1 AND user_id = $2 RETURNING id',
    [ruleId, userId],
  );
  return result.rows.length > 0;
}

export async function runRules({ userId, accountIds, imapManager }) {
  let processed = 0;
  let matched = 0;
  for (const accountId of accountIds || []) {
    try {
      const rulesCheck = await query(
        `SELECT COUNT(*) AS cnt FROM inbox_rules
         WHERE user_id = $1 AND enabled = true
           AND (account_id IS NULL OR account_id = $2)`,
        [userId, accountId],
      );
      if (parseInt(rulesCheck.rows[0].cnt, 10) === 0) continue;

      const accountResult = await query(
        'SELECT * FROM email_accounts WHERE id = $1 AND id = ANY($2)',
        [accountId, accountIds],
      );
      const account = accountResult.rows[0];
      if (!account) continue;

      const batchSize = 500;
      let lastId = null;
      while (true) {
        const messageResult = await query(
          `SELECT id, uid, folder, from_email, from_name, to_addresses,
                  subject, has_attachments, is_read
           FROM messages
           WHERE account_id = $1 AND lower(folder) = 'inbox'
             ${lastId ? 'AND id > $3' : ''}
           ORDER BY id
           LIMIT $2`,
          lastId
            ? [accountId, batchSize, lastId]
            : [accountId, batchSize],
        );
        if (!messageResult.rows.length) break;
        lastId = messageResult.rows.at(-1).id;
        const messages = messageResult.rows.map(toRuleMessage);
        const { remaining } = await applyInboxRules(
          messages,
          account,
          imapManager,
        );
        processed += messages.length;
        matched += messages.length - remaining.length;
        if (messageResult.rows.length < batchSize) break;
      }
    } catch (error) {
      console.error(`MCP run_rules error for account ${accountId}:`, error.message);
    }
  }
  return { processed, matched };
}
