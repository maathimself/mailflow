// Display + search helpers for the move-to-folder pickers, built on the same
// delimiter primitives the sidebar tree uses (sidebar.js imports them from
// here) so the pickers and the folder tree can never disagree about hierarchy.
// Accounts differ in IMAP delimiter ('/', '.', ...), so the display and search
// helpers normalize paths to '/' for humans.

// Preferred IMAP delimiter of a single folder row ('/' fallback).
export function folderDelimiter(folder) {
  return (typeof folder?.delimiter === 'string' && folder.delimiter) || '/';
}

// Parent path of an IMAP folder path, or null for a root-level path.
export function folderParentPath(path, delimiter) {
  const index = path.lastIndexOf(delimiter);
  return index === -1 ? null : path.slice(0, index);
}

// Muted ancestor chain shown before a folder's name ("Personal / Insurance"),
// so same-named folders under different parents stay distinguishable.
// Empty string for root-level folders.
export function folderParentLabel(folder) {
  const path = typeof folder?.path === 'string' ? folder.path : '';
  const delimiter = folderDelimiter(folder);
  const parent = path ? folderParentPath(path, delimiter) : null;
  if (!parent) return '';
  return parent.split(delimiter).join(' / ');
}

// Search matches the folder name or any part of its path, with the path also
// matchable in normalized "parent/child" form regardless of account delimiter.
export function folderMatchesQuery(folder, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const name = String(folder?.name ?? '').toLowerCase();
  if (name.includes(q)) return true;
  const path = String(folder?.path ?? '').toLowerCase();
  if (path.includes(q)) return true;
  return path.split(folderDelimiter(folder).toLowerCase()).join('/').includes(q);
}
