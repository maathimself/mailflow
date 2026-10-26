// Loading a row's body while the pointer rests on it (#677): when it starts, and its bounds.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHoverPrefetch, createPrefetchBudget, HOVER_PREFETCH_DELAY_MS,
  PREFETCH_PAUSE_MS, PREFETCH_PAUSE_MAX_MS, PREFETCH_DECLINED_PAUSE_MS,
} from './hoverPrefetch.js';

const wait = ms => new Promise(r => setTimeout(r, ms));

// A prefetch whose requests the test settles by hand, with a budget that never runs out unless
// the test passes one.
function harness(opts = {}) {
  const started = [];
  const pending = new Map();
  const prefetcher = createHoverPrefetch({
    delay: 60,
    schedule: fn => { const h = setTimeout(fn, 0); return () => clearTimeout(h); },
    budget: createPrefetchBudget({ burst: 1000 }),
    prefetch: (id) => {
      started.push(id);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    ...opts,
  });
  return { prefetcher, started, pending };
}

describe('hover prefetch', () => {
  let h;
  beforeEach(() => { h = harness(); });

  test('waits 300 ms of rest by default', () => {
    assert.equal(HOVER_PREFETCH_DELAY_MS, 300);
  });

  test('starts once the pointer has rested on a row, not as it passes', async () => {
    h.prefetcher.enter('a');
    await wait(5);
    h.prefetcher.enter('b'); // moved on before the delay
    await wait(120);
    assert.deepEqual(h.started, ['b']);
  });

  test('leaving the row before it starts cancels it', async () => {
    h.prefetcher.enter('a');
    await wait(5);
    h.prefetcher.leave();
    await wait(120);
    assert.deepEqual(h.started, []);
  });

  test('moving within the same row does not restart the wait or fetch again', async () => {
    h.prefetcher.enter('a');
    await wait(30);
    h.prefetcher.enter('a');
    await wait(75);
    assert.deepEqual(h.started, ['a']);
    h.prefetcher.enter('a');
    await wait(120);
    assert.deepEqual(h.started, ['a']);
  });

  test('one at a time: the row rested on meanwhile is fetched when the first is done', async () => {
    h.prefetcher.enter('a');
    await wait(120);
    h.prefetcher.enter('b');
    await wait(120);
    assert.deepEqual(h.started, ['a'], 'b waits while a is in flight');
    assert.equal(h.prefetcher.inFlight, 'a');
    h.pending.get('a').resolve('ok');
    await wait(10);
    assert.deepEqual(h.started, ['a', 'b']);
  });

  test('a row left while another was in flight is not fetched after it', async () => {
    h.prefetcher.enter('a');
    await wait(120);
    h.prefetcher.enter('b');
    await wait(120);
    h.prefetcher.leave();
    h.pending.get('a').resolve('ok');
    await wait(10);
    assert.deepEqual(h.started, ['a']);
  });

  test('a failed prefetch frees the slot', async () => {
    h.prefetcher.enter('a');
    await wait(120);
    h.pending.get('a').reject(new Error('busy'));
    await wait(5);
    h.prefetcher.enter('b');
    await wait(120);
    assert.deepEqual(h.started, ['a', 'b']);
  });

  test('skips a row describe() rules out (cached, open, a draft, images asked for)', async () => {
    h = harness({ describe: id => (id === 'a' ? null : { account: 'x' }) });
    h.prefetcher.enter('a');
    await wait(120);
    assert.deepEqual(h.started, []);
  });

  test('waits out a body already loading, then goes ahead if the pointer is still resting', async () => {
    let busy = true;
    let settle;
    h = harness({ busy: () => busy, settled: () => new Promise(r => { settle = r; }) });
    h.prefetcher.enter('a');
    await wait(120);
    assert.deepEqual(h.started, [], 'not while the open message loads');
    busy = false;
    settle();
    await wait(10);
    assert.deepEqual(h.started, ['a']);
  });

  test('a row left while the open message loaded is not fetched after it', async () => {
    let busy = true;
    let settle;
    h = harness({ busy: () => busy, settled: () => new Promise(r => { settle = r; }) });
    h.prefetcher.enter('a');
    await wait(120);
    h.prefetcher.leave();
    busy = false;
    settle();
    await wait(10);
    assert.deepEqual(h.started, []);
  });

  test('waits for the browser to be idle before it starts', async () => {
    let run = null;
    h = harness({ schedule: (fn) => { run = fn; return () => { run = null; }; } });
    h.prefetcher.enter('a');
    await wait(120);
    assert.deepEqual(h.started, [], 'nothing until the idle callback runs');
    h.prefetcher.leave();
    assert.equal(run, null, 'leaving cancels the idle callback too');
    h.prefetcher.enter('b');
    await wait(120);
    run();
    assert.deepEqual(h.started, ['b']);
  });

  test('stays within the account budget, and a throttled answer pauses that account', async () => {
    let t = 0;
    const budget = createPrefetchBudget({ now: () => t });
    h = harness({ budget, describe: id => ({ account: id.startsWith('g') ? 'gmail' : 'other', perMinute: 6 }) });
    for (const id of ['g1', 'g2', 'g3', 'g4']) {
      h.prefetcher.enter(id);
      await wait(120);
      h.pending.get(id)?.resolve('ok');
      await wait(5);
    }
    assert.deepEqual(h.started, ['g1', 'g2', 'g3'], 'a burst of 3');
    h.prefetcher.enter('o1');
    await wait(120);
    assert.equal(h.started.at(-1), 'o1', 'another account has its own budget');
    h.pending.get('o1').reject(new Error('x'));
    await wait(5);
    t += 10_000; // one token back at 6 a minute
    h.prefetcher.enter('g5');
    await wait(120);
    assert.equal(h.started.at(-1), 'g5');
    h.pending.get('g5').resolve('throttled');
    await wait(5);
    t += 60_000;
    h.prefetcher.enter('g6');
    await wait(120);
    assert.equal(h.started.at(-1), 'g5', 'paused after a 503');
  });
});

describe('prefetch budget', () => {
  test('refills to 8 a minute, or the rate given, never past the burst', () => {
    let t = 0;
    const b = createPrefetchBudget({ now: () => t });
    assert.deepEqual([b.take('a'), b.take('a'), b.take('a'), b.take('a')], [true, true, true, false]);
    t += 7_500; // one token at 8 a minute
    assert.deepEqual([b.take('a'), b.take('a')], [true, false]);
    t += 7_500;
    assert.equal(b.take('a', 6), false, 'at 6 a minute 7.5 s is not a whole token');
    t += 2_500;
    assert.equal(b.take('a', 6), true);
    t += 3_600_000;
    assert.deepEqual([b.take('a'), b.take('a'), b.take('a'), b.take('a')], [true, true, true, false], 'still a burst of 3');
  });

  test('a throttled answer pauses for 5 minutes, doubling up to 30, and a body resets it', () => {
    let t = 0;
    const b = createPrefetchBudget({ now: () => t, burst: 100 });
    const pauses = [];
    for (let i = 0; i < 5; i += 1) {
      b.note('a', 'throttled');
      pauses.push(b.pausedUntil('a') - t);
      assert.equal(b.take('a'), false);
      t = b.pausedUntil('a');
      assert.equal(b.take('a'), true);
    }
    assert.deepEqual(pauses, [PREFETCH_PAUSE_MS, 2 * PREFETCH_PAUSE_MS, 4 * PREFETCH_PAUSE_MS, PREFETCH_PAUSE_MAX_MS, PREFETCH_PAUSE_MAX_MS]);
    b.note('a', 'ok');
    b.note('a', 'throttled');
    assert.equal(b.pausedUntil('a') - t, PREFETCH_PAUSE_MS);
  });

  test('a declined prefetch pauses that account for a minute', () => {
    let t = 0;
    const b = createPrefetchBudget({ now: () => t });
    b.note('a', 'declined');
    assert.equal(b.take('a'), false);
    assert.equal(b.take('b'), true);
    t += PREFETCH_DECLINED_PAUSE_MS;
    assert.equal(b.take('a'), true);
  });

  test('an account the server never prefetches for is stopped until cleared', () => {
    const b = createPrefetchBudget();
    b.note('a', 'never');
    assert.equal(b.take('a'), false);
    assert.equal(b.take('b'), true, 'other accounts go on');
    b.clear();
    assert.equal(b.take('a'), true, 'cleared with the session');
  });

  test('a skipped prefetch (a body due its repair) costs nothing but its token', () => {
    let t = 0;
    const b = createPrefetchBudget({ now: () => t });
    assert.equal(b.take('a'), true);
    b.note('a', 'skip');
    assert.equal(b.pausedUntil('a'), 0);
    assert.deepEqual([b.take('a'), b.take('a'), b.take('a')], [true, true, false]);
  });
});
