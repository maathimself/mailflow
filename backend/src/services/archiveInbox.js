import { query } from './db.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts } from '../utils/mailUtils.js';

// Archive one guarded message copy, shared by the GTD /done route and inbox rules.
// The GTD /done handler owns the surrounding orchestration (mark-read → strip labels →
// archive, plus the partial-success response contract); this primitive owns ONLY the archive
// move itself so that archive semantics — the guard protocol, the Gmail All-Mail row, the
// race-safe DB repoint, and the count adjustments — live in exactly one place.
//
// Contract, mirroring the move paths in mail.js and imapManager.js:
//   • No Archive folder configured is a SOFT outcome, not a failure: returns
//     { archived: false, noArchiveFolder: true } so the caller can leave the row alone
//     without treating it as an error (in /done the labels are already gone, so the thread
//     has left the rail regardless).
//   • Every DB write is scoped to the source folder, and rowCount is the authority:
//     a concurrent move that wins the race cannot cause a second count decrement.
//   • Gmail's All Mail is synced and indexed. Its pre-existing copy survives an
//     INBOX-label removal; ordinary IMAP Archive moves create a new destination
//     copy and must repoint the INBOX row even if a copy was already there.
//   • IMAP move / DB write failures THROW. The caller maps that to its own failure contract
//     (in /done: HTTP 200 { archived:false, archiveFailed:true } so a mostly-successful action
//     isn't misreported as a 500 and the id stays retryable).
//
// Guard protocol (ref-counted _guardMoveUid/_unguardMoveUid, byte-equivalent to the move
// paths): the source (folder, uid) is guarded for the whole move so reconcileDeletes can't
// treat the row as an orphan mid-flight; released in the finally so it is freed even when the
// move or write throws. On a non-UIDPLUS server the new destination uid is unknown, so the DB
// row keeps the stale source uid at the destination — guard (Archive, uid) too, and hold that
// guard for the sync that learns the real uid only when the row was actually moved; a lost
// race (rowCount 0) or a throw releases it immediately, since there is nothing to protect.
export async function archiveInboxCopy(imapManager, account, inboxCopy) {
  const { archived, noArchiveFolder } = await archiveMessageCopy(imapManager, account, inboxCopy);
  return { archived, noArchiveFolder };
}

// Callers can supply a resolved archive folder and an IMAP move adapter. Inbox rules
// use bulkMoveMessages; the GTD /done path uses moveMessage. Both share the same DB
// preflight, race handling, guards, and count adjustments.
export async function archiveMessageCopy(imapManager, account, copy, {
  sourceFolder = 'INBOX', archiveFolder: resolvedFolder, archiveIsAllMail: resolvedAllMail,
  unreadDelta = 0, moveUid,
} = {}) {
  const accountId = account.id;
  const archiveFolder = resolvedFolder ?? await resolveArchiveFolder(accountId, account.folder_mappings);
  if (!archiveFolder) return { archived: false, noArchiveFolder: true, newUid: null };
  const archiveIsAllMail = resolvedAllMail ?? await isAllMailFolder(accountId, archiveFolder);

  imapManager._guardMoveUid(accountId, sourceFolder, copy.uid);
  let destGuardHeld = false;
  try {
    const newUid = moveUid
      ? await moveUid(archiveFolder)
      : await imapManager.moveMessage(account, copy.uid, sourceFolder, archiveFolder);
    const existing = archiveIsAllMail ? await query(`
      SELECT id FROM messages WHERE account_id = $1 AND folder = $2 AND id != $3
        AND (($4::bigint IS NOT NULL AND uid = $4)
          OR ($5::text IS NOT NULL AND message_id = $5)) LIMIT 1
    `, [accountId, archiveFolder, copy.id, newUid ?? null, copy.message_id || copy.messageId || null]) : null;
    let applied;
    let addedDestination = false;
    if (existing?.rows.length) {
      const deleted = await query('DELETE FROM messages WHERE id = $1 AND folder = $2', [copy.id, sourceFolder]);
      applied = deleted.rowCount > 0;
    } else {
      try {
        if (newUid != null) {
          const upd = await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3 AND folder = $4',
            [archiveFolder, newUid, copy.id, sourceFolder]);
          applied = upd.rowCount > 0;
        } else {
          imapManager._guardMoveUid(accountId, archiveFolder, copy.uid);
          destGuardHeld = true;
          const upd = await query('UPDATE messages SET folder = $1 WHERE id = $2 AND folder = $3',
            [archiveFolder, copy.id, sourceFolder]);
          applied = upd.rowCount > 0;
          // Hold the guard only for a moved row awaiting a destination UID sync.
          if (applied) setTimeout(() => imapManager._unguardMoveUid(accountId, archiveFolder, copy.uid), 10_000);
          else imapManager._unguardMoveUid(accountId, archiveFolder, copy.uid);
          destGuardHeld = false;
        }
        addedDestination = applied;
      } catch (error) {
        // A concurrent destination sync may insert this copy after the preflight.
        if (!archiveIsAllMail || error.code !== '23505') throw error;
        const deleted = await query('DELETE FROM messages WHERE id = $1 AND folder = $2', [copy.id, sourceFolder]);
        applied = deleted.rowCount > 0;
      }
    }
    if (applied) {
      adjustFolderCounts(accountId, sourceFolder, -1, unreadDelta ? -unreadDelta : 0);
      if (addedDestination) adjustFolderCounts(accountId, archiveFolder, 1, unreadDelta);
    }
    return { archived: applied, noArchiveFolder: false, newUid };
  } finally {
    imapManager._unguardMoveUid(accountId, sourceFolder, copy.uid);
    // Release the destination guard when its DB write throws before normal handoff.
    if (destGuardHeld) imapManager._unguardMoveUid(accountId, archiveFolder, copy.uid);
  }
}
