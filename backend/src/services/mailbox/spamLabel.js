import { query } from '../db.js';
import { emitGtdIfRelevant } from '../gtdSections.js';
import {
  adjustFolderCounts,
  resolveAllSpamPaths,
  resolveSpamFolder,
} from '../../utils/mailUtils.js';

function scopedParams(id, userId, accountIds) {
  return accountIds == null
    ? { clause: '', params: [id, userId] }
    : { clause: ' AND m.account_id = ANY($3::uuid[])', params: [id, userId, accountIds] };
}

function emitGtdSectionsRefresh(imapManager, rows, userId) {
  const byAccount = new Map();
  for (const m of rows) {
    if (!m.message_id) continue;
    if (!byAccount.has(m.account_id)) byAccount.set(m.account_id, { mids: new Set(), folders: new Set() });
    const entry = byAccount.get(m.account_id);
    entry.mids.add(m.message_id);
    if (m.folder) entry.folders.add(m.folder);
  }
  for (const [accountId, { mids, folders }] of byAccount) {
    emitGtdIfRelevant(imapManager, accountId, userId, [...mids], [...folders])
      .catch(err => console.warn('GTD sections refresh emit failed:', err.message));
  }
}

// Move a single message to a destination folder, update DB, log to
// training_log, and broadcast folder_updated. Shared between spam and ham.
export async function moveForSpamLabel(
  imapManager,
  { userId, accountIds, messageId, destinationFolder, label },
) {
  const scope = scopedParams(messageId, userId, accountIds);
  const result = await query(`
    SELECT m.*, a.user_id, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2${scope.clause}
  `, scope.params);

  if (!result.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const message = result.rows[0];

  // No-op: message already in the destination folder.
  if (message.folder === destinationFolder) {
    // Still record the training label so the user's intent is captured
    // (e.g. re-confirming a verdict), but skip the IMAP move.
    await query(
      `INSERT INTO spam_training_log
         (user_id, account_id, message_id_header, message_uid, folder, label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, message.account_id, message.message_id, message.uid, message.folder, label]
    );
    await query(
      `UPDATE messages SET spam_user_override = $1, spam_verdict = $1, spam_analyzed_at = NOW() WHERE id = $2`,
      [label, messageId]
    );
    return { ok: true, status: 200, body: { ok: true, alreadyInFolder: true, folder: destinationFolder } };
  }

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];

  // Guard the source UID before the IMAP move so reconcileDeletes cannot
  // delete the DB row if an EXPUNGE arrives while the move is in flight.
  imapManager._guardMoveUid(account.id, message.folder, message.uid);
  let newUid;
  try {
    try {
      newUid = await imapManager.moveMessage(account, message.uid, message.folder, destinationFolder);
    } catch (err) {
      console.error(`IMAP move for /${label} failed:`, err.message);
      return { ok: false, status: 502, error: `IMAP move failed: ${err.message}` };
    }
    if (newUid != null) {
      await query('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4',
        [account.id, newUid, destinationFolder, messageId]);
      await query(
        `UPDATE messages SET folder = $1, uid = $2,
            spam_user_override = $3, spam_verdict = $3, spam_analyzed_at = NOW()
         WHERE id = $4`,
        [destinationFolder, newUid, label, messageId]
      );
    } else {
      // Non-UIDPLUS server: DB holds the stale source UID at the destination.
      imapManager._guardMoveUid(account.id, destinationFolder, message.uid);
      await query(
        `UPDATE messages SET folder = $1,
            spam_user_override = $2, spam_verdict = $2, spam_analyzed_at = NOW()
         WHERE id = $3`,
        [destinationFolder, label, messageId]
      );
      setTimeout(() => imapManager._unguardMoveUid(account.id, destinationFolder, message.uid), 10_000);
    }
  } finally {
    imapManager._unguardMoveUid(account.id, message.folder, message.uid);
  }

  // Adjust cached folder counts.
  const wasUnread = !message.is_read ? 1 : 0;
  adjustFolderCounts(account.id, message.folder, -1, -wasUnread);
  adjustFolderCounts(account.id, destinationFolder, 1, wasUnread);

  // Training log: capture the decision for future model training.
  await query(
    `INSERT INTO spam_training_log
       (user_id, account_id, message_id_header, message_uid, folder, label, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
    [userId, account.id, message.message_id, message.uid, destinationFolder, label]
  );

  // If folder_mappings.spam is not yet configured, learn from the discovered folder.
  if (label === 'spam' && !account.folder_mappings?.spam) {
    await query(
      `UPDATE email_accounts SET folder_mappings = folder_mappings || jsonb_build_object('spam', $1::text)
       WHERE id = $2 AND NOT (folder_mappings ? 'spam')`,
      [destinationFolder, account.id]
    ).catch(err => console.warn('Failed to auto-persist folder_mappings.spam:', err.message));
  }

  imapManager.broadcast(
    { type: 'folder_updated', folder: destinationFolder, accountId: account.id },
    userId
  );

  // Refresh GTD section data if the (un)spammed message's thread carries a GTD label.
  emitGtdSectionsRefresh(imapManager, [message], userId);

  return { ok: true, status: 200, body: { ok: true, folder: destinationFolder, newUid: newUid || null } };
}

export async function markSpam(imapManager, { userId, accountIds, id }) {
  const scope = scopedParams(id, userId, accountIds);
  const lookup = await query(`
    SELECT m.account_id, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2${scope.clause}
  `, scope.params);

  if (!lookup.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const spamFolder = await resolveSpamFolder(lookup.rows[0].account_id, lookup.rows[0].folder_mappings);
  if (!spamFolder) return { ok: false, status: 422, error: 'No spam folder configured for this account' };

  return moveForSpamLabel(imapManager, {
    userId,
    accountIds,
    messageId: id,
    destinationFolder: spamFolder,
    label: 'spam',
  });
}

export async function markNotSpam(imapManager, { userId, accountIds, id }) {
  const scope = scopedParams(id, userId, accountIds);
  const lookup = await query(`
    SELECT m.account_id, m.folder, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2${scope.clause}
  `, scope.params);

  if (!lookup.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const allSpam = await resolveAllSpamPaths(lookup.rows[0].account_id, lookup.rows[0].folder_mappings);
  if (!allSpam.has(lookup.rows[0].folder)) {
    return { ok: false, status: 400, error: 'Message is not in the spam folder' };
  }

  const inboxFolder = lookup.rows[0].folder_mappings?.inbox || 'INBOX';
  return moveForSpamLabel(imapManager, {
    userId,
    accountIds,
    messageId: id,
    destinationFolder: inboxFolder,
    label: 'ham',
  });
}
