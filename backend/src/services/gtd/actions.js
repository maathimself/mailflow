import { query } from '../db.js';
import { archiveInboxCopy } from '../archiveInbox.js';
import { getGtdConfig, resolveGtdStateFolder } from '../gtdConfig.js';
import { fanOutReadToSiblings } from '../../utils/mailUtils.js';

export function classifyTarget({ enabled, folders, state }) {
  if (!enabled) return { status: 400, error: 'GTD is not enabled for this account' };
  const folder = resolveGtdStateFolder(state, folders);
  if (!folder) return { status: 400, error: `Unknown GTD state: ${state}` };
  return { folder };
}

export function resolveDoneFolders({ enabled, folders, states, existing }) {
  if (!enabled) return { status: 400, error: 'GTD is not enabled for this account' };
  if (states === 'all') {
    const present = new Set(Array.isArray(existing) ? existing : []);
    const resolved = [];
    for (const folder of Object.values(folders || {})) {
      if (present.has(folder) && !resolved.includes(folder)) resolved.push(folder);
    }
    return { folders: resolved };
  }
  if (!Array.isArray(states) || states.length === 0) {
    return { status: 400, error: 'states must be a non-empty array' };
  }
  const resolved = [];
  for (const state of states) {
    const folder = resolveGtdStateFolder(state, folders);
    if (!folder) return { status: 400, error: `Unknown GTD state: ${state}` };
    if (!resolved.includes(folder)) resolved.push(folder);
  }
  return { folders: resolved };
}

async function loadOwnedMessage(userId, accountIds, messageId) {
  const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
  const params = accountIds == null
    ? [messageId, userId]
    : [messageId, userId, accountIds];
  const result = await query(
    `SELECT m.*
     FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2${accountClause}`,
    params
  );
  return result.rows[0] || null;
}

async function resolveCopyUid(msg, folder) {
  if (msg.folder === folder) return msg.uid;
  const sib = await query(
    'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false LIMIT 1',
    [msg.account_id, folder, msg.message_id]
  );
  return sib.rows[0]?.uid ?? null;
}

export async function gtdClassify(imapManager, { userId, accountIds, messageId, state }) {
  const msg = await loadOwnedMessage(userId, accountIds, messageId);
  if (!msg) return { ok: false, status: 404, error: 'Message not found' };

  const { enabled, folders } = await getGtdConfig(msg.account_id);
  const target = classifyTarget({ enabled, folders, state });
  if (target.error) return { ok: false, status: target.status, error: target.error };
  const toFolder = target.folder;

  if (msg.folder === toFolder) return { ok: true, folder: toFolder };

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  try {
    await imapManager.ensureFolder(account, toFolder);
    await imapManager.copyMessage(msg.account_id, msg.uid, msg.folder, toFolder);
  } catch (err) {
    console.error(`GTD classify failed for message ${messageId} -> ${toFolder}:`, err.message);
    return { ok: false, status: 500, error: 'Failed to apply GTD label' };
  }

  return { ok: true, folder: toFolder };
}

export async function gtdUnclassify(imapManager, { userId, accountIds, messageId, state }) {
  const msg = await loadOwnedMessage(userId, accountIds, messageId);
  if (!msg) return { ok: false, status: 404, error: 'Message not found' };

  const { enabled, folders } = await getGtdConfig(msg.account_id);
  const target = classifyTarget({ enabled, folders, state });
  if (target.error) return { ok: false, status: target.status, error: target.error };
  const stateFolder = target.folder;

  if (msg.folder !== stateFolder && !msg.message_id) {
    return { ok: false, status: 400, error: 'Message has no Message-ID — cannot resolve GTD copy' };
  }
  const siblingUid = await resolveCopyUid(msg, stateFolder);
  if (siblingUid == null) return { ok: true, removed: false };

  try {
    await imapManager.removeMessageCopy(msg.account_id, siblingUid, stateFolder);
  } catch (err) {
    console.error(`GTD unclassify failed for message ${messageId} in ${stateFolder}:`, err.message);
    return { ok: false, status: 500, error: 'Failed to remove GTD label' };
  }

  return { ok: true, removed: true, folder: stateFolder };
}

export async function gtdDone(imapManager, { userId, accountIds, id, states }) {
  const msg = await loadOwnedMessage(userId, accountIds, id);
  if (!msg) return { ok: false, status: 404, error: 'Message not found' };
  if (!msg.message_id) {
    return { ok: false, status: 400, error: 'Message has no Message-ID — cannot mark done' };
  }

  const { enabled, folders } = await getGtdConfig(msg.account_id);
  const allStates = states == null || states === 'all';
  let existing;
  if (allStates && enabled) {
    const copies = await query(
      'SELECT DISTINCT folder FROM messages WHERE account_id = $1 AND message_id = $2 AND is_deleted = false',
      [msg.account_id, msg.message_id]
    );
    existing = copies.rows.map(r => r.folder);
  }
  const target = allStates
    ? resolveDoneFolders({ enabled, folders, states: 'all', existing })
    : resolveDoneFolders({ enabled, folders, states });
  if (target.error) return { ok: false, status: target.status, error: target.error };

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  const inbox = await query(
    'SELECT id, uid, is_read FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false LIMIT 1',
    [msg.account_id, 'INBOX', msg.message_id]
  );
  const inboxCopy = inbox.rows[0] || null;
  try {
    await fanOutReadToSiblings(msg.account_id, msg.message_id, true);
    if (inboxCopy && !inboxCopy.is_read) {
      await imapManager.setFlag(account, inboxCopy.uid, 'INBOX', '\\Seen', true);
    }
  } catch (err) {
    console.warn(`GTD done: mark-read for ${id} degraded:`, err.message);
  }

  const stripOrder = [
    ...target.folders.filter(f => f !== msg.folder),
    ...target.folders.filter(f => f === msg.folder),
  ];
  const removed = [];
  try {
    for (const folder of stripOrder) {
      const uid = await resolveCopyUid(msg, folder);
      if (uid == null) continue;
      await imapManager.removeMessageCopy(msg.account_id, uid, folder);
      removed.push(folder);
    }
  } catch (err) {
    console.error(`GTD done: label strip for ${id} failed:`, err.message);
    return { ok: false, status: 500, error: 'Failed to mark done' };
  }

  let archived = false;
  let noArchiveFolder = false;
  let archiveFailed = false;
  if (inboxCopy) {
    try {
      const result = await archiveInboxCopy(imapManager, account, inboxCopy);
      archived = result.archived;
      noArchiveFolder = result.noArchiveFolder;
    } catch (err) {
      console.error(`GTD done: archive of INBOX copy for ${id} failed:`, err.message);
      archiveFailed = true;
    }
  }

  imapManager.broadcast({ type: 'gtd_sections_updated', accountId: msg.account_id }, account.user_id);

  return { ok: true, removed, archived, noArchiveFolder, archiveFailed };
}
