import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as undoableAction from './undoableAction.js';

function fakeTimer() {
  let callback;
  let cancelled = false;
  return {
    schedule(fn) {
      callback = fn;
      return 'timer';
    },
    cancel(timer) {
      assert.equal(timer, 'timer');
      cancelled = true;
    },
    async fire() {
      return callback();
    },
    wasCancelled() {
      return cancelled;
    },
  };
}

describe('createUndoableCommit', () => {
  it('cancels a pending commit and runs undo exactly once', async () => {
    assert.equal(typeof undoableAction.createUndoableCommit, 'function');
    const timer = fakeTimer();
    const calls = [];
    const action = undoableAction.createUndoableCommit({
      delayMs: 4500,
      commit: async () => { calls.push('commit'); },
      undo: () => { calls.push('undo'); },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    assert.equal(action.undo(), true);
    assert.equal(action.undo(), false);
    await timer.fire();

    assert.equal(timer.wasCancelled(), true);
    assert.deepEqual(calls, ['undo']);
  });

  it('rejects a late undo after the commit has started', async () => {
    assert.equal(typeof undoableAction.createUndoableCommit, 'function');
    const timer = fakeTimer();
    const calls = [];
    const action = undoableAction.createUndoableCommit({
      delayMs: 4500,
      commit: async () => { calls.push('commit'); },
      undo: () => { calls.push('undo'); },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });

    await timer.fire();
    assert.equal(action.undo(), false);

    assert.equal(timer.wasCancelled(), false);
    assert.deepEqual(calls, ['commit']);
  });
});

// Closing or reloading the tab ends the page before an undo window does: the actions still in
// one are run at once (pagehide, and before the screen locks), or they never reach the server.
describe('flushUndoables', () => {
  it('runs every action still in its undo window, once, and none that was undone', async () => {
    const ran = [];
    undoableAction.holdUndoable(() => ran.push('archive'), 60000);
    const moved = undoableAction.holdUndoable(() => ran.push('move'), 60000);
    undoableAction.releaseUndoable(moved);
    undoableAction.flushUndoables();
    undoableAction.flushUndoables();
    assert.deepEqual(ran, ['archive']);
  });

  it('runs a createUndoableCommit commit immediately, and its undo is then refused', async () => {
    const calls = [];
    const action = undoableAction.createUndoableCommit({
      delayMs: 60000,
      commit: async () => { calls.push('commit'); },
      undo: () => calls.push('undo'),
    });
    undoableAction.flushUndoables();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(action.undo(), false);
    assert.deepEqual(calls, ['commit']);
  });

  it('leaves an action that already ran alone', async () => {
    const ran = [];
    undoableAction.holdUndoable(() => ran.push('archive'), 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    undoableAction.flushUndoables();
    assert.deepEqual(ran, ['archive']);
  });
});

// A flush tells the action it is one, so an action that would read something first (a
// conversation) uses what it read when it was taken.
describe('a flushed createUndoableCommit', () => {
  it('is told it is flushing; its own timer is not', async () => {
    const seen = [];
    undoableAction.createUndoableCommit({ delayMs: 60000, commit: async (o) => { seen.push(o?.flushing ?? false); }, undo() {} });
    undoableAction.flushUndoables();
    undoableAction.createUndoableCommit({ delayMs: 1, commit: async (o) => { seen.push(o?.flushing ?? false); }, undo() {} });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(seen, [true, false]);
  });
});

describe('releaseUndoable', () => {
  it('says whether the action was still pending', () => {
    const pending = undoableAction.holdUndoable(() => {}, 60000);
    assert.equal(undoableAction.releaseUndoable(pending), true);
    const flushed = undoableAction.holdUndoable(() => {}, 60000);
    undoableAction.flushUndoables();
    assert.equal(undoableAction.releaseUndoable(flushed), false);
  });
});
