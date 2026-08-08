import { scheduleInboxTriageUndoCommit } from './inboxTriageUndo.js';

export function scheduleUndoableArchive(message, dependencies) {
  const {
    archive,
    invalidate,
    markPending,
    advanceSelection,
    removeMessage,
    restoreMessage,
    decrementUnread,
    incrementUnread,
    clearPending,
    clearGuard,
    completeGuard,
    addNotification,
    notifyNoFolder,
    notifyFailure,
    notification,
    undoMetadata,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
  } = dependencies;

  let pending = true;
  const isUnread = !message.is_read;

  const repairOptimisticState = () => {
    restoreMessage(message);
    if (isUnread) incrementUnread(message.account_id);
  };

  invalidate();
  markPending(message.id);
  advanceSelection(message.id);
  removeMessage(message.id);
  if (isUnread) decrementUnread(message.account_id);

  const { timer, undoMetadata: deadlineMetadata } = scheduleInboxTriageUndoCommit(async () => {
    if (!pending) return;
    pending = false;

    try {
      const result = await archive(message.id);
      if (result?.archived?.includes(message.id)) {
        completeGuard(message.id);
        return;
      }

      clearGuard(message.id);
      repairOptimisticState();
      if (result?.noArchiveFolder?.length) notifyNoFolder();
      else notifyFailure();
    } catch {
      clearGuard(message.id);
      repairOptimisticState();
      notifyFailure();
    }
  }, undoMetadata, { now, setTimer });

  addNotification({
    ...notification,
    ...deadlineMetadata,
    onUndo: () => {
      if (!pending) return;
      pending = false;
      clearTimer(timer);
      clearPending(message.id);
      repairOptimisticState();
    },
  });
}
