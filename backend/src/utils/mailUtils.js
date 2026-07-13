import { query } from '../services/db.js';

// Resolve the canonical trash folder path for an account (used as move destination).
// folder_mappings.trash (user-configured) takes priority over special_use and name heuristics.
// Also matches "Deleted Messages" / "Deleted Items" in addition to "Trash"-named folders.
export async function resolveTrashFolder(accountId, folderMappings) {
  if (folderMappings?.trash) return folderMappings.trash;
  const result = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Trash' OR lower(name) LIKE '%trash%' OR lower(name) LIKE '%deleted%')
     ORDER BY (CASE WHEN special_use = '\\Trash' THEN 0 ELSE 1 END)
     LIMIT 1`,
    [accountId]
  );
  return result.rows[0]?.path || null;
}

// Resolve ALL trash-like folder paths for an account (used for expunge-vs-move decisions).
// When a user-configured trash mapping exists, only that folder is considered "trash."
// Otherwise every folder that matches the trash heuristic is included — this handles
// accounts that have both e.g. "Trash" and "Deleted Messages" in their folder list.
export async function resolveAllTrashPaths(accountId, folderMappings) {
  if (folderMappings?.trash) return new Set([folderMappings.trash]);
  const result = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Trash' OR lower(name) LIKE '%trash%' OR lower(name) LIKE '%deleted%')`,
    [accountId]
  );
  return new Set(result.rows.map(r => r.path));
}

export async function resolveAllDraftsPaths(accountId, folderMappings) {
  if (folderMappings?.drafts) return new Set([folderMappings.drafts]);
  const result = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Drafts' OR lower(name) LIKE '%draft%')`,
    [accountId]
  );
  return new Set(result.rows.map(r => r.path));
}

// Resolve the canonical archive folder path for an account.
// folder_mappings.archive (user-configured) takes priority over special_use and the
// name heuristic. Falls back to special_use = '\All' (Gmail's "All Mail") last, since
// stock Gmail over IMAP exposes no '\Archive' folder — archiving there means moving
// the message to All Mail, which strips the INBOX label.
// IMPORTANT: callers that persist the destination back to the messages table must
// special-case an '\All' result — see isAllMailFolder below.
export async function resolveArchiveFolder(accountId, folderMappings) {
  if (folderMappings?.archive) return folderMappings.archive;
  const result = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Archive' OR lower(name) LIKE '%archive%' OR special_use = '\\All')
     ORDER BY (CASE
       WHEN special_use = '\\Archive' THEN 0
       WHEN lower(name) LIKE '%archive%' THEN 1
       ELSE 2
     END)
     LIMIT 1`,
    [accountId]
  );
  return result.rows[0]?.path || null;
}

// True when `path` is this account's Gmail-style "All Mail" folder (special_use = '\All').
// All Mail is excluded from sync/backfill (imapManager.js skipFolderPatterns) and from
// the relocate guard, so no sync loop ever maintains a messages row filed under it.
// Callers that move a message there (see resolveArchiveFolder) must delete the source
// row instead of re-homing it into folder = <All Mail path> — the message should
// simply vanish from our view, matching how the app treats All Mail everywhere else.
export async function isAllMailFolder(accountId, path) {
  if (!path) return false;
  const result = await query(
    `SELECT 1 FROM folders WHERE account_id = $1 AND path = $2 AND special_use = '\\All'`,
    [accountId, path]
  );
  return result.rows.length > 0;
}

// Resolve the canonical spam/junk folder path for an account.
// folder_mappings.spam (user-configured) takes priority over special_use and
// the name heuristic. Matches the multilingual names used by major providers:
//   - Gmail / generic:    Spam, Junk, Junk Mail
//   - Outlook/Microsoft:  Junk Email, Courrier indésirable (fr)
//   - Yahoo:              Bulk Mail
//   - GMX:                Spamverdacht
//   - Italian providers:  Indesiderata, Posta indesiderata
export async function resolveSpamFolder(accountId, folderMappings) {
  if (folderMappings?.spam) return folderMappings.spam;
  const result = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Junk'
          OR lower(name) ~ '(spam|junk|bulk|indesiderata|spamverdacht|courrier ind|posta indesiderata)')
     ORDER BY (CASE WHEN special_use = '\\Junk' THEN 0 ELSE 1 END)
     LIMIT 1`,
    [accountId]
  );
  return result.rows[0]?.path || null;
}

