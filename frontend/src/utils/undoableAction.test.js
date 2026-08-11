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
