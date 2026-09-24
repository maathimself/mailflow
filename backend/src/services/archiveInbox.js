import { query } from './db.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts } from '../utils/mailUtils.js';

// Archive a single INBOX copy of a message: the one guarded per-copy archive move, shared
// by any route that needs "move this INBOX row to the account's Archive and repoint the DB".
// The GTD /done handler owns the surrounding orchestration (mark-read → strip labels →
// archive, plus the partial-success response contract); this primitive owns ONLY the archive
// move itself so that archive semantics — the guard protocol, the Gmail All-Mail branch, the
// race-safe DB repoint, and the count adjustments — live in exactly one place.
//
// Contract, mirroring the move paths in mail.js and imapManager.js:
//   • No Archive folder configured is a SOFT outcome, not a failure: returns
//     { archived: false, noArchiveFolder: true } so the caller can leave the row alone
//     without treating it as an error (in /done the labels are already gone, so the thread
//     has left the rail regardless).
//   • A concurrent /done can move + repoint this same INBOX row between the caller's load
//     and our write. moveMessage is then a silent server-side no-op (the uid no longer lives
//     in INBOX) and returns without throwing. Every DB write is scoped to WHERE folder =
//     'INBOX' and its rowCount is the authority: the loser of that race applies nothing, so
//     we skip the count adjustments and return archived:false rather than double-decrementing
//     INBOX.
//   • Gmail's All Mail is excluded from sync/backfill and the relocate guard, so archiving
//     there just strips the INBOX row from our view: DELETE, not move+repoint, and no
//     destination count (All Mail counts aren't tracked).
//   • IMAP move / DB write failures THROW. The caller maps that to its own failure contract
//     (in /done: HTTP 200 { archived:false, archiveFailed:true } so a mostly-successful action
//     isn't misreported as a 500 and the id stays retryable).
//
// Guard protocol (ref-counted _guardMoveUid/_unguardMoveUid, byte-equivalent to the move
// paths): the source (INBOX, uid) is guarded for the whole move so reconcileDeletes can't
// treat the row as an orphan mid-flight; released in the finally so it is freed even when the
// move or write throws. On a non-UIDPLUS server the new destination uid is unknown, so the DB
// row keeps the stale source uid at the destination — guard (Archive, uid) too, and hold that
// guard for the sync that learns the real uid only when the row was actually moved; a lost
// race (rowCount 0) or a throw releases it immediately, since there is nothing to protect.
export async function archiveInboxCopy(imapManager, account, inboxCopy) {
  const accountId = account.id;
  const archiveFolder = await resolveArchiveFolder(accountId, account.folder_mappings);
  if (!archiveFolder) return { archived: false, noArchiveFolder: true };

  const allMail = await isAllMailFolder(accountId, archiveFolder);
  imapManager._guardMoveUid(accountId, 'INBOX', inboxCopy.uid);
  let destGuardHeld = false;
  try {
    const newUid = await imapManager.moveMessage(account, inboxCopy.uid, 'INBOX', archiveFolder);
    let applied;
    if (allMail) {
      const del = await query("DELETE FROM messages WHERE id = $1 AND folder = 'INBOX'", [inboxCopy.id]);
      applied = del.rowCount > 0;
    } else if (newUid != null) {
      const upd = await query("UPDATE messages SET folder = $1, uid = $2 WHERE id = $3 AND folder = 'INBOX'", [archiveFolder, newUid, inboxCopy.id]);
      applied = upd.rowCount > 0;
    } else {
      imapManager._guardMoveUid(accountId, archiveFolder, inboxCopy.uid);
      destGuardHeld = true;
      const upd = await query("UPDATE messages SET folder = $1 WHERE id = $2 AND folder = 'INBOX'", [archiveFolder, inboxCopy.id]);
      applied = upd.rowCount > 0;
      // Hold the destination guard for the sync that learns the real uid only when we
      // actually moved the row; a lost race releases it immediately (nothing to protect).
      if (applied) setTimeout(() => imapManager._unguardMoveUid(accountId, archiveFolder, inboxCopy.uid), 10_000);
      else imapManager._unguardMoveUid(accountId, archiveFolder, inboxCopy.uid);
      destGuardHeld = false;
    }
    if (applied) {
      // Counts: the caller has already marked the thread read, so both sides move zero unread.
      adjustFolderCounts(accountId, 'INBOX', -1, 0);
      if (!allMail) adjustFolderCounts(accountId, archiveFolder, 1, 0);
    }
    return { archived: applied, noArchiveFolder: false };
  } finally {
    imapManager._unguardMoveUid(accountId, 'INBOX', inboxCopy.uid);
    // Release the destination guard when its DB write throws before normal handoff.
    if (destGuardHeld) imapManager._unguardMoveUid(accountId, archiveFolder, inboxCopy.uid);
  }
}
