export const UNDO_WINDOW_MS = 4500;
export const UNDO_COMMIT_DELAY_MS = UNDO_WINDOW_MS + 250;

// Every action still in its undo window, by timer. Closing or reloading the tab ends the page
// before the timers fire, and the action would never reach the server (the mail comes back next
// time), so flushUndoables runs them at once: on pagehide, with keepalive requests, and before the
// screen locks. Deletes keep their own flush in MessageList.
const held = new Map();

// setTimeout for an action in its undo window. Cancel it with releaseUndoable. A flush runs it with
// { flushing: true }: the page is about to go (or lock), so the action must send its request
// without first waiting on another one (re-reading a conversation), which would never answer.
export function holdUndoable(run, ms) {
  const id = setTimeout(() => { held.delete(id); run(); }, ms);
  held.set(id, run);
  return id;
}

// Cancels a held action. Returns whether it was still pending: false once it has run (its timer
// fired, or a flush sent it), when an Undo can no longer take it back.
export function releaseUndoable(id) {
  clearTimeout(id);
  return held.delete(id);
}

export function flushUndoables() {
  for (const [id, run] of [...held]) {
    releaseUndoable(id);
    try { run({ flushing: true }); } catch { /* each action handles its own failure */ }
  }
}

export function createUndoableCommit({
  delayMs = UNDO_WINDOW_MS,
  commit,
  undo,
  schedule = holdUndoable,
  cancel = releaseUndoable,
}) {
  let state = 'pending';
  const timer = schedule(async (options) => {
    if (state !== 'pending') return;
    state = 'committing';
    try {
      await commit(options);
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
