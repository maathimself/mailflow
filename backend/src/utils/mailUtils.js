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
// allTrashPaths (optional Set) broadens the expunge check to cover accounts that have
// multiple trash-like folders (e.g. both "Trash" and "Deleted Messages").
export function getDeleteStrategy(messageFolder, trashPath, allTrashPaths = null) {
  if (!trashPath) return { action: 'no_trash' };
  const isAlreadyInTrash = allTrashPaths ? allTrashPaths.has(messageFolder) : messageFolder === trashPath;
  if (isAlreadyInTrash) return { action: 'expunge' };
  return { action: 'move', destination: trashPath };
}
