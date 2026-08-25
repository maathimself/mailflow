import {
  clearGtdRemovalGuard,
  setCompletedGtdRemoval,
  setPendingGtdRemoval,
} from './pendingGtdRemovals.js';

// New servers report the desired Inbox outcome directly. Keep the legacy flags as a fallback so
// a rolling frontend/backend upgrade still surfaces an archive problem instead of hiding it.
export function isGtdArchiveIncomplete(result) {
  if (!result) return false;
  if (typeof result.inboxCleared === 'boolean') {
    return Number(result.archiveTargetCount) > 0 && !result.inboxCleared;
  }
  return !!(result.archiveFailed || result.noArchiveFolder);
}

export function gtdDoneRefreshPatch(state, completedTarget = null) {
  const visibleMessages = [
    ...(state.messages || []),
    ...(state.searchResults || []),
    ...Object.values(state.threadMessages || {}).flat(),
  ];
  const selected = visibleMessages.find(message => message?.id === state.selectedMessageId);
  const selectedTargetStillMatches = completedTarget != null
    && completedTarget.id === state.selectedMessageId
    && selected?.account_id === completedTarget.accountId;
  const recoveredSameMessage = completedTarget?.messageId
    && selected?.id !== completedTarget.id
    && selected?.account_id === completedTarget.accountId
    && selected?.message_id === completedTarget.messageId;
  const survivingThreadMessages = recoveredSameMessage
    ? Object.fromEntries(Object.entries(state.threadMessages || {}).flatMap(([threadId, messages]) => {
      const retained = messages.filter(message => !(
        message?.id === completedTarget.id && message.account_id === completedTarget.accountId
      ));
      return retained.length ? [[threadId, retained]] : [];
    }))
    : {};
  return {
    messagesRefreshToken: state.messagesRefreshToken + 1,
    searchRefreshToken: state.searchRefreshToken + 1,
    threadCacheVersion: (state.threadCacheVersion || 0) + 1,
    ...(selectedTargetStillMatches ? { selectedMessageId: null } : {}),
    threadMessages: survivingThreadMessages,
    expandedThreadId: null,
    loadingThread: null,
  };
}

export async function doneGtdRow(thread, states, {
  gtdDone,
  removeGtdThread,
  addNotification,
  refreshGtdSections,
  refreshMessages,
  refreshUnreadCounts,
  refreshFolders,
  t,
}) {
  const identity = thread.message_id || thread.id;
  setPendingGtdRemoval(identity, states, thread.account_id);
  removeGtdThread(identity, states, thread.account_id);

  try {
    const result = await gtdDone(thread.id, states);
    if (isGtdArchiveIncomplete(result)) {
      clearGtdRemovalGuard(identity, states, thread.account_id);
      addNotification({ title: t('gtd.doneArchiveFailed'), body: thread.subject || t('common.noSubject') });
    } else if (result?.ok === true && result?.phase === 'completed') {
      setCompletedGtdRemoval(identity, states, thread.account_id);
    } else {
      clearGtdRemovalGuard(identity, states, thread.account_id);
      addNotification({ title: t('gtd.doneFailed'), body: thread.subject || t('common.noSubject') });
    }
    return result;
  } catch (err) {
    clearGtdRemovalGuard(identity, states, thread.account_id);
    console.error('GTD done failed:', err.message);
    addNotification({ title: t('gtd.doneFailed'), body: thread.subject || t('common.noSubject') });
    return null;
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => refreshMessages({
        target: { id: thread.id, accountId: thread.account_id, messageId: thread.message_id },
      })),
      Promise.resolve().then(refreshUnreadCounts),
      Promise.resolve().then(() => refreshFolders?.(thread.account_id)),
      Promise.resolve().then(refreshGtdSections),
    ]);
  }
}

// Main-Inbox Done restores its optimistic row only when the backend conclusively says Inbox was
// not cleared. Ambiguous failures rely on the authoritative refresh instead of resurrecting a row
// the provider may already have archived.
export async function doneGtdInboxRow(message, {
  gtdDone,
  refreshMessages,
  refreshUnreadCounts,
  refreshFolders,
  scheduleGtdSectionsFetch,
  refreshGtdSections,
  restoreInbox,
  addNotification,
  t,
}) {
  let result = null;
  try {
    result = await gtdDone(message.id);
    if (isGtdArchiveIncomplete(result)) {
      restoreInbox?.(message);
      addNotification({ title: t('gtd.doneArchiveFailed'), body: message.subject || t('common.noSubject') });
    } else if (!(result?.ok === true && result?.phase === 'completed')) {
      addNotification({ title: t('gtd.doneFailed'), body: message.subject || t('common.noSubject') });
    }
  } catch (err) {
    if (err?.inboxCleared === false) restoreInbox?.(message);
    console.error('GTD done failed:', err.message);
    addNotification({ title: t('gtd.doneFailed'), body: message.subject || t('common.noSubject') });
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(refreshMessages),
      Promise.resolve().then(refreshUnreadCounts),
      Promise.resolve().then(() => refreshFolders?.(message.account_id)),
      Promise.resolve().then(refreshGtdSections || scheduleGtdSectionsFetch),
    ]);
  }
  return result;
}
