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
// `folders`, the account's folder list, keeps a role label to one row (#623):
// a folder mapped to the role takes it from the folder the server flagged, and
// a role folder whose label is another folder's own name ("Deleted Items",
// flagged \Trash beside an unflagged "Trash") keeps its server name.
export function folderDisplayName(folder, t, folderMappings, folders) {
  const role = folderRole(folder, folderMappings);
  if (role && typeof t === 'function') {
    const key = ROLE_LABEL_KEYS[role];
    const label = t(key);
    const others = Array.isArray(folders) ? folders.filter(f => f?.path !== folder.path) : [];
    const mapped = folderMappings?.[role];
    const ownedByMapping = mapped && mapped !== folder.path && others.some(f => f.path === mapped);
    const repeatsAName = others.some(f => (f?.name || '').toLowerCase() === String(label).toLowerCase()
      && folderRole(f, folderMappings) !== role);
    if (label && label !== key && !ownedByMapping && !repeatsAName) return label;
  }
  return folder?.name || folder?.path || '';
}

// The name the sidebar shows for the folder at `path`, for text that names a folder outside the
// tree: the empty and delete confirmations, the "Emptying" notice and the message list header. A
// "Deleted Items" the sidebar labels Trash reads as Trash there too (#623). A path missing from
// the account's folder list (not loaded yet) reads as its last segment, or as its role label.
export function folderDisplayNameForPath(path, t, folderMappings, folders) {
  const list = Array.isArray(folders) ? folders : [];
  const folder = list.find(f => f?.path === path) || {
    path,
    name: String(path ?? '').split(folderDelimiter(list.find(f => f?.delimiter))).pop(),
  };
  return folderDisplayName(folder, t, folderMappings, list);
}

// The recently used move targets for one account, newest first, resolved against the account's
// live folder list (a recent folder since deleted or renamed drops out) and without the folder the
// messages are already in. The single-message pickers and the bulk picker share it (#551).
export function recentMoveTargets(recents, folders, { accountId, currentFolder } = {}) {
  return (recents || [])
    .filter(r => r.accountId === accountId && r.path !== currentFolder)
    .map(r => (folders || []).find(f => f.path === r.path))
    .filter(Boolean);
}

// The favorites a move picker offers for one message: that account's favorited folders, as the
// picker's own folder objects, minus the message's folder and any listed elsewhere in the picker.
// A favorite the user renamed carries that name as favoriteLabel, so the picker shows what the
// sidebar shows (#505).
export function favoriteMoveTargets(favorites, folders, { accountId, currentFolder, exclude = [] } = {}) {
  const skip = new Set((exclude || []).map(f => f.path));
  return (favorites || [])
    .filter(fav => fav.accountId === accountId && fav.path !== currentFolder)
    .map(fav => {
      const folder = (folders || []).find(f => f.path === fav.path);
      return folder && (fav.label ? { ...folder, favoriteLabel: fav.label } : folder);
    })
    .filter(Boolean)
    .filter(f => !skip.has(f.path));
}

// The sections a move picker lists, top to bottom: plugin sections (GTD), then Recent, Favorites
// and All folders. A path a plugin section covers leaves every core section, so it appears once,
// as the plugin's action. While searching, plugin items match on their label and folders follow as
// one flat list, without Recent or Favorites. With no plugin sections this is the picker as it was.
export function buildMovePickerSections({
  folders, recents, favorites, pluginSections = [], accountId, currentFolder, query = '',
} = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const pluginPaths = new Set((pluginSections || []).flatMap(s => (s.items || []).map(i => i.path)));
  const keep = f => f.path !== currentFolder && !pluginPaths.has(f.path);
  const folderRows = list => list.map(folder => ({ kind: 'folder', folder }));
  // An item's folder leaves the folder results, so a search by the folder's own name has to find
  // the item instead; its label alone can differ (a translated state, a renamed folder).
  const itemMatches = item => {
    if (String(item.label ?? '').toLowerCase().includes(q)) return true;
    const folder = (folders || []).find(f => f.path === item.path);
    return folder ? folderMatchesQuery(folder, q) : String(item.path ?? '').toLowerCase().includes(q);
  };

  // Namespaced so a plugin section never shares a React key or a key check with a core section,
  // and suffixed so two plugins choosing the same key stay apart.
  const usedKeys = new Set();
  const uniqueKey = base => {
    let key = base;
    for (let n = 2; usedKeys.has(key); n += 1) key = `${base}-${n}`;
    usedKeys.add(key);
    return key;
  };
  const sections = (pluginSections || []).map(s => ({
    key: uniqueKey(`plugin:${s.key}`),
    heading: s.heading,
    rows: (s.items || [])
      .filter(i => i.path !== currentFolder && (!q || itemMatches(i)))
      .map(item => ({ kind: 'action', item })),
  }));

  if (q) {
    sections.push({
      key: 'all', heading: null,
      rows: folderRows((folders || []).filter(f => keep(f) && folderMatchesQuery(f, q))),
    });
  } else {
    const recent = recentMoveTargets(recents, folders, { accountId, currentFolder });
    const favorite = favoriteMoveTargets(favorites, folders, { accountId, currentFolder, exclude: recent });
    sections.push(
      { key: 'recent', heading: null, rows: folderRows(recent.filter(keep)) },
      { key: 'favorites', heading: null, rows: folderRows(favorite.filter(keep)) },
      { key: 'all', heading: null, rows: folderRows((folders || []).filter(keep)) },
    );
  }
  return sections.filter(s => s.rows.length > 0);
}

// Core sections carry heading: null and are named here; a plugin section's own heading always wins,
// so a plugin keying a section 'recent' cannot pick up a core label.
export function movePickerSectionHeading(section, t) {
  if (section.heading) return section.heading;
  if (section.key === 'recent') return t('contextMenu.folders.recent');
  if (section.key === 'favorites') return t('contextMenu.folders.favorites');
  return null;
}

// Whether a picker shows its "No folders" message below the sections: the folder list is empty or
// failed to load, or nothing matched. Plugin sections render either way, since tagging a message
// needs no folder.
export function movePickerFoldersEmpty(sections, folders) {
  return !Array.isArray(folders) || folders.length === 0 || sections.length === 0;
}

// An action row's click: the picker closes even if the plugin's onSelect throws.
export function runMovePickerAction(item, close) {
  try {
    item.onSelect();
  } finally {
    close();
  }
}
