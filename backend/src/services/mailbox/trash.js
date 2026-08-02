import { query } from '../db.js';
import { emitGtdIfRelevant } from '../gtdSections.js';
import {
  adjustFolderCounts,
  resolveAllDraftsPaths,
  resolveAllTrashPaths,
  resolveTrashFolder,
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

export async function bulkTrash(
  imapManager,
  { userId, accountIds, ids, allowPermanent = false },
) {
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

    let owned = result.rows;
    const failedItems = [];
    if (!owned.length) {
      return allowPermanent
        ? { ok: true, deleted: [] }
        : {
            ok: true,
            deleted: [],
            trashedDetails: [],
            failed: failedItems,
            refused: [],
          };
    }

    const refused = [];
    if (!allowPermanent) {
      const permitted = [];
      const byAccountForRefusal = {};
      for (const msg of owned) {
        (byAccountForRefusal[msg.account_id] = byAccountForRefusal[msg.account_id] || []).push(msg);
      }
      for (const [accountId, msgs] of Object.entries(byAccountForRefusal)) {
        const allTrashPaths = await resolveAllTrashPaths(accountId, msgs[0].folder_mappings);
        const allDraftsPaths = await resolveAllDraftsPaths(accountId, msgs[0].folder_mappings);
        for (const msg of msgs) {
          if (allTrashPaths.has(msg.folder)) {
            refused.push({
              id: msg.id,
              folder: msg.folder,
              reason: 'already_in_trash_permanent_delete_required',
            });
          } else if (allDraftsPaths.has(msg.folder)) {
            refused.push({
              id: msg.id,
              folder: msg.folder,
              reason: 'draft_permanent_delete_required',
            });
          } else {
            permitted.push(msg);
          }
        }
      }
      owned = permitted;
      if (!owned.length) {
        return {
          ok: true,
          deleted: [],
          trashedDetails: [],
          failed: failedItems,
          refused,
        };
      }
    }

    // Guard source UIDs for the whole operation so reconcileDeletes can't delete a
    // trash-move source row between the IMAP move and the re-INSERT CTE.
    for (const m of owned) {
      moveGuards.push({ accountId: m.account_id, folder: m.folder, uid: m.uid });
      imapManager._guardMoveUid(m.account_id, m.folder, m.uid);
    }

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const expungeSucceeded = [];
    const trashMoveSucceeded = [];
    const accountsById = {};

    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      accountsById[accountId] = account;
      const trashPath = await resolveTrashFolder(accountId, msgs[0].folder_mappings);
      const allTrashPaths = await resolveAllTrashPaths(accountId, msgs[0].folder_mappings);
      const allDraftsPaths = await resolveAllDraftsPaths(accountId, msgs[0].folder_mappings);

      if (!trashPath) {
        console.error(`bulk-delete: no Trash folder found for account ${accountId} — skipping ${msgs.length} messages`);
        failedItems.push(...msgs.map(msg => ({
          id: msg.id,
          reason: 'Trash folder not found',
        })));
        continue;
      }

      const toExpunge = msgs.filter(m => allTrashPaths.has(m.folder) || allDraftsPaths.has(m.folder));
      const toMove = msgs.filter(m => !allTrashPaths.has(m.folder) && !allDraftsPaths.has(m.folder));

      if (toExpunge.length) {
        const byExpungeFolder = {};
        for (const msg of toExpunge) {
          (byExpungeFolder[msg.folder] = byExpungeFolder[msg.folder] || []).push(msg);
        }
        for (const [expungeFolder, folderMsgs] of Object.entries(byExpungeFolder)) {
          const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
          const { succeeded, failed } = await imapManager.bulkPermanentDelete(account, folderMsgs.map(m => m.uid), expungeFolder);
          for (const uid of succeeded) expungeSucceeded.push(uidToMsg.get(String(uid)));
          for (const uid of failed) console.error(`bulk-delete IMAP expunge uid ${uid} from ${expungeFolder}: IMAP delete failed`);
        }
      }

      if (toMove.length) {
        const byFolder = {};
        for (const msg of toMove) {
          (byFolder[msg.folder] = byFolder[msg.folder] || []).push(msg);
        }
        for (const [srcFolder, folderMsgs] of Object.entries(byFolder)) {
          const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
          const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(account, folderMsgs.map(m => m.uid), srcFolder, trashPath);
          for (const uid of succeeded) {
            trashMoveSucceeded.push({ msg: uidToMsg.get(String(uid)), trashPath, newUid: uidMap.get(Number(uid)) || null });
          }
          for (const uid of failed) {
            const msg = uidToMsg.get(String(uid));
            if (msg) failedItems.push({ id: msg.id, reason: 'IMAP move failed' });
            console.error(`bulk-delete IMAP move uid ${uid}: IMAP move failed`);
          }
        }
      }
    }

    if (expungeSucceeded.length) {
      await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [expungeSucceeded.map(m => m.id)]);
    }

    if (trashMoveSucceeded.length) {
      const byTrashPath = {};
      for (const u of trashMoveSucceeded) {
        (byTrashPath[u.trashPath] = byTrashPath[u.trashPath] || []).push(u);
      }
      for (const [trashPath, entries] of Object.entries(byTrashPath)) {
        const allIds = entries.map(u => u.msg.id);
        const withUid = entries.filter(u => u.newUid);
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
        `, [allIds, withUid.map(u => u.msg.id), withUid.map(u => u.newUid), trashPath]);
      }
      const needResync = new Map();
      for (const u of trashMoveSucceeded) {
        if (u.newUid) continue;
        if (!needResync.has(u.msg.account_id)) needResync.set(u.msg.account_id, new Set());
        needResync.get(u.msg.account_id).add(u.trashPath);
      }
      for (const [acctId, paths] of needResync) {
        const acct = accountsById[acctId];
        if (!acct) continue;
        for (const tp of paths) {
          imapManager.syncFolderOnDemand(acct, tp)
            .catch(err => console.warn('post-trash destination sync failed:', err.message));
        }
      }
    }

    const allSucceeded = [
      ...expungeSucceeded.map(m => m.id),
      ...trashMoveSucceeded.map(u => u.msg.id),
    ];
    if (allSucceeded.length) {
      const srcDeltas = {};
      for (const msg of expungeSucceeded) {
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcDeltas[key]) srcDeltas[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcDeltas[key].total++;
        if (!msg.is_read) srcDeltas[key].unread++;
      }
      for (const { msg } of trashMoveSucceeded) {
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcDeltas[key]) srcDeltas[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcDeltas[key].total++;
        if (!msg.is_read) srcDeltas[key].unread++;
      }
      for (const { accountId, path, total, unread } of Object.values(srcDeltas)) {
        adjustFolderCounts(accountId, path, -total, -unread);
      }
      const dstDeltas = {};
      for (const { msg, trashPath } of trashMoveSucceeded) {
        const key = `${msg.account_id}:${trashPath}`;
        if (!dstDeltas[key]) dstDeltas[key] = { accountId: msg.account_id, path: trashPath, total: 0, unread: 0 };
        dstDeltas[key].total++;
        if (!msg.is_read) dstDeltas[key].unread++;
      }
      for (const { accountId, path, total, unread } of Object.values(dstDeltas)) {
        adjustFolderCounts(accountId, path, total, unread);
      }
      for (const { accountId, path } of Object.values(dstDeltas)) {
        imapManager.broadcast({ type: 'folder_updated', folder: path, accountId }, userId);
      }
    }

    emitGtdSectionsRefresh(imapManager, owned, userId);

    return allowPermanent
      ? { ok: true, deleted: allSucceeded }
      : {
          ok: true,
          deleted: allSucceeded,
          trashedDetails: trashMoveSucceeded.map(({ msg, trashPath, newUid }) => ({
            id: msg.id,
            accountId: msg.account_id,
            folder: trashPath,
            uid: newUid,
          })),
          failed: failedItems,
          refused,
        };
  } catch (err) {
    console.error('bulk-delete error:', err);
    return { ok: false, status: 500, error: 'Failed to delete messages' };
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
}
