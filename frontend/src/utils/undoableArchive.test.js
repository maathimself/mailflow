import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNDO_WINDOW_MS } from './inboxTriageUndo.js';
import { scheduleUndoableArchive } from './undoableArchive.js';

const message = {
  id: 42,
  account_id: 7,
  subject: 'Needs attention',
  is_read: false,
};

function setup(archiveResult = { archived: [message.id], noArchiveFolder: [] }, initialNow = 1_000) {
  const calls = [];
  let timerCallback;
  let timerDelay;
  let addedNotification;
  const timerToken = { timer: true };
  let now = initialNow;

  const dependencies = {
    archive: async (id) => {
      calls.push(['archive', id]);
      if (archiveResult instanceof Error) throw archiveResult;
      return archiveResult;
    },
    invalidate: () => calls.push(['invalidate']),
    markPending: (id) => calls.push(['markPending', id]),
    advanceSelection: (id) => calls.push(['advanceSelection', id]),
    removeMessage: (id) => calls.push(['removeMessage', id]),
    restoreMessage: (restoredMessage) => calls.push(['restoreMessage', restoredMessage]),
    decrementUnread: (accountId) => calls.push(['decrementUnread', accountId]),
    incrementUnread: (accountId) => calls.push(['incrementUnread', accountId]),
    clearPending: (id) => calls.push(['clearPending', id]),
    clearGuard: (id) => calls.push(['clearGuard', id]),
    completeGuard: (id) => calls.push(['completeGuard', id]),
    addNotification: (notification) => {
      calls.push(['addNotification']);
      addedNotification = notification;
    },
    notifyNoFolder: () => calls.push(['notifyNoFolder']),
    notifyFailure: () => calls.push(['notifyFailure']),
    notification: { title: 'Archived', body: message.subject },
    undoMetadata: { undoScope: 'inbox-triage', undoSequence: 7 },
    now: () => now,
    setTimer: (callback, delay) => {
      calls.push(['setTimer', delay]);
      timerCallback = callback;
      timerDelay = delay;
      return timerToken;
    },
    clearTimer: (token) => calls.push(['clearTimer', token]),
  };

  scheduleUndoableArchive(message, dependencies);
  return {
    calls,
    dependencies,
    get notification() { return addedNotification; },
    get timerCallback() { return timerCallback; },
    get timerDelay() { return timerDelay; },
    timerToken,
    setNow(value) { now = value; },
  };
}

describe('scheduleUndoableArchive', () => {
  it('optimistically hides and guards the message before offering undo', () => {
    const state = setup();

    assert.deepEqual(state.calls, [
      ['invalidate'],
      ['markPending', message.id],
      ['advanceSelection', message.id],
      ['removeMessage', message.id],
      ['decrementUnread', message.account_id],
      ['setTimer', UNDO_WINDOW_MS],
      ['addNotification'],
    ]);
    assert.equal(state.timerDelay, UNDO_WINDOW_MS);
    assert.deepEqual(
      { ...state.notification, onUndo: undefined },
      {
        title: 'Archived',
        body: message.subject,
        undoScope: 'inbox-triage',
        undoSequence: 7,
        undoExpiresAt: 1_000 + UNDO_WINDOW_MS,
        onUndo: undefined,
      },
    );
    assert.equal(typeof state.notification.onUndo, 'function');
  });

  it('cancels the commit and repairs optimistic state without changing selection', () => {
    const state = setup();
    const callsBeforeUndo = state.calls.length;

    state.notification.onUndo();

    assert.deepEqual(state.calls.slice(callsBeforeUndo), [
      ['clearTimer', state.timerToken],
      ['clearPending', message.id],
      ['restoreMessage', message],
      ['incrementUnread', message.account_id],
    ]);
    assert.equal(
      state.calls.filter(([name]) => name === 'advanceSelection').length,
      1,
    );
  });

  it('makes undo idempotent', () => {
    const state = setup();

    state.notification.onUndo();
    state.notification.onUndo();

    assert.equal(state.calls.filter(([name]) => name === 'clearPending').length, 1);
    assert.equal(state.calls.filter(([name]) => name === 'restoreMessage').length, 1);
    assert.equal(state.calls.filter(([name]) => name === 'incrementUnread').length, 1);
  });

  it('expires the inverse at the exact instant commit begins', async () => {
    const state = setup();
    state.setNow(state.notification.undoExpiresAt);

    await state.timerCallback();
    const callsAfterCommit = state.calls.length;
    state.notification.onUndo();

    assert.deepEqual(state.calls.slice(-2), [
      ['archive', message.id],
      ['completeGuard', message.id],
    ]);
    assert.equal(state.calls.length, callsAfterCommit);
  });

  it('completes the guard only when the archive result includes the message id', async () => {
    const state = setup();

    await state.timerCallback();

    assert.deepEqual(state.calls.slice(-2), [
      ['archive', message.id],
      ['completeGuard', message.id],
    ]);
  });

  it('restores and repairs the guard when the account has no archive folder', async () => {
    const state = setup({ archived: [], noArchiveFolder: ['account'] });

    await state.timerCallback();

    assert.deepEqual(state.calls.slice(-5), [
      ['archive', message.id],
      ['clearGuard', message.id],
      ['restoreMessage', message],
      ['incrementUnread', message.account_id],
      ['notifyNoFolder'],
    ]);
  });

  it('treats a missing archived id as a failure even without a no-folder result', async () => {
    const state = setup({ archived: [], noArchiveFolder: [] });

    await state.timerCallback();

    assert.deepEqual(state.calls.slice(-5), [
      ['archive', message.id],
      ['clearGuard', message.id],
      ['restoreMessage', message],
      ['incrementUnread', message.account_id],
      ['notifyFailure'],
    ]);
  });

  it('restores and repairs the guard when archiving rejects', async () => {
    const state = setup(new Error('offline'));

    await state.timerCallback();

    assert.deepEqual(state.calls.slice(-5), [
      ['archive', message.id],
      ['clearGuard', message.id],
      ['restoreMessage', message],
      ['incrementUnread', message.account_id],
      ['notifyFailure'],
    ]);
  });
});
