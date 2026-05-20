import { query } from '../services/db.js';

// Resolve the trash folder path for an account.
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

export async function resolveArchiveFolder(accountId, folderMappings) {
  if (folderMappings?.archive) return folderMappings.archive;
  const result = await query(
    `SELECT path FROM folders WHERE account_id = $1
     AND (special_use = '\\Archive' OR lower(name) LIKE '%archive%')
     ORDER BY (CASE WHEN special_use = '\\Archive' THEN 0 ELSE 1 END)
     LIMIT 1`,
    [accountId]
  );
  return result.rows[0]?.path || null;
}

// Determine what action to take when deleting a message.
// Returns { action: 'move', destination } | { action: 'expunge' } | { action: 'no_trash' }.
// 'no_trash' must be treated as a safe failure — never permanently delete when
// no Trash folder is configured (user would have no way to recover the message).
export function getDeleteStrategy(messageFolder, trashPath) {
  if (!trashPath) return { action: 'no_trash' };
  if (messageFolder === trashPath) return { action: 'expunge' };
  return { action: 'move', destination: trashPath };
}
