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

export function archiveViewKey({
  selectedAccountId,
  selectedFolder,
  searchQuery,
  threadedView,
  unreadOnly,
  activeCategory,
  currentPage,
  searchAllFolders,
  activeGtdTab,
  pageSize,
  scrollMode,
  categorizationEnabled,
  accountCategorizationEnabled,
  unifiedInboxAccountKey,
  showGtdTab,
}) {
  return JSON.stringify([
    selectedAccountId ?? null,
    selectedFolder ?? null,
    String(searchQuery || '').trim(),
    Boolean(threadedView),
    Boolean(unreadOnly),
    activeCategory ?? null,
    Number(currentPage) || 1,
    Boolean(searchAllFolders),
    activeGtdTab ?? null,
    Number(pageSize) || null,
    scrollMode ?? null,
    Boolean(categorizationEnabled),
    Boolean(accountCategorizationEnabled),
    unifiedInboxAccountKey ?? null,
    Boolean(showGtdTab),
  ]);
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
  const visibleRowMatchesScope = message.id
    && message.folder === folder
    && (!accountId || message.account_id === accountId);
  if (visibleRowMatchesScope && !seen.has(message.id)) targets.push(message);
  return targets.length > 0 ? targets : [message];
}

export async function archiveTargetGroupsForRows(
  messages,
  resolveMessages,
  folder,
  isThreadRow,
  accountId = null,
  concurrency = 8,
) {
  const rows = Array.isArray(messages) ? messages : [];
  const groups = [];
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const batch = await Promise.all(rows.slice(offset, offset + concurrency).map(async (row) => {
      const resolved = await resolveMessages(row);
      return {
        row,
        targets: archiveTargetsForFolder(row, resolved, folder, isThreadRow(row), accountId),
      };
    }));
    groups.push(...batch);
  }
  return groups;
}

export async function archiveInChunks(ids, archive, chunkSize = 500) {
  const archived = [];
  const noArchiveFolder = [];
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    try {
      const result = await archive(ids.slice(offset, offset + chunkSize));
      archived.push(...(result?.archived || []));
      noArchiveFolder.push(...(result?.noArchiveFolder || []));
    } catch (error) {
      return { archived, noArchiveFolder, unconfirmed: ids.slice(offset), error };
    }
  }
  return { archived, noArchiveFolder, unconfirmed: [], error: null };
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
