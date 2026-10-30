// A list row's body loaded while the pointer rests on it, so the click that usually follows shows
// the message at once (#677): on a provider whose bodies are only fetched when opened (Gmail),
// that fetch is most of the wait.
//
// Bounded, since every one may cost the mail server a fetch:
// - only after the pointer has rested on a row for HOVER_PREFETCH_DELAY_MS, so a sweep down the
//   list fetches nothing on the way;
// - only one at a time, and only when the browser is idle;
// - never while another body is loading (the open message's comes first): it waits for that load
//   to settle, then goes ahead if the pointer is still resting on the row;
// - within a budget per account (createPrefetchBudget), paused for that account when the server
//   says it is busy or throttled, and stopped for one the server never prefetches for;
// - leaving the row before it starts cancels it. One already under way is left to finish rather
//   than aborted: the server goes on with the fetch and stores the body either way, so aborting
//   would free nothing there and would only let the next row start a second fetch beside it.
//
// A prefetch is a body request marked ?prefetch=1: it marks nothing read, keeps remote images
// blocked by the user's setting, and the server may decline it (204, routes/mail.js) rather than
// reach the mail server. Nothing of the body is rendered until it is opened, so nothing remote loads either.

export const HOVER_PREFETCH_DELAY_MS = 300;

// Tokens per account: a burst of 3, refilled at 8 a minute, 6 for Gmail.
export const PREFETCH_BURST = 3;
export const PREFETCH_PER_MINUTE = 8;
export const PREFETCH_PER_MINUTE_GMAIL = 6;
// A busy or throttled answer pauses the account's prefetches for 5 minutes, doubling up to 30.
export const PREFETCH_PAUSE_MS = 5 * 60_000;
export const PREFETCH_PAUSE_MAX_MS = 30 * 60_000;
// A declined one (the server is backing the provider off) pauses it for a minute.
export const PREFETCH_DECLINED_PAUSE_MS = 60_000;

const idle = (fn) => {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(fn, { timeout: 500 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(fn, 0);
  return () => clearTimeout(handle);
};

// Each account's prefetch allowance: a token bucket, and a pause after the server pushed back.
// Outcomes: 'ok' (a body came) clears the pause ladder; 'throttled' (503, 504, 429) pauses for
// PREFETCH_PAUSE_MS, doubling each time up to PREFETCH_PAUSE_MAX_MS; 'declined' (a 204 while the
// provider is backed off) pauses for PREFETCH_DECLINED_PAUSE_MS; 'never' (a 204 for an account the
// server never prefetches for) stops that account's prefetches until clear(); anything else
// ('skip', 'failed', 'cached') changes nothing. Kept for the session, not per list: clear() it
// when the user changes or the app locks.
export function createPrefetchBudget({ now = () => Date.now(), burst = PREFETCH_BURST } = {}) {
  const accounts = new Map();
  const state = (key, perMinute) => {
    let s = accounts.get(key);
    const t = now();
    if (!s) {
      s = { tokens: burst, at: t, pausedUntil: 0, pause: 0, never: false };
      accounts.set(key, s);
    } else {
      s.tokens = Math.min(burst, s.tokens + ((t - s.at) * perMinute) / 60_000);
      s.at = t;
    }
    return s;
  };
  return {
    // Takes a token when the account may prefetch now; false otherwise.
    take(key, perMinute = PREFETCH_PER_MINUTE) {
      const s = state(key, perMinute);
      if (s.never || now() < s.pausedUntil || s.tokens < 1) return false;
      s.tokens -= 1;
      return true;
    },
    note(key, outcome, perMinute = PREFETCH_PER_MINUTE) {
      const s = state(key, perMinute);
      if (outcome === 'ok') s.pause = 0;
      else if (outcome === 'never') s.never = true;
      else if (outcome === 'throttled') {
        s.pause = s.pause ? Math.min(PREFETCH_PAUSE_MAX_MS, s.pause * 2) : PREFETCH_PAUSE_MS;
        s.pausedUntil = now() + s.pause;
      } else if (outcome === 'declined') {
        s.pausedUntil = Math.max(s.pausedUntil, now() + PREFETCH_DECLINED_PAUSE_MS);
      }
    },
    pausedUntil: key => accounts.get(key)?.pausedUntil ?? 0,
    clear: () => accounts.clear(),
  };
}

// prefetch(id): a promise for the outcome ('ok', 'throttled', 'declined', 'failed', 'cached').
// describe(id): { account, perMinute } for a row worth prefetching, or null for one that is not (a
// draft, a body already cached or open, an account prefetches are not for). busy(): whether another
// body is loading; settled(): a promise for when that load is done.
export function createHoverPrefetch({
  prefetch, describe = () => ({ account: 'default' }), busy = () => false, settled = () => Promise.resolve(),
  budget = createPrefetchBudget(), delay = HOVER_PREFETCH_DELAY_MS, schedule = idle,
}) {
  let hovered = null;  // the row under the pointer
  let rested = false;  // whether it has been there for `delay`
  let timer = null;
  let cancelIdle = null;
  let inFlight = null;
  let waiting = false; // for a body load to settle

  const stopWaiting = () => {
    clearTimeout(timer);
    timer = null;
    cancelIdle?.();
    cancelIdle = null;
  };

  // Tries again for the row still rested on, once the browser is idle.
  const again = (id) => {
    if (hovered === id && rested && !cancelIdle) cancelIdle = schedule(start);
  };

  function start() {
    cancelIdle = null;
    const id = hovered;
    if (!id || !rested || inFlight) return;
    const row = describe(id);
    if (!row) return;
    if (busy()) {
      if (!waiting) {
        waiting = true;
        Promise.resolve(settled()).catch(() => {}).finally(() => { waiting = false; again(hovered); });
      }
      return;
    }
    if (!budget.take(row.account, row.perMinute)) return;
    const request = prefetch(id);
    if (!request || typeof request.then !== 'function') return;
    inFlight = id;
    request.then(outcome => budget.note(row.account, outcome, row.perMinute), () => {}).finally(() => {
      inFlight = null;
      // The pointer moved on to another row and rested there while this ran: that one now.
      if (hovered && hovered !== id) again(hovered);
    });
  }

  return {
    enter(id) {
      if (!id || id === hovered) return;
      stopWaiting();
      hovered = id;
      rested = false;
      timer = setTimeout(() => {
        timer = null;
        rested = true;
        cancelIdle = schedule(start);
      }, delay);
    },
    leave() {
      stopWaiting();
      hovered = null;
      rested = false;
    },
    get inFlight() { return inFlight; },
  };
}
