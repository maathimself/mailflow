import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createResumeTracker, installResumeRefresh, RESUME_MIN_HIDDEN_MS, RESUME_COALESCE_MS } from './resumeRefresh.js';

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
  test('subscribes exactly the three signals that mean "you may be looking at stale pixels"', () => {
    const h = fakeHost();
    installResumeRefresh({ doc: h.doc, win: h.win, onResync: () => {} });
    assert.deepEqual([...h.listeners.doc.keys()], ['visibilitychange']);
    assert.deepEqual([...h.listeners.win.keys()].sort(), ['online', 'pageshow']);
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
