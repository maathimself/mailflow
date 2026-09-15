// Tracks in-flight AI actions so navigating away does not throw the work away.
//
// An AI action can take many seconds. Starting one and then carrying on triaging the inbox is
// the obvious thing to do, and it used to mean the result was lost: switching messages aborted
// every in-flight request, the AbortError was swallowed, and the completed text was never
// persisted. The user came back to no output and no sign anything had run (#428).
//
// The result was already keyed to the message it started from, so letting the request finish is
// safe. What was missing is a registry that distinguishes runs that genuinely should be
// cancelled from those that should be left alone:
//
//   - re-running the SAME action on the SAME message supersedes the earlier run, so cancel it
//   - dismissing a result cancels that run
//   - signing out or switching user cancels everything, because a run that outlived a logout
//     would write the previous user's result into this device's cache
//   - merely looking at a different message cancels NOTHING, and neither does closing a pop-out
//     or changing layout: those unmount the pane, which is navigation wearing a different hat
//
// Keying by message AND action is what makes that possible. Keyed by action alone, starting
// "summarize" on a second message would abort the first message's summarize, which is the same
// data loss by a different route.

const idFor = (messageId, actionKey) => `${messageId} ${actionKey}`;

export function createAiRunRegistry() {
  const runs = new Map();

  return {
    /** Register a run, superseding (and aborting) any run of the same action on the same message. */
    start(messageId, actionKey, controller) {
      const id = idFor(messageId, actionKey);
      runs.get(id)?.abort();
      runs.set(id, controller);
      return controller;
    },

    /** Forget a finished run without aborting it, so the map cannot grow without bound. */
    finish(messageId, actionKey) {
      runs.delete(idFor(messageId, actionKey));
    },

    /** Cancel one run, used when its result is dismissed. */
    abort(messageId, actionKey) {
      const id = idFor(messageId, actionKey);
      runs.get(id)?.abort();
      runs.delete(id);
    },

    /** Cancel everything. For identity changes (logout, account switch, lock), not for unmount. */
    abortAll() {
      for (const controller of runs.values()) controller?.abort();
      runs.clear();
    },

    /** Number of live runs, for tests and diagnostics. */
    get size() { return runs.size; },
  };
}

// Shared instance. Module-level on purpose: held in a component it would die with the pane, so
// closing a pop-out or switching layout would cancel a run the user is still waiting for.
export const aiRuns = createAiRunRegistry();
