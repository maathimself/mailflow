import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createResumeTracker, installResumeRefresh, RESUME_MIN_HIDDEN_MS, RESUME_COALESCE_MS, RESUME_RETRY_MS, RESUME_TIMEOUT_MS, SOCKET_CAUGHT_UP_EVENT } from './resumeRefresh.js';

describe('resume tracker: the stale-list-after-sleep bug', () => {
  test('a phone that slept through new mail resynchronises on wake', () => {
    // Measured case: no requests for 11 minutes while iOS froze the tab, so the rendered list
    // predated two messages that were already cached. Counts were fresh, pixels were not.
    const t = createResumeTracker();
    t.markHidden(0);
    assert.equal(t.shouldResume(11 * 60_000), true);
  });

  test('a bfcache restore resynchronises even though the page never reported itself hidden', () => {
    // iOS Safari restores from the back/forward cache without necessarily firing
    // visibilitychange. A visibility-only listener does nothing here, which is precisely how
    // this class of bug survives being "fixed".
    const t = createResumeTracker();
    assert.equal(t.shouldResume(5000, { force: true }), true);
  });

  test('the network coming back resynchronises regardless of hidden duration', () => {
    const t = createResumeTracker();
    assert.equal(t.shouldResume(1000, { force: true }), true);
  });
});

describe('resume tracker: what must NOT trigger a refresh', () => {
  test('a glance at the app switcher is not a suspension', () => {
    const t = createResumeTracker();
    t.markHidden(0);
    assert.equal(t.shouldResume(RESUME_MIN_HIDDEN_MS - 1), false);
  });

  test('the simultaneous burst a single resume produces collapses to one refresh', () => {
    // visibilitychange, pageshow and online can all fire within milliseconds of each other.
    const t = createResumeTracker();
    t.markHidden(0);
    assert.equal(t.shouldResume(10_000), true, 'first signal wins');
    assert.equal(t.shouldResume(10_010, { force: true }), false, 'pageshow moments later');
    assert.equal(t.shouldResume(10_020, { force: true }), false, 'online moments later');
  });

  test('a signal arriving while still hidden is ignored', () => {
    const t = createResumeTracker();
    t.markHidden(0);
    assert.equal(t.shouldResume(10_000, { visible: false }), false);
    assert.equal(t.shouldResume(10_001), true, 'and the hidden time is still credited afterwards');
  });

  test('repeated visible signals without an intervening hide do not refresh', () => {
    const t = createResumeTracker();
    t.markHidden(0);
    assert.equal(t.shouldResume(10_000), true);
    assert.equal(t.shouldResume(60_000), false, 'never hidden again, so nothing to catch up on');
  });

  test('a fresh page load does not refresh on top of its own initial fetch', () => {
    const t = createResumeTracker();
    assert.equal(t.shouldResume(0), false, 'no hidden period recorded');
  });
});

describe('resume tracker: boundaries and repeat cycles', () => {
  test('the threshold is inclusive at exactly minHiddenMs', () => {
    const t = createResumeTracker();
    t.markHidden(0);
    assert.equal(t.shouldResume(RESUME_MIN_HIDDEN_MS), true);
  });

  test('coalescing releases after its window, so a real second resume still works', () => {
    const t = createResumeTracker();
    t.markHidden(0);
    assert.equal(t.shouldResume(10_000), true);
    t.markHidden(11_000);
    assert.equal(t.shouldResume(11_000 + RESUME_COALESCE_MS), false, 'still inside the window');
    t.markHidden(20_000);
    assert.equal(t.shouldResume(40_000), true, 'a genuinely later resume is not suppressed');
  });

  test('a second hide without a show does not restart the clock', () => {
    // Some platforms fire visibilitychange more than once on the way down.
    const t = createResumeTracker();
    t.markHidden(0);
    t.markHidden(9_000);
    assert.equal(t.shouldResume(9_500), true, 'hidden since 0, not since 9000');
  });

  test('survives many sleep/wake cycles without drifting into always-on or always-off', () => {
    const t = createResumeTracker();
    let now = 0, refreshes = 0;
    for (let i = 0; i < 50; i++) {
      t.markHidden(now);
      now += 60_000;
      if (t.shouldResume(now)) refreshes++;
      now += 60_000;
    }
    assert.equal(refreshes, 50, 'every real wake must resynchronise, forever');
  });

  test('honours custom thresholds', () => {
    const t = createResumeTracker({ minHiddenMs: 100, coalesceMs: 10 });
    t.markHidden(0);
    assert.equal(t.shouldResume(150), true);
    t.markHidden(200);
    assert.equal(t.shouldResume(400), true, 'past the short coalesce window');
  });
});

