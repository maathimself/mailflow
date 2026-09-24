// Tests for the shared mark-read protocol.
//
// Three callers depend on this (MessagePane, ConversationPane, MailApp's deep-link
// path), so the contract is worth pinning: the right preference is honored, the
// request goes out once, and a failed request puts every piece of optimistic state
// back. The store and the api layer are real here; only fetch is stubbed, because a
// mocked store would prove nothing about the counters this is supposed to keep in step.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

// The store reaches i18n, which imports locale JSON. node --test will not load a
// JSON module without an import attribute, so hand it back as a module instead.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent,
});

let bulkReads = [];
let failNext = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/mail/messages/bulk-read')) {
    bulkReads.push(JSON.parse(opts.body));
    if (failNext) return { ok: false, status: 500, json: async () => ({ error: 'nope' }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { useStore } = await import('../store/index.js');
const { applyMarkRead, scheduleMarkRead, cancelScheduledMarkRead, cancelScheduledMarkReadFor } = await import('./markRead.js');
const { pendingMarkReadMap, completedMarkReadMap } = await import('./pendingReads.js');

const MSG = { id: 'm1', account_id: 'acct', category: 'primary', is_read: false };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const readFlag = () => useStore.getState().messages.find(m => m.id === 'm1')?.is_read;

beforeEach(() => {
  bulkReads = [];
  failNext = false;
  pendingMarkReadMap.clear();
  completedMarkReadMap.clear();
  useStore.setState({ markReadBehavior: 'immediate', markReadDelay: 1 });
  useStore.getState().setMessages([{ ...MSG }]);
});

describe('applyMarkRead', () => {
  test('flips the flag, sends one request and clears the guard', async () => {
    applyMarkRead({ ...MSG });
    assert.equal(readFlag(), true, 'the flag flips optimistically, before the server answers');
    assert.equal(pendingMarkReadMap.get('m1'), 'acct', 'the guard is set while the PATCH is in flight');

    await tick();
    assert.deepEqual(bulkReads, [{ ids: ['m1'], read: true }], 'exactly one request, for this message');
    assert.equal(pendingMarkReadMap.has('m1'), false, 'the guard is released once committed');
    assert.equal(completedMarkReadMap.get('m1'), 'acct', 'the commit is recorded for racing SELECTs');
  });

  test('rolls the flag back when the request fails', async () => {
    failNext = true;
    applyMarkRead({ ...MSG });
    assert.equal(readFlag(), true, 'still optimistic at first');

    await tick();
    assert.equal(readFlag(), false, 'a failed request must not leave the message looking read');
    assert.equal(pendingMarkReadMap.has('m1'), false, 'the guard is released on failure too');
    assert.equal(completedMarkReadMap.has('m1'), false, 'a failure is never recorded as a commit');
  });

  test('is a no-op for a message that is already read', async () => {
    applyMarkRead({ ...MSG, is_read: true });
    await tick();
    assert.deepEqual(bulkReads, [], 'no request for a message that is already read');
  });
});

describe('scheduleMarkRead', () => {
  test('explicit unread cancels every pending reader timer for that message', async () => {
    useStore.setState({ markReadBehavior: 'delay', markReadDelay: 0.03 });
    scheduleMarkRead({ ...MSG });
    scheduleMarkRead({ ...MSG });
    cancelScheduledMarkReadFor(MSG.id);
    await tick(70);
    assert.deepEqual(bulkReads, []);
    assert.equal(readFlag(), false);
  });
  test('marks immediately by default', async () => {
    const timer = scheduleMarkRead({ ...MSG });
    assert.equal(timer, null, 'nothing to cancel when the mark already happened');
    await tick();
    assert.equal(bulkReads.length, 1, 'the request went out right away');
  });

  test('never marks when the preference is manual', async () => {
    useStore.setState({ markReadBehavior: 'manual' });
    const timer = scheduleMarkRead({ ...MSG });
    assert.equal(timer, null);
    await tick(40);
    assert.deepEqual(bulkReads, [], 'manual means the user marks it themselves');
    assert.equal(readFlag(), false, 'and the flag is left alone');
  });

  test('waits out the delay, and the caller can cancel before it fires', async () => {
    useStore.setState({ markReadBehavior: 'delay', markReadDelay: 0.05 });

    const cancelled = scheduleMarkRead({ ...MSG });
    assert.notEqual(cancelled, null, 'a deferred mark hands back a handle to cancel');
    cancelScheduledMarkRead(cancelled);
    await tick(80);
    assert.deepEqual(bulkReads, [], 'a reader who moves on before the delay does not mark it read');

    scheduleMarkRead({ ...MSG });
    await tick(10);
    assert.deepEqual(bulkReads, [], 'still nothing while the delay is running');
    await tick(80);
    assert.equal(bulkReads.length, 1, 'and it marks once the delay elapses');
  });

  test('caller cancellation removes its handle from the scheduled registry', () => {
    useStore.setState({ markReadBehavior: 'delay', markReadDelay: 10 });
    const timer = scheduleMarkRead({ ...MSG });
    const originalClearTimeout = globalThis.clearTimeout;
    let clears = 0;
    globalThis.clearTimeout = (...args) => { clears++; return originalClearTimeout(...args); };
    try {
      cancelScheduledMarkRead(timer);
      cancelScheduledMarkReadFor(MSG.id);
      assert.equal(clears, 1, 'cancel-by-message must not see an already cancelled handle');
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
      originalClearTimeout(timer);
    }
  });
});
