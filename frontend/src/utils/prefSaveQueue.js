// Batching queue for user preference writes.
//
// Preferences are saved on a debounce so that dragging a slider or clicking through
// options does not produce a request per keystroke. The original implementation had two
// gaps that between them lost settings silently:
//
//   1. Nothing flushed the queue when the page went away. Change a setting and reload or
//      navigate inside the debounce window and the write never happened. Worse, the value
//      was already in localStorage, so the UI looked correct until the next load, when
//      loadPreferences overwrote it with the older server value. The setting appeared to
//      revert on its own, which is impossible to attribute to a timing window.
//   2. The failure path was `.catch(() => {})`. A save that failed said nothing, anywhere.
//
// The queue takes its save functions as dependencies so this behaviour can be tested
// without a network or a DOM.
export function createPrefSaveQueue({ save, saveOnExit, delayMs = 1000, onError } = {}) {
  let timer = null;
  let pending = {};

  const takePending = () => {
    const taken = pending;
    pending = {};
    return taken;
  };

  const send = (prefs, exiting) => {
    const keys = Object.keys(prefs);
    if (!keys.length) return;
    // On exit prefer the keepalive sender: a normal fetch is cancelled when the document
    // goes away, which is the whole failure this queue exists to prevent.
    const fn = (exiting && saveOnExit) || save;
    try {
      const result = fn(prefs);
      if (result && typeof result.catch === 'function') {
        result.catch(err => onError?.(err, keys));
      }
    } catch (err) {
      onError?.(err, keys);
    }
  };

  return {
    /** Queue preferences and (re)start the debounce. */
    schedule(prefs) {
      Object.assign(pending, prefs);
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send(takePending(), false);
      }, delayMs);
    },

    /**
     * Send whatever is queued right now, cancelling the debounce.
     *
     * Called when the page is being hidden or unloaded, where waiting out the debounce
     * means the write is simply lost. Safe to call when nothing is pending.
     */
    flush({ exiting = false } = {}) {
      clearTimeout(timer);
      timer = null;
      send(takePending(), exiting);
    },

    /**
     * Drop everything queued without sending.
     *
     * Used on logout and account switch: a pending write belongs to the previous session,
     * so letting it fire would either save into the next user's account or hit a dead one.
     */
    cancel() {
      clearTimeout(timer);
      timer = null;
      pending = {};
    },

    /** Whether anything is waiting to be written. Exposed for tests and diagnostics. */
    hasPending() {
      return Object.keys(pending).length > 0;
    },
  };
}
