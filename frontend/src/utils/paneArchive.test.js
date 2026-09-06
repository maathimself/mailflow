import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startPaneArchive } from './paneArchive.js';
import { applyDeleteGuard, clearDeleteGuard } from './pendingDeletes.js';

function fakeTimer() {
  let callback;
  let cancelled = false;
  return {
    schedule(fn) { callback = fn; return 'timer'; },
    cancel() { cancelled = true; },
    async fire() { return callback(); },
    wasCancelled() { return cancelled; },
  };
}

function harness({ archive } = {}) {
  const message = { id: 'm1', account_id: 'a1', is_read: false, date: '2026-01-01T00:00:00Z' };
  const calls = [];
  const timer = fakeTimer();
  const action = startPaneArchive({
    message,
    archive: archive || (async () => ({ ok: true, archived: ['m1'], noArchiveFolder: [] })),
    removeMessage: (id) => calls.push(['remove', id]),
    restoreMessages: (msgs) => calls.push(['restore', msgs.map(m => m.id)]),
    decrementUnread: (accountId, n = 1) => calls.push(['dec', accountId, n]),
    incrementUnread: (accountId, n = 1) => calls.push(['inc', accountId, n]),
    onNoArchiveFolder: () => calls.push(['noArchiveFolder']),
    onError: () => calls.push(['error']),
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  return { message, calls, timer, action };
}

describe('startPaneArchive', () => {
  afterEach(() => clearDeleteGuard('m1'));

  it('hides the message from list refreshes while the undo window is open', () => {
    const { message, calls } = harness();
    assert.deepEqual(calls, [['remove', 'm1'], ['dec', 'a1', 1]]);
    // A sync-triggered refresh returning the still-unarchived server copy must not resurface it.
    assert.deepEqual(applyDeleteGuard([message]), []);
  });

  it('keeps the message hidden after the server confirms the archive', async () => {
    const { message, timer, calls } = harness();
    await timer.fire();
    assert.deepEqual(applyDeleteGuard([message]), []);
    assert.deepEqual(calls.slice(2), []);
  });

  it('undo clears the guard and restores the message and unread count', () => {
    const { message, timer, calls, action } = harness();
    assert.equal(action.undo(), true);
    assert.equal(timer.wasCancelled(), true);
    assert.deepEqual(applyDeleteGuard([message]), [message]);
    assert.deepEqual(calls.slice(2), [['restore', ['m1']], ['inc', 'a1', 1]]);
  });

  it('restores the message when the archive request fails', async () => {
    const { message, timer, calls } = harness({ archive: async () => { throw new Error('boom'); } });
    await timer.fire();
    assert.deepEqual(applyDeleteGuard([message]), [message]);
    assert.deepEqual(calls.slice(2), [['restore', ['m1']], ['inc', 'a1', 1], ['error']]);
  });

  it('restores the message when the account has no archive folder', async () => {
    const { message, timer, calls } = harness({
      archive: async () => ({ ok: true, archived: [], noArchiveFolder: ['m1'] }),
    });
    await timer.fire();
    assert.deepEqual(applyDeleteGuard([message]), [message]);
    assert.deepEqual(calls.slice(2), [['restore', ['m1']], ['inc', 'a1', 1], ['noArchiveFolder']]);
  });
});
