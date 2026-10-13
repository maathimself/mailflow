// #589: a notification tap can bring an iOS home-screen app to the front before the service worker
// has stored the message to open. Coming to the front keeps checking for a few seconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate, setTimeout, clearTimeout } from 'node:timers';
import { watchPendingDeepLink, PENDING_DEEPLINK_RETRY_MS } from './pendingDeepLink.js';

// A manual clock: schedule() queues, run() fires the next timer.
function clock() {
  const queue = [];
  return {
    schedule: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; },
    cancel: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); },
    run: async () => { const t = queue.shift(); t?.fn(); await flush(); return t?.ms; },
    get pending() { return queue.length; },
  };
}
const flush = () => new Promise((r) => setImmediate(r));
// take() answers from a script: null until the target "arrives".
const storage = (answers) => { let i = 0; const calls = []; return { calls, take: async () => { calls.push(i); return answers[i++] ?? null; } }; };

test('opens a target that is already stored, at once and only once', async () => {
  const c = clock(); const s = storage(['/?m=abc']); const opened = [];
  watchPendingDeepLink({ open: (u) => opened.push(u), take: s.take, schedule: c.schedule, cancel: c.cancel, isVisible: () => true });
  await flush();
  assert.deepEqual(opened, ['/?m=abc']);
  assert.equal(c.pending, 0, 'nothing left to check');
});

test('opens a target the service worker stores a moment after the app comes to the front', async () => {
  const c = clock(); const s = storage([null, null, '/?m=late']); const opened = [];
  watchPendingDeepLink({ open: (u) => opened.push(u), take: s.take, schedule: c.schedule, cancel: c.cancel, isVisible: () => true });
  await flush();
  assert.deepEqual(opened, []);
  assert.equal(await c.run(), PENDING_DEEPLINK_RETRY_MS[0]);
  assert.deepEqual(opened, []);
  assert.equal(await c.run(), PENDING_DEEPLINK_RETRY_MS[1]);
  assert.deepEqual(opened, ['/?m=late']);
  assert.equal(c.pending, 0);
});

test('gives up after the last retry when nothing was tapped', async () => {
  const c = clock(); const s = storage([]); const opened = [];
  watchPendingDeepLink({ open: (u) => opened.push(u), take: s.take, schedule: c.schedule, cancel: c.cancel, isVisible: () => true });
  await flush();
  for (let i = 0; i < PENDING_DEEPLINK_RETRY_MS.length; i += 1) await c.run();
  assert.equal(s.calls.length, PENDING_DEEPLINK_RETRY_MS.length + 1);
  assert.equal(c.pending, 0);
  assert.deepEqual(opened, []);
});

test('stops checking once the page is hidden again, or when stopped', async () => {
  let visible = true;
  const c = clock(); const s = storage([]);
  watchPendingDeepLink({ open: () => {}, take: s.take, schedule: c.schedule, cancel: c.cancel, isVisible: () => visible });
  await flush();
  visible = false;
  await c.run();
  assert.equal(c.pending, 0, 'no further check while hidden');

  const c2 = clock(); const s2 = storage([]);
  const stop = watchPendingDeepLink({ open: () => {}, take: s2.take, schedule: c2.schedule, cancel: c2.cancel, isVisible: () => true });
  await flush();
  stop();
  assert.equal(c2.pending, 0);
});

test('a read already under way still opens what it took after the watch is stopped', async () => {
  let release;
  const take = () => new Promise((r) => { release = r; });
  const opened = [];
  const stop = watchPendingDeepLink({ open: (u) => opened.push(u), take, schedule: setTimeout, cancel: clearTimeout, isVisible: () => true });
  stop();
  release('/?m=taken');
  await flush();
  assert.deepEqual(opened, ['/?m=taken'], 'the target is gone from storage, so dropping it would lose the tap');
});