// ── The wiring, not just the policy ──────────────────────────────────────────────────────────
function fakeHost() {
  const listeners = { doc: new Map(), win: new Map() };
  const make = key => ({
    addEventListener: (type, fn) => listeners[key].set(type, fn),
    removeEventListener: (type, fn) => { if (listeners[key].get(type) === fn) listeners[key].delete(type); },
  });
  const doc = Object.assign(make('doc'), { visibilityState: 'visible' });
  const win = make('win');
  return { doc, win, listeners, fire: (key, type, ev) => listeners[key].get(type)?.(ev) };
}

describe('installResumeRefresh: the listener wiring', () => {
  test('subscribes the three signals that mean "you may be looking at stale pixels", and the socket catch-up', () => {
    const h = fakeHost();
    installResumeRefresh({ doc: h.doc, win: h.win, onResync: () => {} });
    assert.deepEqual([...h.listeners.doc.keys()], ['visibilitychange']);
    assert.deepEqual([...h.listeners.win.keys()].sort(), [SOCKET_CAUGHT_UP_EVENT, 'online', 'pageshow'].sort());
  });

  test('removes every listener on cleanup, so a remount cannot double-refresh forever', () => {
    const h = fakeHost();
    const stop = installResumeRefresh({ doc: h.doc, win: h.win, onResync: () => {} });
    stop();
    assert.equal(h.listeners.doc.size, 0);
    assert.equal(h.listeners.win.size, 0);
  });

  test('a real sleep and wake resynchronises once', () => {
    const h = fakeHost();
    let now = 0, calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, onResync: () => calls++ });
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    now = 600_000;
    h.doc.visibilityState = 'visible'; h.fire('doc', 'visibilitychange');
    assert.equal(calls, 1);
  });

  test('a bfcache restore resynchronises; a normal load does not', () => {
    const h = fakeHost();
    let calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, onResync: () => calls++ });
    h.fire('win', 'pageshow', { persisted: false });
    assert.equal(calls, 0, 'an ordinary load already fetched on mount');
    h.fire('win', 'pageshow', { persisted: true });
    assert.equal(calls, 1);
  });

  test('going back online while the tab is hidden does not refresh, and the wake still does', () => {
    const h = fakeHost();
    let now = 0, calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, onResync: () => calls++ });
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    now = 300_000;
    h.fire('win', 'online');
    assert.equal(calls, 0, 'nobody is looking at it yet');
    now = 300_001;
    h.doc.visibilityState = 'visible'; h.fire('doc', 'visibilitychange');
    assert.equal(calls, 1, 'the hidden period must survive the ignored online event');
  });

  test('a locked session is skipped, and still owed its refresh once unlocked', () => {
    const h = fakeHost();
    let now = 0, calls = 0, locked = true;
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, shouldSkip: () => locked, onResync: () => calls++ });
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    now = 600_000;
    h.doc.visibilityState = 'visible'; h.fire('doc', 'visibilitychange');
    assert.equal(calls, 0, 'no network calls behind the lock screen');
    locked = false;
    now = 600_001;
    h.fire('win', 'online');
    assert.equal(calls, 1, 'the hidden clock was not consumed by the skipped attempt');
  });

  test('the burst of signals from one unlock produces exactly one resync', () => {
    const h = fakeHost();
    let now = 0, calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, onResync: () => calls++ });
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    now = 120_000;
    h.doc.visibilityState = 'visible';
    h.fire('doc', 'visibilitychange');
    h.fire('win', 'pageshow', { persisted: true });
    h.fire('win', 'online');
    assert.equal(calls, 1);
  });
});

