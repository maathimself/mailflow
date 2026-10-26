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
/** Waits before trying a failed resync again; the last one repeats until it works. */
export const RESUME_RETRY_MS = [2000, 5000, 15000, 30000, 30000, 60000];
/** A resync that has not settled by then failed: a fetch can hang on a dead network. */
export const RESUME_TIMEOUT_MS = 20000;
/** Dispatched on window when the WebSocket reconnects; its catch-up settles an owed resync. */
export const SOCKET_CAUGHT_UP_EVENT = 'mailflow:socket_caught_up';

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
 * @param onResync    called when a resynchronization is due; a promise it returns that rejects
 *                    (or a throw) means the resync failed and is tried again
 * @param shouldSkip  suppress while the session is locked, without discarding the hidden clock
 */
export function installResumeRefresh({
  doc, win, onResync, shouldSkip = () => false, now = () => Date.now(), tracker = createResumeTracker(),
  coalesceMs = RESUME_COALESCE_MS, retryMs = RESUME_RETRY_MS, timeoutMs = RESUME_TIMEOUT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  // A phone often comes back before its network does, so the resync it asks for fails. The
  // tracker has spent that resume by then, so a failure is owed a retry of its own: while
  // the tab is visible on a timer, otherwise at the next return, however short the absence.
  // A socket that reconnects runs its own catch-up, which settles what is owed.
  let failures = 0;
  let owed = false;
  let retryTimer = null;
  let generation = 0;
  let inFlight = null;     // generation of the run not yet settled
  let lastRunAt = null;
  let warned = false;      // one warning per wake, not one per retry
  const cancel = () => {
    generation += 1;
    inFlight = null;
    clearTimer(retryTimer);
    retryTimer = null;
  };
  const run = () => {
    clearTimer(retryTimer);
    retryTimer = null;
    const gen = ++generation;
    inFlight = gen;
    lastRunAt = now();
    let done;
    try { done = Promise.resolve(onResync()); } catch (err) { done = Promise.reject(err); }
    // Otherwise a request hanging on a dead network holds the run in flight until the next resume.
    let timeout;
    done = Promise.race([done, new Promise((_, reject) => {
      timeout = setTimer(() => reject(new Error('Resync timed out')), timeoutMs);
    })]).finally(() => clearTimer(timeout));
    done.then(() => {
      if (gen !== generation) return;
      inFlight = null;
      failures = 0;
      owed = false;
    }, () => {
      if (gen !== generation) return;
      inFlight = null;
      if (!warned) { warned = true; console.warn('Resync after resume failed; trying again'); }
      owed = true;
      retryTimer = setTimer(retry, retryMs[Math.min(failures, retryMs.length - 1)]);
      failures += 1;
    });
  };
  const retry = () => {
    retryTimer = null;
    if (shouldSkip() || doc.visibilityState !== 'visible') return;
    run();
  };
  const resync = (opts) => {
    // Checked before the tracker so a locked session does not consume the hidden period:
    // the resync is still owed once the session is usable again.
    if (shouldSkip()) return false;
    const t = now();
    const due = tracker.shouldResume(t, opts);
    // An owed resync bypasses the hidden threshold, never a run in flight or the coalescing
    // window: one wake fires visibilitychange, pageshow and online together.
    const repay = owed && retryTimer === null && inFlight === null && opts.visible
      && (lastRunAt === null || t - lastRunAt >= coalesceMs);
    if (!due && !repay) return false;
    warned = false;
    run();
    return true;
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') resync({ visible: true });
    else tracker.markHidden(now());
  };
  const onPageShow = (e) => { if (e?.persisted) resync({ visible: true, force: true }); };
  const onOnline = () => resync({ visible: doc.visibilityState === 'visible', force: true });
  const onCaughtUp = () => {
    if (!owed && inFlight === null) return;
    cancel();
    owed = false;
    failures = 0;
  };

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('online', onOnline);
  win.addEventListener(SOCKET_CAUGHT_UP_EVENT, onCaughtUp);
  return () => {
    cancel();
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('online', onOnline);
    win.removeEventListener(SOCKET_CAUGHT_UP_EVENT, onCaughtUp);
  };
}
