export function findVisibleArchiveMessage(messages, selectedMessageId, threadMessages = {}) {
  if (!selectedMessageId || !Array.isArray(messages)) return null;
  const direct = messages.find(message => message?.id === selectedMessageId);
  if (direct) return direct;

  return messages.find((message) => {
    const threadId = message?.thread_id || message?.id;
    const children = threadMessages?.[threadId];
    return Array.isArray(children) && children.some(child => child?.id === selectedMessageId);
  }) || null;
}

export function archiveTargetsForFolder(message, resolvedMessages, folder, isThreadRow, accountId = null) {
  if (!message) return [];
  if (!isThreadRow) return [message];

  const seen = new Set();
  const targets = (Array.isArray(resolvedMessages) ? resolvedMessages : []).filter((candidate) => {
    if (!candidate?.id || candidate.folder !== folder || seen.has(candidate.id)) return false;
    if (accountId && candidate.account_id !== accountId) return false;
    seen.add(candidate.id);
    return true;
  });
  return targets.length > 0 ? targets : [message];
}

export function unreadCountsByAccount(messages) {
  const counts = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.account_id || message.is_read) continue;
    counts.set(message.account_id, (counts.get(message.account_id) || 0) + 1);
  }
  return counts;
}

export function currentThreadLoadVersion(versions, threadId) {
  return versions.get(threadId) || 0;
}

export function invalidateThreadLoad(versions, threadId) {
  const next = currentThreadLoadVersion(versions, threadId) + 1;
  versions.set(threadId, next);
  return next;
}

export function isCurrentThreadLoad(versions, threadId, version) {
  return currentThreadLoadVersion(versions, threadId) === version;
}

export function removeThreadCacheEntry(cache, threadId) {
  const next = { ...(cache || {}) };
  delete next[threadId];
  return next;
}
