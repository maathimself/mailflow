export function clampRightSidebarWidth(value, { min = 200, max = 600, fallback = 296 } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

// A message's identity, scoped to its account. One RFC message_id can appear in
// several accounts, so the account must be part of the key or an optimistic update
// in one account would reach into another.
export function accountScopedMessageIdentity(message) {
  const localIdentity = message?.message_id || message?.id;
  if (localIdentity == null) return null;
  return message?.account_id ? `${message.account_id}\0${localIdentity}` : localIdentity;
}

// The sidebar only exists once a label is configured, so an account with none
// contributes nothing. In unified view (no account selected) any configured
// account is enough to show it.
export function rightSidebarActiveForContext(accounts, selectedAccountId) {
  if (!Array.isArray(accounts)) return false;
  const configured = account => account?.enabled === true
    && Array.isArray(account.right_sidebar_labels)
    && account.right_sidebar_labels.length > 0;
  if (selectedAccountId == null) return accounts.some(configured);
  return configured(accounts.find(account => account.id === selectedAccountId));
}

// Optimistically drop a thread's head from the given sections so the row disappears
// instantly; the debounced refetch reconciles the authoritative counts.
export function removeRightSidebarThreadFromSections(sections, identity, paths) {
  if (!Array.isArray(sections) || identity == null) return sections;
  const identityKey = typeof identity === 'object' ? accountScopedMessageIdentity(identity) : identity;
  const targetPaths = new Set((Array.isArray(paths) ? paths : [paths]).filter(Boolean));
  if (targetPaths.size === 0) return sections;

  let changed = false;
  const next = sections.map(section => {
    if (!targetPaths.has(section.path) || !Array.isArray(section.threads)) return section;
    const removed = section.threads.filter(row => accountScopedMessageIdentity(row) === identityKey);
    if (removed.length === 0) return section;
    changed = true;
    const unreadRemoved = removed.filter(row => !row.is_read).length;
    return {
      ...section,
      total: Math.max(0, (Number(section.total) || 0) - removed.length),
      unread: Math.max(0, (Number(section.unread) || 0) - unreadRemoved),
      threads: section.threads.filter(row => accountScopedMessageIdentity(row) !== identityKey),
    };
  });
  return changed ? next : sections;
}

// Which message rows a sidebar read-toggle should act on. Section rows carry
// thread-level unread, so marking read must reach every message in the thread;
// marking unread only needs the visible head.
export async function collectThreadReadIds(thread, read, getThread) {
  if (!read || !getThread || !thread?.thread_key) return [thread.id];
  try {
    const { messages } = await getThread(thread.thread_key, undefined, thread.account_id);
    const ids = (Array.isArray(messages) ? messages : []).map(message => message?.id).filter(Boolean);
    return ids.length ? ids : [thread.id];
  } catch {
    return [thread.id];
  }
}

// Match a row to the current selection across distinct folder copies that share
// one RFC message_id, with exact row id as the fallback.
export function isSelectedRow(row, selectedId, selectedMid, selectedAccountId = null) {
  if (!row) return false;
  if (
    selectedMid != null
    && row.message_id != null
    && row.message_id === selectedMid
    && (selectedAccountId == null || row.account_id === selectedAccountId)
  ) return true;
  return row.id != null && row.id === selectedId;
}

// Prefer the exact message the row pointed at; fall back to the thread's newest.
function pickThreadMessage(messages, messageId) {
  const list = Array.isArray(messages) ? messages.filter(message => message?.id) : [];
  if (list.length === 0) return null;
  const byMid = messageId && list.find(message => message.message_id === messageId);
  if (byMid) return byMid;
  return list.reduce((newest, message) =>
    (new Date(message.date || 0) >= new Date(newest.date || 0) ? message : newest), list[0]);
}

let _deepLinkSeq = 0;

// Open an out-of-list section head without changing folders. A stale row id is
// recovered through its stable thread/message identity and triggers a refetch.
export async function openDeepLinkMessage(id, {
  getMessage, setThreadMessages, setSelectedMessage,
  thread, getThread, onMiss,
} = {}) {
  const seq = ++_deepLinkSeq;
  const open = (message) => {
    if (seq !== _deepLinkSeq) return null;
    setThreadMessages(`__dl_${message.id}`, [message]);
    setSelectedMessage(message.id);
    return message;
  };

  if (id) {
    try {
      const message = await getMessage(id);
      if (message) return open(message);
    } catch {
      // Fall through to recovery when the section snapshot has a stale id.
    }
  }

  console.warn(`Sidebar deep-link miss (id=${id ?? 'null'}, thread_key=${thread?.thread_key ?? 'null'}); refetching sections`);
  onMiss?.();

  if (getThread && thread?.thread_key) {
    try {
      const { messages } = await getThread(thread.thread_key, undefined, thread.account_id);
      const message = pickThreadMessage(messages, thread.message_id);
      if (message) return open(message);
    } catch {
      // Best-effort; the refetch refreshes the ids for the next click.
    }
  }
  return null;
}

export function addSidebarLabel(labels, path) {
  return labels.includes(path) ? [...labels] : [...labels, path];
}

export function removeSidebarLabel(labels, path) {
  return labels.filter(label => label !== path);
}

// The server sanitizes on write, so trust its echo over what we submitted.
export function resolveSavedSidebarLabels(result, submittedLabels) {
  const labels = Array.isArray(result?.right_sidebar_labels)
    ? result.right_sidebar_labels
    : submittedLabels;
  return Array.isArray(labels) ? [...labels] : [];
}

// System folders already have first-class homes in the left sidebar; offering them
// here would just duplicate them. Mirrors the backend's reserved-path rejection.
const SYSTEM_FOLDER_NAMES = [
  /^inbox$/,
  /^sent(?: items| mail)?$/,
  /^drafts?$/,
  /^(?:trash|bin)$/,
  /^(?:spam|junk)$/,
  /^all mail$/,
  /^archive$/,
];

function isSelectableSidebarFolder(folder) {
  if (!folder?.path || folder.special_use) return false;
  const values = [folder.path, folder.name]
    .filter(Boolean)
    .flatMap(value => String(value).toLowerCase().split(/[\\/]/));
  return !values.some(value => SYSTEM_FOLDER_NAMES.some(pattern => pattern.test(value.trim())));
}

// Split the folder list into what's already picked (in saved order, flagged when the
// folder has since vanished from the server) and what's still available to add.
export function buildSidebarFolderChoices(folders, savedPaths) {
  const selectable = (Array.isArray(folders) ? folders : [])
    .filter(isSelectableSidebarFolder);
  const byPath = new Map(selectable.map(folder => [folder.path, folder]));
  const saved = Array.isArray(savedPaths) ? savedPaths : [];
  const selectedPaths = new Set(saved);

  return {
    selected: saved.map(path => {
      const folder = byPath.get(path);
      return {
        path,
        name: folder?.name || path,
        available: !!folder,
      };
    }),
    available: selectable
      .filter(folder => !selectedPaths.has(folder.path))
      .map(folder => ({ path: folder.path, name: folder.name || folder.path, available: true })),
  };
}
