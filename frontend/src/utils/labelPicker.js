import { GTD_STATES, resolveAccountGtdFolders } from './gtd.js';
import { CSRF_HEADER, CSRF_VALUE } from './api.js';

export function selectedPickerMessage(state) {
  const id = state.selectedMessageId;
  if (!id) return null;
  const rows = [
    ...(state.messages || []), ...(state.searchResults || []),
    ...Object.values(state.threadMessages || {}).flat(),
    ...Object.values(state.gtdSections || {}).flatMap(section => section?.threads || []),
  ];
  const row = rows.find(message => message.id === id);
  if (!row?.account_id) return null;
  return { id: row.id, account_id: row.account_id, folder: row.folder,
    thread_id: row.thread_id, message_count: row.message_count };
}

const SYSTEM_NAMES = new Set(['inbox', 'sent', 'drafts', 'trash', 'spam', 'junk', 'archive', 'all mail', 'starred', 'important']);
const SYSTEM_USES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all', 'flagged']);

export function labelPickerOptions(folders, account, enabledPlugins = [], sourceFolder) {
  if (!account?.enabled) return [];
  const gtdActive = account.gtd_enabled && enabledPlugins.includes('gtd');
  const gtdPaths = resolveAccountGtdFolders(account);
  const stateByPath = new Map(GTD_STATES.map(state => [gtdPaths[state], state]));
  const mappedSystemPaths = new Set(Object.values(account.folder_mappings || {}).filter(Boolean));
  return (folders || []).flatMap(folder => {
    const path = folder.path;
    if (!path || folder.no_select || path === sourceFolder) return [];
    const state = stateByPath.get(path);
    if (state) return gtdActive ? [{ path, label: folder.name || path, state }] : [];
    const use = String(folder.special_use || '').replaceAll('\\', '').toLowerCase();
    if (SYSTEM_USES.has(use) || SYSTEM_NAMES.has(String(folder.name || '').toLowerCase()) || mappedSystemPaths.has(path)) return [];
    return [{ path, label: folder.name || path }];
  });
}

export function pickerNavigationDirection(event) {
  if (event.key === 'ArrowDown' && !event.ctrlKey && !event.metaKey && !event.altKey) return 1;
  if (event.key === 'ArrowUp' && !event.ctrlKey && !event.metaKey && !event.altKey) return -1;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return 0;
  const key = event.key.toLowerCase();
  if (key === 'n' || key === 'j') return 1;
  if (key === 'p' || key === 'k') return -1;
  return 0;
}

export async function executeLabelChoice(message, choice, api) {
  if (!message || !choice) return;
  if (choice.state) return api.gtdClassify(message.id, choice.state);
  if (!message.thread_id || Number(message.message_count) <= 1 || !api.getThread) {
    return api.copyMessage(message.id, choice.path);
  }
  const { messages = [] } = await api.getThread(message.thread_id, message.folder, false);
  const seen = new Set();
  const targets = messages.filter(row => {
    if (row.account_id !== message.account_id || row.folder === choice.path) return false;
    const key = row.message_id || row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!targets.length) targets.push(message);
  for (const row of targets) await api.copyMessage(row.id, choice.path);
}

export async function copyMessageToFolder(id, folder) {
  const response = await fetch(`/api/mail/messages/${encodeURIComponent(id)}/copy`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
    body: JSON.stringify({ folder }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not copy message');
  return body;
}
