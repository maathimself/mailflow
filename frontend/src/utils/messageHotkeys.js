// Resolve the selected row across the ordinary list, search, deep-link stash,
// and GTD rail. GTD copies may not exist in the current mailbox's messages.
export function selectedMessage(state) {
  const id = state?.selectedMessageId ?? topOpenMessageWindow(state)?.messageId;
  if (id == null) return null;
  const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
  return pool?.find(message => message.id === id)
    ?? Object.values(state.threadMessages || {}).flat().find(message => message.id === id)
    ?? Object.values(state.gtdSections || {}).flatMap(section => section?.threads || []).find(message => message.id === id)
    ?? null;
}

export function topOpenMessageWindow(state) {
  return (state?.messageWindows || []).filter(win => !win.minimized)
    .reduce((top, win) => !top || win.z > top.z ? win : top, null);
}

// Explicit unread wins over a delayed automatic read, even if the row is still
// unread at the moment the user presses u. Callers own their timer handles.
export function markMessageUnread(message, { cancel, update, incrementUnread, decrementUnread, adjustCategoryCount, patch }) {
  if (!message) return false;
  cancel?.();
  if (!message.is_read) return true;
  update?.(message.id, { is_read: false });
  incrementUnread?.(message.account_id);
  adjustCategoryCount?.(message.category, 1);
  void Promise.resolve(patch?.([message.id], false)).catch(error => {
    console.error('markUnread failed:', error?.message);
    update?.(message.id, { is_read: true });
    decrementUnread?.(message.account_id);
    adjustCategoryCount?.(message.category, -1);
  });
  return true;
}
