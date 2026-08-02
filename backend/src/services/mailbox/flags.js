import { query } from '../db.js';
import { emitGtdIfRelevant } from '../gtdSections.js';
import {
  adjustFolderCounts,
  fanOutBulkReadToSiblings,
  fanOutReadToSiblings,
  fanOutStarToSiblings,
} from '../../utils/mailUtils.js';
import { runInBatches } from './batch.js';

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

export async function setRead(imapManager, { userId, accountIds, id, read }) {
  const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
  const params = accountIds == null ? [id, userId] : [id, userId, accountIds];
  const result = await query(`
    SELECT m.*, a.user_id,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2${accountClause}
  `, params);

  if (!result.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const message = result.rows[0];

  // Run DB update and account fetch concurrently — no dependency between them.
  // read_changed_at tells the IMAP sync not to overwrite this change for 30 s,
  // preventing a race where a concurrent sync fetch sees the old IMAP flag.
  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = $2', [read, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  // Keep the cached folder unread_count in sync so pagination totals stay accurate.
  if (!!message.is_read !== !!read) {
    adjustFolderCounts(message.account_id, message.folder, 0, read ? -1 : 1);
    // Notify the user's OTHER sessions so a read/unread on one device reflects on the rest
    // in place, without a full folder refetch (the originating device already applied it).
    imapManager.broadcast({ type: 'message_flags', accountId: message.account_id, changes: [{ id, is_read: read }] }, userId);
  }

  if (accountResult.rows[0]?.gtd_enabled && Number(message.sibling_count) > 1) {
    await fanOutReadToSiblings(message.account_id, message.message_id, read);
  }

  try {
    await imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Seen', read);
    imapManager._resolveFlagPush(message.account_id, id, '\\Seen');
  } catch (err) {
    console.error('IMAP flag update failed:', err.message);
    imapManager._enqueueFlagPush(message.account_id, id, '\\Seen', read);
  }

  emitGtdSectionsRefresh(imapManager, [message], userId);

  return { ok: true, is_read: read };
}

export async function setStarred(imapManager, { userId, accountIds, id, starred }) {
  const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
  const params = accountIds == null ? [id, userId] : [id, userId, accountIds];
  const result = await query(`
    SELECT m.*, a.user_id,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2${accountClause}
  `, params);

  if (!result.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const message = result.rows[0];
  const updated = !!message.is_starred !== !!starred;

  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = $2', [starred, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  if (accountResult.rows[0]?.gtd_enabled && Number(message.sibling_count) > 1) {
    await fanOutStarToSiblings(message.account_id, message.message_id, starred);
  }

  try {
    await imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Flagged', starred);
    imapManager._resolveFlagPush(message.account_id, id, '\\Flagged');
  } catch (err) {
    console.error('IMAP star update failed:', err.message);
    imapManager._enqueueFlagPush(message.account_id, id, '\\Flagged', starred);
  }

  emitGtdSectionsRefresh(imapManager, [message], userId);
  if (updated) {
    imapManager.broadcast({ type: 'message_flags', accountId: message.account_id, changes: [{ id, is_starred: starred }] }, userId);
  }

  return { ok: true, is_starred: starred, updated };
}

export async function bulkSetRead(imapManager, { userId, accountIds, ids, read }) {
  try {
    const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
    const params = accountIds == null ? [userId, ids] : [userId, ids, accountIds];
    const result = await query(
      `SELECT m.id, m.uid, m.folder, m.is_read, m.account_id, m.message_id, a.gtd_enabled FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1${accountClause}`,
      params
    );

    const owned = result.rows;
    if (!owned.length) return { ok: true, updated: [] };

    const toUpdate = owned.filter(m => !!m.is_read !== !!read);
    if (!toUpdate.length) return { ok: true, updated: [] };

    await query(
      'UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = ANY($2::uuid[])',
      [read, toUpdate.map(m => m.id)]
    );

    const folderDeltas = {};
    for (const msg of toUpdate) {
      const key = `${msg.account_id}:${msg.folder}`;
      if (!folderDeltas[key]) folderDeltas[key] = { accountId: msg.account_id, folder: msg.folder, delta: 0 };
      folderDeltas[key].delta += read ? -1 : 1;
    }
    for (const { accountId, folder, delta } of Object.values(folderDeltas)) {
      adjustFolderCounts(accountId, folder, 0, delta);
    }

    const gtdUpdatedIds = toUpdate.filter(m => m.gtd_enabled).map(m => m.id);
    if (gtdUpdatedIds.length) await fanOutBulkReadToSiblings(gtdUpdatedIds, read);
    imapManager.broadcast({ type: 'message_flags', changes: toUpdate.map(m => ({ id: m.id, is_read: read })) }, userId);

    const byAccount = {};
    for (const msg of toUpdate) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }
    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const results = await runInBatches(
        msgs, 3,
        msg => imapManager.setFlag(account, msg.uid, msg.folder, '\\Seen', read)
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`bulk-read IMAP ${msgs[i].id}:`, r.reason.message);
          imapManager._enqueueFlagPush(accountId, msgs[i].id, '\\Seen', read);
        } else {
          imapManager._resolveFlagPush(accountId, msgs[i].id, '\\Seen');
        }
      });
    }

    emitGtdSectionsRefresh(imapManager, toUpdate, userId);

    return { ok: true, updated: toUpdate.map(m => m.id) };
  } catch (err) {
    console.error('bulk-read error:', err);
    return { ok: false, status: 500, error: 'Failed to update messages' };
  }
}
