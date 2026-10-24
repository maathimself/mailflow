import { shouldShowInboxGtdMetadata } from './indicators.js';

// One pool for list indicators and every open reading surface. Folder visibility only gates rows.
export function collectGtdMetadataMessages(state = {}) {
  if (!state.user?.id) return [];
  const enabled = new Set((state.accounts || []).filter(account => account?.gtd_enabled).map(account => account.id));
  const list = state.searchQuery?.trim() ? state.searchResults || [] : state.messages || [];
  const groups = Object.entries(state.threadMessages || {});
  const loaded = groups.flatMap(([, messages]) => messages);
  const canonical = new Map();
  for (const message of [...list, ...loaded]) {
    if (message?.id && !canonical.has(message.id)) canonical.set(message.id, message);
  }
  const resolve = id => canonical.get(id);
  const selected = resolve(state.selectedMessageId);
  const rows = shouldShowInboxGtdMetadata(state) ? [...list] : [];
  if (selected) {
    rows.push(selected);
    const key = selected.thread_key ?? selected.thread_id;
    for (const [groupKey, messages] of groups) {
      if (messages.some(message => message.id === selected.id || (
        key && message.account_id === selected.account_id
        && (message.thread_key ?? message.thread_id ?? groupKey) === key
      ))) rows.push(...messages);
    }
  }
  for (const window of state.messageWindows || []) {
    const message = resolve(window.messageId);
    if (message) rows.push(message);
  }
  return [...new Map(rows.map(message => resolve(message.id)).filter(message => message?.id && enabled.has(message.account_id))
    .map(message => [message.id, {
      id: message.id, account_id: message.account_id,
      thread_key: message.thread_key ?? message.thread_id, message_id: message.message_id,
    }])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
