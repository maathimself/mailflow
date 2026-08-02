import { query } from '../db.js';
import { emitGtdIfRelevant } from '../gtdSections.js';
import { adjustFolderCounts } from '../../utils/mailUtils.js';

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

export async function resolveMovedIds(accountId, folder, uids) {
  if (!uids.length) return [];
  const result = await query(
    `SELECT id, uid FROM messages
     WHERE account_id = $1 AND folder = $2 AND uid = ANY($3::bigint[])`,
    [accountId, folder, uids],
  );
  return result.rows;
}

export async function bulkMoveToFolder(imapManager, { userId, accountIds, ids, folder }) {
  const moveGuards = [];
  try {
    const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
    const params = accountIds == null ? [userId, ids] : [userId, ids, accountIds];
    const result = await query(
      `SELECT m.*, a.user_id FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1${accountClause}`,
      params
    );

    const owned = result.rows;
    const movedDetails = [];
    const failedItems = [];
    const skippedAccounts = [];
    if (!owned.length) {
      return { ok: true, moved: [], movedDetails, failed: failedItems, skippedAccounts };
    }

    // Guard every source (account, folder, uid) for the whole bulk move.
    for (const m of owned) {
      moveGuards.push({ accountId: m.account_id, folder: m.folder, uid: m.uid });
      imapManager._guardMoveUid(m.account_id, m.folder, m.uid);
    }

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const movedIds = [];
    const uidUpdates = [];
    const resyncAccounts = [];
    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const folderCheck = await query(
        'SELECT 1 FROM folders WHERE account_id = $1 AND path = $2',
        [accountId, folder]
      );
      if (!folderCheck.rows.length) {
        console.warn(`bulk-move: folder "${folder}" not found for account ${accountId}, skipping`);
        skippedAccounts.push({ account_id: accountId, reason: 'folder_not_found' });
        continue;
      }
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const byFolder = {};
      for (const msg of msgs) {
        (byFolder[msg.folder] = byFolder[msg.folder] || []).push(msg);
      }
      let accountMissingUid = false;
      for (const [srcFolder, folderMsgs] of Object.entries(byFolder)) {
        const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
        const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(account, folderMsgs.map(m => m.uid), srcFolder, folder);
        for (const uid of succeeded) {
          const msg = uidToMsg.get(String(uid));
          movedIds.push(msg.id);
          const newUid = uidMap.get(Number(uid)) || null;
          movedDetails.push({ id: msg.id, accountId, uid: newUid });
          if (newUid) uidUpdates.push({ id: msg.id, newUid });
          else accountMissingUid = true;
        }
        for (const uid of failed) {
          const msg = uidToMsg.get(String(uid));
          if (msg) failedItems.push({ id: msg.id, reason: 'IMAP move failed' });
          console.error(`bulk-move IMAP uid ${uid}: IMAP move failed`);
        }
      }
      if (accountMissingUid) resyncAccounts.push(account);
    }

    if (movedIds.length > 0) {
      const uidUpdateMap = new Map(uidUpdates.map(u => [u.id, u.newUid]));
      const withNewUid = movedIds.filter(id => uidUpdateMap.has(id));
      await query(`
        WITH deleted AS (
          DELETE FROM messages WHERE id = ANY($1::uuid[]) RETURNING *
        ),
        uid_map(src_id, new_uid) AS (
          SELECT * FROM unnest($2::uuid[], $3::bigint[])
        )
        INSERT INTO messages (
          account_id, uid, folder, message_id, subject,
          from_name, from_email, to_addresses, cc_addresses,
          reply_to, in_reply_to, date, snippet, is_read, is_starred,
          has_attachments, flags, body_html, body_text, attachments,
          thread_references, thread_id, is_bulk,
          read_changed_at, star_changed_at, spam_score_sa, spam_score_ml,
          spam_verdict, spam_analyzed_at, spam_details, spam_user_override,
          category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at
        )
        SELECT
          d.account_id, u.new_uid, $4, d.message_id, d.subject,
          d.from_name, d.from_email, d.to_addresses, d.cc_addresses,
          d.reply_to, d.in_reply_to, d.date, d.snippet, d.is_read, d.is_starred,
          d.has_attachments, d.flags, d.body_html, d.body_text, d.attachments,
          d.thread_references, d.thread_id, d.is_bulk,
          d.read_changed_at, d.star_changed_at, d.spam_score_sa, d.spam_score_ml,
          d.spam_verdict, d.spam_analyzed_at, d.spam_details, d.spam_user_override,
          d.category, d.list_unsubscribe, d.list_unsubscribe_post, d.unsubscribed_at
        FROM deleted d
        JOIN uid_map u ON d.id = u.src_id
        ON CONFLICT (account_id, uid, folder) DO NOTHING
      `, [movedIds, withNewUid, withNewUid.map(id => uidUpdateMap.get(id)), folder]);
      for (const acct of resyncAccounts) {
        imapManager.syncFolderOnDemand(acct, folder)
          .catch(err => console.warn('post-move destination sync failed:', err.message));
      }
      const movedSet = new Set(movedIds);
      const srcTotals = {};
      for (const msg of owned) {
        if (!movedSet.has(msg.id)) continue;
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcTotals[key]) srcTotals[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcTotals[key].total++;
        if (!msg.is_read) srcTotals[key].unread++;
      }
      for (const { accountId, path, total, unread } of Object.values(srcTotals)) {
        adjustFolderCounts(accountId, path, -total, -unread);
        adjustFolderCounts(accountId, folder, total, unread);
      }

      for (const accountId of Object.keys(srcTotals).map(k => k.split(':')[0])) {
        imapManager.broadcast({ type: 'folder_updated', folder, accountId }, userId);
      }
    }

    emitGtdSectionsRefresh(imapManager, owned, userId);

    return {
      ok: true,
      moved: movedIds,
      movedDetails,
      failed: failedItems,
      skippedAccounts,
    };
  } catch (err) {
    console.error('bulk-move error:', err);
    return { ok: false, status: 500, error: 'Failed to move messages' };
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
}
