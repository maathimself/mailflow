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

// Localized labels for the server's special-use folders. IMAP servers name
// these in their own language ("Sent", "Papierkorb", "INBOX"); the role is the
// stable part, so the sidebar and pickers show the UI-language name for the
// role and keep the real path underneath for every IMAP operation. Folders
// without a role (user folders, [Gmail] containers) keep their server name.
//
// The role comes from the SPECIAL-USE flag, or from the account's explicit
// folder mappings when the server does not flag the folder; INBOX has no flag
// on many servers and is recognized by its RFC-fixed name.
const ROLE_LABEL_KEYS = {
  inbox:   'folders.inbox',
  sent:    'folders.sent',
  drafts:  'folders.drafts',
  trash:   'folders.trash',
  spam:    'folders.spam',
  archive: 'folders.archive',
};

const SPECIAL_USE_ROLES = {
  '\\inbox':   'inbox',
  '\\sent':    'sent',
  '\\drafts':  'drafts',
  '\\trash':   'trash',
  '\\junk':    'spam',
  '\\archive': 'archive',
};

export function folderRole(folder, folderMappings) {
  const path = typeof folder?.path === 'string' ? folder.path : '';
  if (!path) return null;
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  const role = SPECIAL_USE_ROLES[String(folder?.special_use ?? '').toLowerCase()];
  if (role) return role;
  if (folderMappings && typeof folderMappings === 'object') {
    for (const key of ['sent', 'drafts', 'trash', 'spam', 'archive']) {
      if (folderMappings[key] === path) return key;
    }
  }
  return null;
}

// Display name of a folder: the translated role label when it has one, else
// its server name (or path). `t` is the i18next translate function.
export function folderDisplayName(folder, t, folderMappings) {
  const role = folderRole(folder, folderMappings);
  if (role && typeof t === 'function') {
    const key = ROLE_LABEL_KEYS[role];
    const label = t(key);
    if (label && label !== key) return label;
  }
  return folder?.name || folder?.path || '';
}