// ── A resync that fails ──────────────────────────────────────────────────────────────────────
// A phone often comes back before its network does, so the requests a resume sends fail. The
// tracker has already spent that resume, so nothing asked again until the next event or a
// reload: the stale list this module exists to replace stayed on screen.
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimer: (t) => { pending.delete(t); },
    delays: () => [...pending.values()].map(p => p.ms),
    fire: () => { const [[key, p]] = pending; pending.delete(key); p.fn(); },
    pending,
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('installResumeRefresh: a resync that fails', () => {
  test('is tried again with a growing delay, and stops once it works', async () => {
    const h = fakeHost(), timers = fakeTimers();
    let now = 0, calls = 0;
    const outcomes = [false, false, true];
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, ...timers,
      onResync: () => { const ok = outcomes[calls++]; return ok ? Promise.resolve() : Promise.reject(new Error('offline')); } });
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    now = 600_000;
    h.doc.visibilityState = 'visible'; h.fire('doc', 'visibilitychange');
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(timers.delays(), [RESUME_RETRY_MS[0]]);
    timers.fire(); await settle();
    assert.equal(calls, 2);
    assert.deepEqual(timers.delays(), [RESUME_RETRY_MS[1]]);
    timers.fire(); await settle();
    assert.equal(calls, 3);
    assert.equal(timers.pending.size, 0, 'it worked, so nothing more is scheduled');
  });

  test('backs off to 30s twice and then a minute, where it stays', async () => {
    const h = fakeHost(), timers = fakeTimers();
    installResumeRefresh({ doc: h.doc, win: h.win, ...timers, onResync: () => Promise.reject(new Error('offline')) });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    const delays = [];
    for (let i = 0; i < 8; i += 1) { delays.push(...timers.delays()); timers.fire(); await settle(); }
    assert.deepEqual(delays, [2000, 5000, 15000, 30000, 30000, 60000, 60000, 60000]);
  });

  test('one wake after a failure resyncs once, not once per signal', async () => {
    const h = fakeHost(), timers = fakeTimers();
    let now = 0, calls = 0;
    const pending = [];
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, ...timers,
      onResync: () => (++calls === 1 ? Promise.reject(new Error('offline')) : new Promise(resolve => pending.push(resolve))) });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    // The retry comes due while the tab is away, so the resync is owed to the next return.
    now = 1000;
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    timers.fire(); await settle();
    // An iOS wake: visibilitychange, pageshow and online within 200ms of each other.
    now = 600_000;
    h.doc.visibilityState = 'visible'; h.fire('doc', 'visibilitychange');
    now += 50; h.fire('win', 'pageshow', { persisted: true });
    now += 150; h.fire('win', 'online');
    await settle();
    assert.equal(calls - 1, 1);
    pending.forEach(resolve => resolve());
  });

  test('a resync that hangs counts as failed after the timeout, and is tried again', async () => {
    const h = fakeHost(), timers = fakeTimers();
    let calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, ...timers,
      onResync: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve()) });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    assert.deepEqual(timers.delays(), [RESUME_TIMEOUT_MS], 'nothing but the timeout while it hangs');
    timers.fire(); await settle();
    assert.deepEqual(timers.delays(), [RESUME_RETRY_MS[0]]);
    timers.fire(); await settle();
    assert.equal(calls, 2);
    assert.equal(timers.pending.size, 0, 'it worked, and its timeout was cleared');
  });

  test('stops retrying once the socket reconnects and catches up', async () => {
    const h = fakeHost(), timers = fakeTimers();
    let calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, ...timers, onResync: () => { calls++; return Promise.reject(new Error('offline')); } });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    assert.equal(timers.pending.size, 1);
    h.fire('win', SOCKET_CAUGHT_UP_EVENT);
    assert.equal(timers.pending.size, 0);
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    h.doc.visibilityState = 'visible'; h.fire('doc', 'visibilitychange');
    assert.equal(calls, 1, 'nothing is owed any more');
  });

  test('warns once per wake, without the error, however many retries fail', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const h = fakeHost(), timers = fakeTimers();
    let now = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, ...timers, onResync: () => Promise.reject(new Error('secret detail')) });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    for (let i = 0; i < 3; i += 1) { timers.fire(); await settle(); }
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0].arguments, ['Resync after resume failed; trying again']);
    now = 10_000;
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    assert.equal(warn.mock.callCount(), 2, 'a new wake may warn again');
  });

  test('a resync that throws is tried again too', async () => {
    const h = fakeHost(), timers = fakeTimers();
    let calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, ...timers, onResync: () => { calls++; if (calls === 1) throw new Error('boom'); } });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    timers.fire(); await settle();
    assert.equal(calls, 2);
    assert.equal(timers.pending.size, 0);
  });

  test('a retry that comes due while the tab is hidden runs when it comes back, even after a glance', async () => {
    const h = fakeHost(), timers = fakeTimers();
    let now = 0, calls = 0;
    installResumeRefresh({ doc: h.doc, win: h.win, now: () => now, ...timers,
      onResync: () => (++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve()) });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    h.doc.visibilityState = 'hidden'; h.fire('doc', 'visibilitychange');
    timers.fire(); await settle();
    assert.equal(calls, 1, 'nobody is looking at it');
    now = 1500;
    h.doc.visibilityState = 'visible'; h.fire('doc', 'visibilitychange');
    await settle();
    assert.equal(calls, 2, 'still owed, so a short hide does not let it lapse');
  });

  test('cleanup cancels a retry that is waiting', async () => {
    const h = fakeHost(), timers = fakeTimers();
    const stop = installResumeRefresh({ doc: h.doc, win: h.win, ...timers, onResync: () => Promise.reject(new Error('offline')) });
    h.fire('win', 'pageshow', { persisted: true });
    await settle();
    assert.equal(timers.pending.size, 1);
    stop();
    assert.equal(timers.pending.size, 0);
  });
});
