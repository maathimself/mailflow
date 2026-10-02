// Run with: node --test src/utils/heldSend.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDO_SEND_SECONDS, POLL_INTERVAL_MS, GIVE_UP_AFTER_MS,
  undoWindowMs, reopenCompose, trackHeldSend,
} from './heldSend.js';

describe('undoWindowMs', () => {
  test('is what the server said was left, so a slow upload does not shorten it', () => {
    assert.equal(undoWindowMs(9_400), 9_400);
    assert.equal(undoWindowMs(UNDO_SEND_SECONDS * 1000), UNDO_SEND_SECONDS * 1000);
  });
  test('stays within the window', () => {
    assert.equal(undoWindowMs(-50), 0);
    assert.equal(undoWindowMs(60_000), UNDO_SEND_SECONDS * 1000);
    assert.equal(undoWindowMs(undefined), UNDO_SEND_SECONDS * 1000);
  });
});

function fakeStore(composing) {
  const listeners = new Set();
  const opened = [];
  let state;
  const setState = (patch) => { state = { ...state, ...patch }; [...listeners].forEach(l => l(state)); };
  state = { composing, user: { id: 'u1' }, openCompose: (data) => { opened.push(data); setState({ composing: true }); } };
  return {
    opened, setState,
    getState: () => state,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
}

describe('reopenCompose', () => {
  test('opens the message when no other is open', () => {
    const store = fakeStore(false);
    assert.equal(reopenCompose(store, { subject: 'A' }), true);
    assert.deepEqual(store.opened, [{ subject: 'A' }]);
  });
  test('waits for a message being written to close instead of replacing it', () => {
    const store = fakeStore(true);
    assert.equal(reopenCompose(store, { subject: 'A' }), false);
    assert.deepEqual(store.opened, []);
    store.setState({ composing: false });
    assert.deepEqual(store.opened, [{ subject: 'A' }]);
    store.setState({ composing: false });
    assert.equal(store.opened.length, 1, 'opens it once');
  });
  test("a message waiting to reopen is never handed to the next user", () => {
    const store = fakeStore(true);
    reopenCompose(store, { subject: 'A' });
    store.setState({ user: null, composing: false }); // signed out in this tab
    store.setState({ user: { id: 'u2' } });
    store.setState({ composing: true });
    store.setState({ composing: false });
    assert.deepEqual(store.opened, []);
  });
});

// A clock and a timer queue under the test's control.
function harness({ statuses = [], cancelResult, restoreOpens = true, ownerChange } = {}) {
  let clock = 0;
  const timers = [];
  const calls = { getStatus: 0, cancel: 0, restored: [], sent: [], notes: [], dismissed: 0 };
  const deps = {
    now: () => clock,
    schedule: (fn, ms) => { const timer = { at: clock + ms, fn }; timers.push(timer); return timer; },
    unschedule: (timer) => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    getStatus: async () => {
      calls.getStatus++;
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      if (next instanceof Error) throw next;
      return next;
    },
    cancel: async () => {
      calls.cancel++;
      if (cancelResult instanceof Error) throw cancelResult;
      return cancelResult;
    },
    notify: (n) => { calls.notes.push(n); },
    dismissUndo: () => { calls.dismissed++; },
    onOwnerChange: ownerChange ? (stop) => { ownerChange.stop = stop; return () => { ownerChange.unwatched = true; }; } : undefined,
    t: (k) => k,
  };
  const undo = trackHeldSend(
    { pendingId: 'p1', undoMs: 9000, subject: 'Contract' },
    {
      restore: (error) => { calls.restored.push(error); return restoreOpens; },
      onSent: (result) => { calls.sent.push(result); },
    },
    deps,
  );
  // Runs every timer due by `ms` from now, letting each one's awaits finish.
  const advance = async (ms) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > until) break;
      const { at, fn } = timers.shift();
      clock = at;
      await fn();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    clock = until;
  };
  return { undo, calls, advance, pendingTimers: () => timers.length };
}

