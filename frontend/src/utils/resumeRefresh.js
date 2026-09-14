// Decide when a returning tab must resynchronise before the user trusts what it shows.
//
// The failure this exists to end: a phone sleeps, iOS freezes the tab, and the rendered list is
// a photograph of the mailbox from before the last few messages arrived. Counts recover quickly
// because they are polled and pushed from several places, so the badge says 2 while the list
// shows nothing unread. The data is correct everywhere; only the pixels are old. That reads as
// "the unread count is lying", which is the most corrosive bug a mail client can have.
//
// Refreshing is NOT the hard part. The reasons this class of bug keeps coming back are:
//
//   1. bfcache. iOS Safari restores a page from the back/forward cache without necessarily
//      firing visibilitychange, so a visibility-only listener silently does nothing on exactly
//      the platform that needs it most. pageshow with persisted=true is the reliable signal.
//   2. Timers are throttled or frozen while hidden, so "there is already a 15s interval" is not
//      a resume story. On resume the next tick can be a long way off.
//   3. Several signals fire together (visibilitychange, pageshow, online), and a naive listener
//      per signal produces a burst of duplicate fetches every time you unlock your phone.
//   4. Refreshing on every flicker of visibility hammers the server when someone flips between
//      apps, so people add a threshold, set it too high, and reintroduce the staleness.
//
// So the policy lives here as a pure state machine with tests, and the wiring stays trivial.
// Callers feed it events; it answers one question: resynchronise now, yes or no.

/** Below this, a hide/show round trip is treated as a glance, not a suspension. */
export const RESUME_MIN_HIDDEN_MS = 3000;
/** Collapses the burst of signals that a single resume produces. */
export const RESUME_COALESCE_MS = 1000;

/**
 * @param minHiddenMs how long the page must have been hidden for a plain visibility return to count
 * @param coalesceMs  window within which repeated resume signals collapse into one
 */
export function createResumeTracker({ minHiddenMs = RESUME_MIN_HIDDEN_MS, coalesceMs = RESUME_COALESCE_MS } = {}) {
  let hiddenSince = null;
  let lastResumeAt = null;

  return {
    /** The page went away. Recorded once; a second hide without a show must not move the clock. */
    markHidden(now) {
      if (hiddenSince === null) hiddenSince = now;
    },

    /**
     * A resume signal arrived. Returns true when the caller should resynchronise.
     *
     * `force` is for signals that imply staleness on their own and carry no hidden duration:
     * a bfcache restore (pageshow persisted) and the network coming back. Those must resync
     * even though the tab may never have reported itself hidden.
     */
    shouldResume(now, { visible = true, force = false } = {}) {
      if (!visible) return false;
      const hiddenFor = hiddenSince === null ? 0 : now - hiddenSince;
      hiddenSince = null;
      if (!force && hiddenFor < minHiddenMs) return false;
      if (lastResumeAt !== null && now - lastResumeAt < coalesceMs) return false;
      lastResumeAt = now;
      return true;
    },
  };
}

/**
 * Install the resume listeners and return a cleanup function.
 *
 * Kept here rather than inline in the component so the listener wiring itself is testable:
 * which events are subscribed, which of them force a resync, that a locked session is skipped
 * without losing the hidden clock, and that every listener is removed again. Those are the
 * parts that rot silently when someone edits the component around them.
 *
 * @param doc         document (injected for tests)
 * @param win         window (injected for tests)
 * @param onResync    called when a resynchronisation is due
 * @param shouldSkip  suppress while the session is locked, without discarding the hidden clock
 */
export function installResumeRefresh({ doc, win, onResync, shouldSkip = () => false, now = () => Date.now(), tracker = createResumeTracker() }) {
  const resync = (opts) => {
    // Checked before the tracker so a locked session does not consume the hidden period:
    // the resync is still owed once the session is usable again.
    if (shouldSkip()) return false;
    if (!tracker.shouldResume(now(), opts)) return false;
    onResync();
    return true;
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') resync({ visible: true });
    else tracker.markHidden(now());
  };
  const onPageShow = (e) => { if (e?.persisted) resync({ visible: true, force: true }); };
  const onOnline = () => resync({ visible: doc.visibilityState === 'visible', force: true });

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('online', onOnline);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('online', onOnline);
  };
}