// Resolve ALL spam-like folder paths for an account (used for already-spam checks).
// Same pattern as resolveAllTrashPaths: when user has configured folder_mappings.spam,
// only that path is returned. Otherwise every folder matching the heuristic.
export async function resolveAllSpamPaths(accountId, folderMappings) {
  if (folderMappings?.spam) return new Set([folderMappings.spam]);
  const result = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Junk'
          OR lower(name) ~ '(spam|junk|bulk|indesiderata|spamverdacht|courrier ind|posta indesiderata)')`,
    [accountId]
  );
  return new Set(result.rows.map(r => r.path));
}

// Adjust cached folder row counts after local message mutations so that pagination
// totals stay accurate without waiting for the next IMAP sync. Fire-and-forget —
// errors are logged but never block the caller; sync will correct any discrepancy.
export function adjustFolderCounts(accountId, path, totalDelta, unreadDelta) {
  if (totalDelta === 0 && unreadDelta === 0) return;
  query(
    `UPDATE folders
        SET total_count  = GREATEST(0, total_count  + $1),
            unread_count = GREATEST(0, unread_count + $2)
      WHERE account_id = $3 AND path = $4`,
    [totalDelta, unreadDelta, accountId, path]
  ).catch(err => console.error('Folder count adjust failed:', err.message));
}

// Fan a read-state change out to a message's sibling label rows. Under GTD a single
// message_id owns one row per folder it is filed in (INBOX + Todo + Watch …); the
// caller has already updated the acted row by PK, so this catches the rest. The
// `is_read <> $1` filter both makes the write idempotent and excludes the acted row
// (already at the target state), so only rows that genuinely flip are returned — and
// each returned folder gets its unread count adjusted. Callers gate on the message
// actually having siblings, so a plain single-folder message never reaches here.
export async function fanOutReadToSiblings(accountId, messageId, read) {
  if (!messageId) return; // no shared header → no siblings to fan out to
  const res = await query(
    `UPDATE messages SET is_read = $1, read_changed_at = NOW()
      WHERE account_id = $2 AND message_id = $3 AND is_read <> $1
      RETURNING folder`,
    [read, accountId, messageId]
  );
  for (const row of res.rows) {
    adjustFolderCounts(accountId, row.folder, 0, read ? -1 : 1);
  }
}

// Star fan-out counterpart. Stars never contribute to folder unread counts (the star
// route has never touched adjustFolderCounts), so this only mirrors the flag across
// sibling rows.
export async function fanOutStarToSiblings(accountId, messageId, starred) {
  if (!messageId) return;
  await query(
    `UPDATE messages SET is_starred = $1, star_changed_at = NOW()
      WHERE account_id = $2 AND message_id = $3 AND is_starred <> $1`,
    [starred, accountId, messageId]
  );
}

// Set-based read fan-out for bulk-read. Derives the acted (account_id, message_id)
// pairs from the ids the route just updated, flips every sibling row of those pairs
// that is not itself in the acted set (`m.id <> ALL`) and not already at the target
// state, and adjusts unread counts per returned (account, folder). Ids are bound as a
// single array param so the statement composes with the route's 500-id cap without
// per-id placeholder expansion.
export async function fanOutBulkReadToSiblings(actedIds, read) {
  if (!actedIds.length) return;
  const res = await query(
    `UPDATE messages m SET is_read = $1, read_changed_at = NOW()
       FROM (
         SELECT DISTINCT account_id, message_id
           FROM messages
          WHERE id = ANY($2::uuid[]) AND message_id IS NOT NULL
       ) acted
      WHERE m.account_id = acted.account_id
        AND m.message_id = acted.message_id
        AND m.is_read <> $1
        AND m.id <> ALL($2::uuid[])
      RETURNING m.account_id, m.folder`,
    [read, actedIds]
  );
  const deltas = {};
  for (const row of res.rows) {
    const key = `${row.account_id}:${row.folder}`;
    if (!deltas[key]) deltas[key] = { accountId: row.account_id, folder: row.folder, unread: 0 };
    deltas[key].unread += read ? -1 : 1;
  }
  for (const { accountId, folder, unread } of Object.values(deltas)) {
    adjustFolderCounts(accountId, folder, 0, unread);
  }
}

// Determine what action to take when deleting a message.
// Returns { action: 'move', destination } | { action: 'expunge' } | { action: 'no_trash' }.
// 'no_trash' must be treated as a safe failure — never permanently delete when
// no Trash folder is configured (user would have no way to recover the message).
// allTrashPaths (optional Set) broadens the expunge check to cover accounts that have
// multiple trash-like folders (e.g. both "Trash" and "Deleted Messages").
export function getDeleteStrategy(messageFolder, trashPath, allTrashPaths = null) {
  if (!trashPath) return { action: 'no_trash' };
  const isAlreadyInTrash = allTrashPaths ? allTrashPaths.has(messageFolder) : messageFolder === trashPath;
  if (isAlreadyInTrash) return { action: 'expunge' };
  return { action: 'move', destination: trashPath };
}
