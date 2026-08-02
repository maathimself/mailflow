import { query } from '../db.js';
import { emitGtdIfRelevant } from '../gtdSections.js';
import {
  adjustFolderCounts,
  isAllMailFolder,
  resolveArchiveFolder,
} from '../../utils/mailUtils.js';

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

export async function bulkArchive(imapManager, { userId, accountIds, ids }) {
  const moveGuards = [];
  try {
    const accountClause = accountIds == null ? '' : ' AND m.account_id = ANY($3::uuid[])';
    const params = accountIds == null ? [userId, ids] : [userId, ids, accountIds];
    const result = await query(
      `SELECT m.*, a.user_id, a.folder_mappings FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1${accountClause}`,
      params
    );

    const owned = result.rows;
    const failedItems = [];
    if (!owned.length) {
      return {
        ok: true,
        archived: [],
        archivedDetails: [],
        failed: failedItems,
        noArchiveFolder: [],
      };
    }

    for (const m of owned) {
      moveGuards.push({ accountId: m.account_id, folder: m.folder, uid: m.uid });
      imapManager._guardMoveUid(m.account_id, m.folder, m.uid);
    }

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const archivedIds = [];
    const noArchiveFolder = [];
    const accountsById = {};
    const allMailDestFolders = new Set();

    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const archiveFolder = await resolveArchiveFolder(accountId, msgs[0].folder_mappings);
      if (!archiveFolder) {
        noArchiveFolder.push(accountId);
        continue;
      }
      if (await isAllMailFolder(accountId, archiveFolder)) {
        allMailDestFolders.add(archiveFolder);
      }

      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      accountsById[accountId] = account;
      const byFolder = {};
      for (const msg of msgs) {
        (byFolder[msg.folder] = byFolder[msg.folder] || []).push(msg);
      }
      for (const [srcFolder, folderMsgs] of Object.entries(byFolder)) {
        const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
        const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(account, folderMsgs.map(m => m.uid), srcFolder, archiveFolder);
        for (const uid of succeeded) {
          const msg = uidToMsg.get(String(uid));
          archivedIds.push({ id: msg.id, accountId, folder: archiveFolder, newUid: uidMap.get(Number(uid)) || null });
        }
        for (const uid of failed) {
          const msg = uidToMsg.get(String(uid));
          if (msg) failedItems.push({ id: msg.id, reason: 'IMAP move failed' });
          console.error(`bulk-archive IMAP uid ${uid}: IMAP move failed`);
        }
      }
    }

    const byFolder = {};
    for (const { id, folder, newUid } of archivedIds) {
      (byFolder[folder] = byFolder[folder] || []).push({ id, newUid });
    }
    for (const [archiveFolder, entries] of Object.entries(byFolder)) {
      const allIds = entries.map(e => e.id);
      if (allMailDestFolders.has(archiveFolder)) {
        await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [allIds]);
        continue;
      }
      const withUid = entries.filter(e => e.newUid != null);
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
      `, [allIds, withUid.map(e => e.id), withUid.map(e => e.newUid), archiveFolder]);
    }

    const needResync = new Map();
    for (const e of archivedIds) {
      if (e.newUid) continue;
      if (allMailDestFolders.has(e.folder)) continue;
      if (!needResync.has(e.accountId)) needResync.set(e.accountId, new Set());
      needResync.get(e.accountId).add(e.folder);
    }
    for (const [acctId, paths] of needResync) {
      const acct = accountsById[acctId];
      if (!acct) continue;
      for (const fp of paths) {
        imapManager.syncFolderOnDemand(acct, fp)
          .catch(err => console.warn('post-archive destination sync failed:', err.message));
      }
    }

    if (archivedIds.length > 0) {
      const idToArchiveDest = new Map(archivedIds.map(({ id, folder: dest }) => [id, dest]));
      const folderDeltas = {};
      for (const msg of owned) {
        const dest = idToArchiveDest.get(msg.id);
        if (!dest) continue;
        const wasUnread = !msg.is_read ? 1 : 0;
        const srcKey = `${msg.account_id}:${msg.folder}`;
        if (!folderDeltas[srcKey]) folderDeltas[srcKey] = { accountId: msg.account_id, path: msg.folder, totalDelta: 0, unreadDelta: 0 };
        folderDeltas[srcKey].totalDelta--;
        folderDeltas[srcKey].unreadDelta -= wasUnread;
        if (allMailDestFolders.has(dest)) continue;
        const dstKey = `${msg.account_id}:${dest}`;
        if (!folderDeltas[dstKey]) folderDeltas[dstKey] = { accountId: msg.account_id, path: dest, totalDelta: 0, unreadDelta: 0 };
        folderDeltas[dstKey].totalDelta++;
        folderDeltas[dstKey].unreadDelta += wasUnread;
      }
      for (const { accountId, path, totalDelta, unreadDelta } of Object.values(folderDeltas)) {
        adjustFolderCounts(accountId, path, totalDelta, unreadDelta);
      }
      const destFolders = [...new Set(archivedIds.map(a => a.folder))].filter(f => !allMailDestFolders.has(f));
      for (const dest of destFolders) {
        const accountIdsForDest = [...new Set(archivedIds.filter(a => a.folder === dest).map(a => {
          const msg = owned.find(m => m.id === a.id);
          return msg?.account_id;
        }).filter(Boolean))];
        for (const accountId of accountIdsForDest) {
          imapManager.broadcast({ type: 'folder_updated', folder: dest, accountId }, userId);
        }
      }
    }

    emitGtdSectionsRefresh(imapManager, owned, userId);

    return {
      ok: true,
      archived: archivedIds.map(a => a.id),
      archivedDetails: archivedIds.map(a => ({
        id: a.id,
        accountId: a.accountId,
        folder: a.folder,
        uid: a.newUid,
        destinationUntracked: allMailDestFolders.has(a.folder),
      })),
      failed: failedItems,
      noArchiveFolder,
    };
  } catch (err) {
    console.error('bulk-archive error:', err);
    return { ok: false, status: 500, error: 'Failed to archive messages' };
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
}
