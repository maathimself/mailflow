export const UNDO_WINDOW_MS = 4500;
export const UNDO_COMMIT_DELAY_MS = UNDO_WINDOW_MS + 250;

export function createUndoableCommit({
  delayMs = UNDO_WINDOW_MS,
  commit,
  undo,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let state = 'pending';
  const timer = schedule(async () => {
    if (state !== 'pending') return;
    state = 'committing';
    try {
      await commit();
    } finally {
      state = 'committed';
    }
  }, delayMs);

  return {
    undo() {
      if (state !== 'pending') return false;
      state = 'undone';
      cancel(timer);
      undo();
      return true;
    },
  };
}