describe('trackHeldSend', () => {
  test('asks the server once the window is over, and reports a delivered send', async () => {
    const h = harness({ statuses: [{ status: 'sent', result: { ok: true, sentFolder: 'Sent' } }] });
    await h.advance(9000);
    assert.equal(h.calls.getStatus, 0, 'does not ask during the window');
    await h.advance(1000);
    assert.deepEqual(h.calls.sent, [{ ok: true, sentFolder: 'Sent' }]);
    assert.equal(h.calls.dismissed, 1);
    assert.deepEqual(h.calls.restored, []);
  });

  test('keeps asking while delivery is under way', async () => {
    const h = harness({ statuses: [{ status: 'sending' }, { status: 'sending' }, { status: 'sent', result: { ok: true } }] });
    await h.advance(10_000 + 2 * POLL_INTERVAL_MS);
    assert.equal(h.calls.getStatus, 3);
    assert.equal(h.calls.sent.length, 1);
  });

  test('undo within the window reopens the message, and nothing else is reported', async () => {
    const h = harness({ cancelResult: { cancelled: true }, statuses: [{ status: 'cancelled' }] });
    await h.undo();
    assert.deepEqual(h.calls.restored, [undefined], 'reopened, without an error');
    assert.deepEqual(h.calls.notes, [], 'the reopened message is the confirmation; no toast over it');
    assert.equal(h.pendingTimers(), 0, 'the poll that was due is called off');
    await h.advance(60_000);
    assert.equal(h.calls.getStatus, 0);
    assert.deepEqual(h.calls.sent, []);
  });

  test('a second press of Undo does not send a second cancel', async () => {
    const h = harness({ cancelResult: { cancelled: true } });
    await Promise.all([h.undo(), h.undo()]);
    assert.equal(h.calls.cancel, 1);
  });

  test('too late to undo: says so, then reports the send', async () => {
    const h = harness({ cancelResult: { cancelled: false, status: 'sending' }, statuses: [{ status: 'sent', result: { ok: true } }] });
    await h.undo();
    assert.equal(h.calls.notes[0].title, 'compose.undoSend.tooLate');
    assert.deepEqual(h.calls.restored, []);
    await h.advance(10_000);
    assert.equal(h.calls.sent.length, 1);
  });

  test('a failed delivery reopens the message with the reason', async () => {
    const h = harness({ statuses: [{ status: 'failed', error: 'Message was rejected by the mail server.' }] });
    await h.advance(10_000);
    assert.deepEqual(h.calls.restored, ['Message was rejected by the mail server.']);
    assert.equal(h.calls.notes[0].type, 'error');
    assert.equal(h.calls.notes[0].title, 'compose.undoSend.notSent');
  });

  test('a send lost to a server restart reopens the message and says why', async () => {
    const h = harness({ statuses: [{ status: 'lost' }] });
    await h.advance(10_000);
    assert.deepEqual(h.calls.restored, ['compose.undoSend.lost']);
  });

  test('an undone message that has to wait for another to close says so', async () => {
    const h = harness({ cancelResult: { cancelled: true }, restoreOpens: false });
    await h.undo();
    assert.deepEqual(h.calls.notes.map(n => [n.title, n.body]), [['compose.undoSend.undone', 'compose.undoSend.reopenLater']]);
  });

  test('says when the message will reopen later because another one is open', async () => {
    const h = harness({ statuses: [{ status: 'failed', error: 'x' }], restoreOpens: false });
    await h.advance(10_000);
    assert.equal(h.calls.notes[0].body, 'compose.undoSend.reopenLater');
  });

  test('an unknown outcome is not guessed at: the user is asked to check Sent and may reopen', async () => {
    const h = harness({ statuses: [{ status: 'unknown' }] });
    await h.advance(10_000);
    assert.deepEqual(h.calls.restored, [], 'not reopened by itself: it may have been delivered');
    assert.deepEqual(h.calls.sent, [], 'not reported as sent: it may not have been');
    const note = h.calls.notes[0];
    assert.equal(note.title, 'compose.undoSend.unknown');
    assert.equal(note.persistent, true);
    note.onAction();
    assert.deepEqual(h.calls.restored, [undefined]);
  });

  test('rides out a connection that drops for a while', async () => {
    const h = harness({ statuses: [new Error('offline'), new Error('offline'), { status: 'sent', result: { ok: true } }] });
    await h.advance(10_000 + 2 * POLL_INTERVAL_MS);
    assert.equal(h.calls.sent.length, 1);
  });

  test('gives up after a while and reports the outcome as unknown', async () => {
    const h = harness({ statuses: [new Error('offline')] });
    await h.advance(9000 + GIVE_UP_AFTER_MS + 5 * POLL_INTERVAL_MS);
    assert.equal(h.calls.notes.length, 1);
    assert.equal(h.calls.notes[0].title, 'compose.undoSend.unknown');
    const polls = h.calls.getStatus;
    await h.advance(60_000);
    assert.equal(h.calls.getStatus, polls, 'stops asking');
  });

  test('a sign-out stops following the send: nothing more is asked, reopened or reported', async () => {
    const ownerChange = {};
    const h = harness({ statuses: [{ status: 'failed', error: 'x' }], cancelResult: { cancelled: true }, ownerChange });
    ownerChange.stop();
    assert.equal(h.calls.dismissed, 1, 'the Undo bar goes');
    assert.equal(h.pendingTimers(), 0);
    assert.equal(ownerChange.unwatched, true);
    await h.undo();
    await h.advance(60_000);
    assert.equal(h.calls.getStatus, 0);
    assert.equal(h.calls.cancel, 0);
    assert.deepEqual(h.calls.restored, []);
    assert.deepEqual(h.calls.notes, []);
  });

  test('an undo that cannot reach the server says so, and the send is still followed', async () => {
    const h = harness({ cancelResult: new Error('offline'), statuses: [{ status: 'sent', result: { ok: true } }] });
    await h.undo();
    assert.equal(h.calls.notes[0].title, 'compose.undoSend.undoFailed');
    await h.advance(10_000);
    assert.equal(h.calls.sent.length, 1);
  });
});
