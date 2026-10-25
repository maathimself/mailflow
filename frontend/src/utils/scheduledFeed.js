import { api } from './api.js';
import { useStore } from '../store/index.js';
import { changeNotices } from './scheduledView.js';

// Keeps the Scheduled view's list and the sidebar's counts current (#543, design 5.3). The server
// says only that a message changed (scheduled_changed { id, status }, no content), so a burst of
// changes (a claim and a send, a hold and a release) is collected into one refetch of the list
// and the counts. The list is fetched when the view opens, on a change, and once while something
// is scheduled, so that a change can be compared with what the message was before: that is how a
// message the sender sent, failed or paused is told apart from one the user changed.

export const REFRESH_DEBOUNCE_MS = 300;
// A steady stream of changes still refreshes at least this often.
export const REFRESH_MAX_WAIT_MS = 2000;

export function createScheduledFeed({
  store = useStore, client = api, schedule = setTimeout, unschedule = clearTimeout, delayMs = REFRESH_DEBOUNCE_MS,
  maxWaitMs = REFRESH_MAX_WAIT_MS, clock = () => Date.now(),
} = {}) {
  let timer = null;
  // When the first change of the burst waiting now came in.
  let firstAt = null;
  let running = null;
  let again = false;
  const listeners = new Set();

  async function load() {
    const owner = store.getState().user?.id;
    const [list, counts] = await Promise.all([
      client.scheduled.list(),
      client.getUnreadCounts().catch(() => null),
    ]);
    const state = store.getState();
    // Signed out, another user, or locked meanwhile: this answer is not for them.
    if (state.user?.id !== owner || state.isLocked) return null;
    if (counts) state.setUnreadCounts(counts);
    const previous = state.scheduledList?.messages || null;
    const withSummaries = (list?.messages || []).map(m => (m.summary || !state.scheduledSummaries[m.id] ? m : { ...m, cachedSummary: true, summary: state.scheduledSummaries[m.id] }));
    const next = { messages: withSummaries, moreSent: list?.moreSent === true, loadedAt: Date.now(), error: null };
    state.setScheduledList(next);
    const notices = changeNotices(previous, withSummaries);
    if (notices.length) for (const listener of listeners) listener(notices);
    return next;
  }

  // Fetches now, or once more after the fetch that is out (a change during it may not be in it).
  function refresh() {
    unschedule(timer);
    timer = null;
    firstAt = null;
    if (running) {
      again = true;
      return running;
    }
    running = load()
      .catch((err) => {
        const state = store.getState();
        // A failed refresh keeps what the view shows, and says so only when there is nothing.
        if (!state.scheduledList) state.setScheduledList({ messages: [], moreSent: false, loadedAt: null, error: err?.message || 'error' });
        return null;
      })
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          refresh();
        }
      });
    return running;
  }

  // A change seen over the WebSocket: collected until `delayMs` pass without another, then one
  // refresh, but never more than `maxWaitMs` after the first.
  function changed() {
    const now = clock();
    if (firstAt == null) firstAt = now;
    unschedule(timer);
    const wait = Math.max(0, Math.min(delayMs, firstAt + maxWaitMs - now));
    timer = schedule(() => { timer = null; refresh(); }, wait);
  }

  // `onNotices(notices)` hears what changeNotices found. Also fetches the list once, while
  // something is scheduled, so the first change has something to be compared with.
  function start({ onNotices } = {}) {
    if (onNotices) listeners.add(onNotices);
    const prime = (state) => {
      if (state.user && !state.isLocked && !state.scheduledList && !running
        && (state.scheduledCount > 0 || state.scheduledAttention > 0)) refresh();
    };
    prime(store.getState());
    const unsubscribe = store.subscribe(prime);
    return () => {
      unsubscribe();
      if (onNotices) listeners.delete(onNotices);
      unschedule(timer);
      timer = null;
      firstAt = null;
    };
  }

  return { refresh, changed, start };
}

export const scheduledFeed = createScheduledFeed();
