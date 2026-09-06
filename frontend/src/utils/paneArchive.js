import { createUndoableCommit, UNDO_COMMIT_DELAY_MS } from './undoableAction.js';
import { clearDeleteGuard, setCompletedDelete, setPendingDelete } from './pendingDeletes.js';

// Archive one message from the reading pane with an Undo window. The delete guard keeps a
// list refresh that lands while the toast is showing from resurfacing the still-unarchived
// server copy; it flips to "completed" once the server confirms, and clears on undo/failure.
export function startPaneArchive({
  message,
  archive,
  removeMessage,
  restoreMessages,
  decrementUnread,
  incrementUnread,
  onNoArchiveFolder,
  onError,
  delayMs = UNDO_COMMIT_DELAY_MS,
  schedule,
  cancel,
}) {
  const { id, account_id: accountId, is_read: isRead } = message;

  setPendingDelete(id);
  removeMessage(id);
  if (!isRead) decrementUnread(accountId);

  const restore = () => {
    clearDeleteGuard(id);
    restoreMessages([message]);
    if (!isRead) incrementUnread(accountId);
  };

  return createUndoableCommit({
    delayMs,
    ...(schedule ? { schedule } : {}),
    ...(cancel ? { cancel } : {}),
    commit: async () => {
      let result;
      try {
        result = await archive([id]);
      } catch (err) {
        restore();
        onError?.(err);
        return;
      }
      const archived = new Set(result?.archived || []);
      if (archived.has(id)) {
        setCompletedDelete(id);
        return;
      }
      restore();
      if (result?.noArchiveFolder?.length) onNoArchiveFolder?.();
      else onError?.(result?.error);
    },
    undo: restore,
  });
}
