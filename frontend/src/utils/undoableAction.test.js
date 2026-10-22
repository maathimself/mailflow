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

describe('undoLatestNotification', () => {
  it('removes and invokes only the newest undoable notification', () => {
    const invoked = [];
    const notifications = [
      { id: 'info' },
      { id: 'newest', onUndo: () => invoked.push('newest') },
      { id: 'older-gtd', pluginId: 'gtd', onUndo: () => invoked.push('older-gtd') },
    ];
    const removed = [];

    const handled = undoableAction.undoLatestNotification(notifications, id => removed.push(id));

    assert.equal(handled, true);
    assert.deepEqual(removed, ['newest']);
    assert.deepEqual(invoked, ['newest']);
  });

  it('is a no-op without an undoable notification', () => {
    const handled = undoableAction.undoLatestNotification(
      [{ id: 'regular', pluginId: 'gtd' }],
      () => assert.fail('must not remove a notification'),
    );

    assert.equal(handled, false);
  });
});
