import { query } from './db.js';
import { getGtdConfig, resolveGtdStateFolder } from './gtdConfig.js';
import { createKeyedSerializer } from '../utils/keyedSerializer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const serializeDelegation = createKeyedSerializer();

export class GtdDelegationError extends Error {
  constructor(code, status, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function mapDelegationRow(row) {
  if (!row?.delegation) return null;
  return typeof row.delegation === 'string' ? JSON.parse(row.delegation) : row.delegation;
}

export async function loadOwnedContactSnapshot(userId, contactId) {
  const { rows } = await query(`
    SELECT c.id, COALESCE(c.display_name, c.primary_email, 'Unknown contact') AS display_name,
           c.primary_email
    FROM contacts c
    WHERE c.id = $1 AND c.user_id = $2
  `, [contactId, userId]);
  if (!rows[0]) throw new GtdDelegationError('contact_not_found', 404);
  return rows[0];
}

export async function upsertDelegation({ userId, accountId, threadKey, contact }) {
  const { rows } = await query(`
    INSERT INTO gtd_delegations (
      user_id, account_id, thread_key, contact_id,
      contact_display_name_snapshot, contact_primary_email_snapshot
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id, account_id, thread_key) DO UPDATE SET
      contact_id = EXCLUDED.contact_id,
      contact_display_name_snapshot = EXCLUDED.contact_display_name_snapshot,
      contact_primary_email_snapshot = EXCLUDED.contact_primary_email_snapshot,
      delegated_at = CASE
        WHEN gtd_delegations.contact_id IS DISTINCT FROM EXCLUDED.contact_id THEN NOW()
        ELSE gtd_delegations.delegated_at
      END,
      updated_at = NOW()
    RETURNING contact_id,
      contact_display_name_snapshot AS display_name,
      contact_primary_email_snapshot AS primary_email,
      delegated_at, updated_at
  `, [userId, accountId, threadKey, contact.id, contact.display_name, contact.primary_email]);
  return rows[0];
}

export async function clearDelegations({ userId, accountId, threadKeys }) {
  const unique = [...new Set(threadKeys.filter(Boolean))];
  if (unique.length === 0) return 0;
  const result = await query(`
    DELETE FROM gtd_delegations
    WHERE user_id = $1 AND account_id = $2 AND thread_key = ANY($3::text[])
  `, [userId, accountId, unique]);
  return result.rowCount;
}

export async function reconcileDelegatedRemovals({ userId, accountId, delegatedFolder, threadKeys }) {
  const unique = [...new Set(threadKeys.filter(Boolean))];
  if (!unique.length) return 0;
  const result = await query(`
    DELETE FROM gtd_delegations gd
    WHERE gd.user_id = $1
      AND gd.account_id = $2
      AND gd.thread_key = ANY($3::text[])
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.account_id = gd.account_id
          AND m.thread_key = gd.thread_key
          AND m.folder = $4
          AND m.is_deleted = false
      )
  `, [userId, accountId, unique, delegatedFolder]);
  return result.rowCount;
}

export async function sweepStaleDelegations({ userId, accountId, delegatedFolder }) {
  const result = await query(`
    DELETE FROM gtd_delegations gd
    WHERE gd.user_id = $1
      AND gd.account_id = $2
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.account_id = gd.account_id
          AND m.thread_key = gd.thread_key
          AND m.folder = $3
          AND m.is_deleted = false
      )
  `, [userId, accountId, delegatedFolder]);
  return result.rowCount;
}

export const DELEGATION_SELECT_SQL = 'delegation_meta.delegation AS delegation';

export function delegationJoinSql(messageAlias = 'm', accountAlias = 'a') {
  if (![messageAlias, accountAlias].every(alias => /^[a-z][a-z0-9_]*$/i.test(alias))) {
    throw new TypeError('Invalid SQL alias');
  }
  return `LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'contact_id', gd.contact_id,
      'display_name', COALESCE(dc.display_name, gd.contact_display_name_snapshot),
      'primary_email', COALESCE(dc.primary_email, gd.contact_primary_email_snapshot),
      'delegated_at', gd.delegated_at,
      'updated_at', gd.updated_at
    ) AS delegation
    FROM gtd_delegations gd
    LEFT JOIN contacts dc ON dc.id = gd.contact_id AND dc.user_id = gd.user_id
    WHERE gd.user_id = ${accountAlias}.user_id
      AND gd.account_id = ${messageAlias}.account_id
      AND gd.thread_key = ${messageAlias}.thread_key
  ) delegation_meta ON TRUE`;
}

async function loadOwnedTargets(userId, messageIds) {
  const { rows } = await query(`
    SELECT m.id, m.account_id, m.uid, m.folder, m.message_id, m.thread_key
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE a.user_id = $1 AND m.id = ANY($2::uuid[]) AND m.is_deleted = false
  `, [userId, messageIds]);
  return rows;
}

async function loadAccount(accountId, userId) {
  const { rows } = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true',
    [accountId, userId],
  );
  return rows[0] || null;
}

async function liveDelegatedCopies(target, folder) {
  const { rows } = await query(`
    SELECT uid FROM messages
    WHERE account_id = $1 AND thread_key = $2 AND folder = $3 AND is_deleted = false
    ORDER BY date DESC NULLS LAST
  `, [target.account_id, target.thread_key, folder]);
  return rows;
}

async function compensateCopy({ target, folder, copiedUid, imapManager }) {
  try {
    if (copiedUid == null) return false;
    await imapManager.removeMessageCopy(target.account_id, copiedUid, folder);
    return true;
  } catch {
    return false;
  }
}

const publicFailure = (messageId, code = 'operation_failed', compensated = false) => ({
  messageId,
  ok: false,
  error: { code, message: code === 'not_found' ? 'Message not found' : 'Delegation failed' },
  compensated,
});

export async function delegateMessages({ userId, messageIds, contactId, imapManager }) {
  if (!Array.isArray(messageIds)) throw new GtdDelegationError('invalid_request', 400);
  const inputIds = [...new Set(messageIds)];
  if (inputIds.length < 1 || inputIds.length > 100 || inputIds.some(id => !UUID_RE.test(id))) {
    throw new GtdDelegationError('invalid_request', 400);
  }
  if (contactId !== null && !UUID_RE.test(contactId || '')) {
    throw new GtdDelegationError('invalid_request', 400);
  }
  const contact = contactId === null ? null : await loadOwnedContactSnapshot(userId, contactId);
  const rows = await loadOwnedTargets(userId, inputIds);
  const byId = new Map(rows.map(row => [row.id, row]));
  const outcomes = new Map(inputIds.filter(id => !byId.has(id)).map(id => [id, publicFailure(id, 'not_found')]));
  const threads = new Map();
  for (const id of inputIds) {
    const row = byId.get(id);
    if (!row) continue;
    if (!row.thread_key) {
      outcomes.set(id, publicFailure(id));
      continue;
    }
    const key = `${row.account_id}\u0000${row.thread_key}`;
    const item = threads.get(key) || { target: row, ids: [] };
    item.ids.push(id);
    threads.set(key, item);
  }

  for (const [threadKey, { target, ids }] of threads) {
    await serializeDelegation(threadKey, async () => {
      let copyAttempted = false;
      let copiedUid = null;
      let account;
      let delegatedFolder = null;
      try {
        account = await loadAccount(target.account_id, userId);
        if (!account) throw new Error('account unavailable');
        const config = await getGtdConfig(target.account_id);
        delegatedFolder = config.enabled ? resolveGtdStateFolder('delegated', config.folders) : null;
        if (!delegatedFolder) throw new Error('delegated folder unavailable');
        await imapManager.ensureFolder(account, delegatedFolder);
        let existing = await liveDelegatedCopies(target, delegatedFolder);
        if (!existing.length) {
          await imapManager.syncFolderOnDemand(account, delegatedFolder);
          existing = await liveDelegatedCopies(target, delegatedFolder);
        }
        if (!existing.length) {
          // The remote COPY can succeed before a later local insert fails, so the attempt
          // must be marked before awaiting it. The catch path then reconciles the folder
          // and removes any copy whose outcome was ambiguous.
          copyAttempted = true;
          copiedUid = await imapManager.copyMessage(
            target.account_id, target.uid, target.folder, delegatedFolder,
          );
          if (copiedUid == null) {
            // Non-UIDPLUS COPY is materialized by destination sync. Await the shared
            // in-flight sync before releasing this thread's serializer, otherwise an
            // immediate retry could issue a second remote COPY.
            await imapManager.syncFolderOnDemand(account, delegatedFolder);
            existing = await liveDelegatedCopies(target, delegatedFolder);
            if (!existing.length) throw new Error('delegated copy did not reconcile');
            // Attribute a destination UID only when reconciliation found exactly one.
            // Multiple copies can mean a concurrent external client also labeled the
            // thread, and compensation must never guess which one belongs to this call.
            if (existing.length === 1) copiedUid = existing[0].uid;
          }
        }
        const delegation = contact
          ? await upsertDelegation({
            userId, accountId: target.account_id, threadKey: target.thread_key, contact,
          })
          : (await clearDelegations({
            userId, accountId: target.account_id, threadKeys: [target.thread_key],
          }), null);
        for (const messageId of ids) outcomes.set(messageId, {
          messageId,
          ok: true,
          accountId: target.account_id,
          threadKey: target.thread_key,
          delegation,
        });
      } catch (error) {
        if (copiedUid == null && error?.copiedUid != null) copiedUid = error.copiedUid;
        const compensated = copyAttempted && delegatedFolder && copiedUid != null
          ? await compensateCopy({ target, folder: delegatedFolder, copiedUid, imapManager })
          : false;
        const code = error instanceof GtdDelegationError ? error.code : 'operation_failed';
        for (const messageId of ids) outcomes.set(messageId, publicFailure(messageId, code, compensated));
      }
    });
  }

  const results = inputIds.map(id => outcomes.get(id));
  const successCount = results.filter(result => result.ok).length;
  const failureCount = results.length - successCount;
  return {
    status: failureCount === 0 ? 'success' : successCount === 0 ? 'failed' : 'partial',
    successCount,
    failureCount,
    results,
  };
}
