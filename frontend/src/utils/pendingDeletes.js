// pendingDeleteMap: messageId -> timeout metadata for deletes hidden optimistically
// but not yet committed to the server because the Undo toast is still active.
export const pendingDeleteMap = new Map();
export const completedDeleteMap = new Map();

function setExpiring(map, messageId, ttlMs) {
  const existing = map.get(messageId);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => map.delete(messageId), ttlMs);
  map.set(messageId, { timer });
}

export function setPendingDelete(messageId) {
  clearCompletedDelete(messageId);
  setExpiring(pendingDeleteMap, messageId, 30000);
}

export function clearPendingDelete(messageId) {
  const existing = pendingDeleteMap.get(messageId);
  if (existing?.timer) clearTimeout(existing.timer);
  pendingDeleteMap.delete(messageId);
}

export function setCompletedDelete(messageId) {
  clearPendingDelete(messageId);
  setExpiring(completedDeleteMap, messageId, 10000);
}

export function clearCompletedDelete(messageId) {
  const existing = completedDeleteMap.get(messageId);
  if (existing?.timer) clearTimeout(existing.timer);
  completedDeleteMap.delete(messageId);
}

export function clearDeleteGuard(messageId) {
  clearPendingDelete(messageId);
  clearCompletedDelete(messageId);
}

export function threadDeleteGuardKey(threadId, folder, accountId = null) {
  if (!threadId || !folder) return null;
  const accountScope = accountId ? `:account:${accountId}` : '';
  return `thread:${threadId}${accountScope}:folder:${folder}`;
}

export function applyDeleteGuard(messages) {
  if (pendingDeleteMap.size === 0 && completedDeleteMap.size === 0) return messages;
  return messages.filter((m) => {
    const guarded = key => key && (pendingDeleteMap.has(key) || completedDeleteMap.has(key));
    const threadKey = m.thread_id ? `thread:${m.thread_id}` : null;
    const folderThreadKey = threadDeleteGuardKey(m.thread_id, m.folder);
    const accountThreadKey = threadDeleteGuardKey(m.thread_id, m.folder, m.account_id);
    return !pendingDeleteMap.has(m.id)
      && !completedDeleteMap.has(m.id)
      && !guarded(threadKey)
      && !guarded(folderThreadKey)
      && !guarded(accountThreadKey);
  });
}
