// Run with: node --test src/utils/inboxTriageUndo.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  UNDO_WINDOW_MS,
  createInboxTriageUndoMetadata,
  findLatestInboxTriageUndo,
  getUndoRemainingMs,
  isInboxTriageContext,
  registerInboxTriageUndoShortcut,
  scheduleInboxTriageUndoCommit,
} from './inboxTriageUndo.js';

const eligible = {
  selectedFolder: 'INBOX',
  searchQuery: '',
  activeGtdTab: null,
  selectedMessageId: 'next',
  displayedMessageIds: ['next', 'later'],
};

function createFakeShortcutBus() {
  const handlers = new Map();
  return {
    on(action, handler) {
      if (!handlers.has(action)) handlers.set(action, new Set());
      handlers.get(action).add(handler);
    },
    off(action, handler) {
      handlers.get(action)?.delete(handler);
    },
    emit(action) {
      for (const handler of handlers.get(action) || []) handler();
    },
    listenerCount(action) {
      return handlers.get(action)?.size || 0;
    },
  };
}

describe('isInboxTriageContext', () => {
  it('accepts the selected row in unified and account Inbox views', () => {
    assert.equal(isInboxTriageContext(eligible), true);
    assert.equal(isInboxTriageContext({ ...eligible, displayedMessageIds: new Set(['next', 'later']) }), true);
  });

  it('rejects contexts outside the displayed Inbox rows', () => {
    assert.equal(isInboxTriageContext({ ...eligible, searchQuery: 'from:test' }), false);
    assert.equal(isInboxTriageContext({ ...eligible, activeGtdTab: 'todo' }), false);
    assert.equal(isInboxTriageContext({ ...eligible, selectedFolder: 'Archive' }), false);
    assert.equal(isInboxTriageContext({ ...eligible, selectedMessageId: null }), false);
    assert.equal(isInboxTriageContext({ ...eligible, displayedMessageIds: ['other'] }), false);
  });

  it('re-evaluates live folder, search, GTD tab, and displayed-row transitions', () => {
    const transitions = [
      eligible,
      { ...eligible, selectedFolder: 'Archive' },
      { ...eligible, searchQuery: 'from:test' },
      { ...eligible, activeGtdTab: 'todo' },
      { ...eligible, selectedMessageId: 'removed', displayedMessageIds: ['next', 'later'] },
    ];

    assert.deepEqual(transitions.map(isInboxTriageContext), [true, false, false, false, false]);
  });
});

describe('Inbox triage undo metadata', () => {
  it('captures origin and action order without starting the undo deadline', () => {
    const metadata = createInboxTriageUndoMetadata(eligible);
    assert.equal(metadata.undoScope, 'inbox-triage');
    assert.equal(Number.isFinite(metadata.undoSequence), true);
    assert.equal('undoExpiresAt' in metadata, false);
    assert.deepEqual(createInboxTriageUndoMetadata({ ...eligible, searchQuery: 'status' }), {});
  });

  it('orders deferred GTD/archive completions by action initiation rather than insertion order', async () => {
    const delayedGtd = createInboxTriageUndoMetadata(eligible);
    const archive = createInboxTriageUndoMetadata(eligible);
    let finishGtd;
    const gtdResponse = new Promise(resolve => { finishGtd = resolve; });
    const notificationsInCompletionOrder = [{
      id: 'archive-completed-first',
      ...archive,
      undoExpiresAt: 10_000,
      onUndo() {},
    }];

    const classify = gtdResponse.then(() => {
      notificationsInCompletionOrder.unshift({
        id: 'gtd-completed-last',
        ...delayedGtd,
        undoExpiresAt: 10_000,
        onUndo() {},
      });
    });
    finishGtd();
    await classify;

    assert.equal(
      findLatestInboxTriageUndo(notificationsInCompletionOrder, 1_000)?.id,
      'archive-completed-first',
    );
  });

  it('creates metadata only for an eligible Inbox triage context', () => {
    const metadata = createInboxTriageUndoMetadata(eligible);
    assert.deepEqual(metadata, {
      undoScope: 'inbox-triage',
      undoSequence: metadata.undoSequence,
    });
    assert.deepEqual(createInboxTriageUndoMetadata({ ...eligible, searchQuery: 'status' }), {});
  });

  it('returns the newest unexpired Inbox triage notification', () => {
    assert.equal(findLatestInboxTriageUndo([
      { id: 'regular', onUndo() {} },
      { id: 'newest', undoScope: 'inbox-triage', undoExpiresAt: 5_000, onUndo() {} },
      { id: 'older', undoScope: 'inbox-triage', undoExpiresAt: 6_000, onUndo() {} },
    ], 2_000)?.id, 'newest');
  });

  it('rejects expired Inbox triage notifications at their expiry time', () => {
    assert.equal(findLatestInboxTriageUndo([
      { id: 'expired', undoScope: 'inbox-triage', undoExpiresAt: 2_000, onUndo() {} },
    ], 2_000), null);
  });

  it('skips newer unrelated and expired entries without mutating the rapid-action stack', () => {
    const notifications = [
      { id: 'regular', undoExpiresAt: 9_000, onUndo() {} },
      { id: 'expired', undoScope: 'inbox-triage', undoExpiresAt: 2_000, onUndo() {} },
      { id: 'newest-eligible', undoScope: 'inbox-triage', undoExpiresAt: 7_000, onUndo() {} },
      { id: 'older-eligible', undoScope: 'inbox-triage', undoExpiresAt: 6_000, onUndo() {} },
    ];
    const snapshot = [...notifications];

    assert.equal(findLatestInboxTriageUndo(notifications, 2_000)?.id, 'newest-eligible');
    assert.deepEqual(notifications, snapshot);
  });

  it('preserves the next eligible inverse after the newest one is consumed', () => {
    const notifications = [
      { id: 'newest', undoScope: 'inbox-triage', undoExpiresAt: 7_000, onUndo() {} },
      { id: 'older', undoScope: 'inbox-triage', undoExpiresAt: 6_000, onUndo() {} },
    ];
    const remaining = notifications.filter(notification => notification.id !== 'newest');

    assert.equal(findLatestInboxTriageUndo(remaining, 2_000)?.id, 'older');
    assert.equal(notifications.length, 2);
  });
});

describe('getUndoRemainingMs', () => {
  it('uses the absolute expiry and never returns a negative duration', () => {
    assert.equal(getUndoRemainingMs({ undoExpiresAt: 2_000 }, 1_500), 500);
    assert.equal(getUndoRemainingMs({ undoExpiresAt: 2_000 }, 2_000), 0);
    assert.equal(getUndoRemainingMs({ undoExpiresAt: 2_000 }, 2_500), 0);
  });
});

describe('scheduleInboxTriageUndoCommit', () => {
  it('gives the commit timer and inverse one exact deadline after preparation', () => {
    const times = [1_000, 1_025];
    let scheduledDelay;
    const callback = () => {};
    const timer = { id: 1 };

    const scheduled = scheduleInboxTriageUndoCommit(callback, { undoScope: 'inbox-triage' }, {
      now: () => times.shift(),
      setTimer: (fn, delay) => {
        assert.equal(fn, callback);
        scheduledDelay = delay;
        return timer;
      },
    });

    assert.equal(scheduled.undoMetadata.undoExpiresAt, 1_000 + UNDO_WINDOW_MS);
    assert.equal(scheduledDelay, UNDO_WINDOW_MS - 25);
    assert.equal(scheduled.timer, timer);
  });

  it('is used by every delayed MessageList inverse instead of literal 4500ms timers', () => {
    const source = readFileSync(new URL('../components/MessageList.jsx', import.meta.url), 'utf8');
    assert.equal((source.match(/scheduleInboxTriageUndoCommit\(/g) || []).length, 6);
    assert.equal(source.includes('}, 4500);'), false);
    assert.equal(source.includes('}, 4500));'), false);
  });
});

describe('registerInboxTriageUndoShortcut', () => {
  const undoNotification = (id) => ({
    id,
    undoScope: 'inbox-triage',
    undoExpiresAt: Number.MAX_SAFE_INTEGER,
    onUndo() {},
  });

  it('registers once and consumes rapid notifications newest first', () => {
    const bus = createFakeShortcutBus();
    const consumed = [];
    const state = {
      ...eligible,
      notifications: [undoNotification('newest'), undoNotification('older')],
      runNotificationUndo(id) {
        consumed.push(id);
        state.notifications = state.notifications.filter(notification => notification.id !== id);
      },
    };

    registerInboxTriageUndoShortcut({
      shortcutBus: bus,
      getState: () => state,
      getDisplayedMessageIds: () => state.displayedMessageIds,
    });

    assert.equal(bus.listenerCount('undo'), 1);
    bus.emit('undo');
    bus.emit('undo');
    assert.deepEqual(consumed, ['newest', 'older']);
  });

  it('blocks folder, search, GTD tab, missing-selection, and out-of-list contexts', () => {
    const bus = createFakeShortcutBus();
    const consumed = [];
    let state = { ...eligible, notifications: [undoNotification('candidate')] };
    state.runNotificationUndo = id => consumed.push(id);
    let displayedMessageIds = state.displayedMessageIds;
    registerInboxTriageUndoShortcut({
      shortcutBus: bus,
      getState: () => state,
      getDisplayedMessageIds: () => displayedMessageIds,
    });

    const blockedContexts = [
      { ...eligible, selectedFolder: 'Archive' },
      { ...eligible, searchQuery: 'from:test' },
      { ...eligible, activeGtdTab: 'todo' },
      { ...eligible, selectedMessageId: null },
      { ...eligible, selectedMessageId: 'removed' },
    ];
    for (const context of blockedContexts) {
      state = { ...state, ...context };
      displayedMessageIds = ['next', 'later'];
      bus.emit('undo');
    }

    assert.deepEqual(consumed, []);
  });

  it('reads state and displayed message ids again on every dispatch', () => {
    const bus = createFakeShortcutBus();
    const consumed = [];
    let state = {
      ...eligible,
      selectedFolder: 'Archive',
      notifications: [undoNotification('live')],
      runNotificationUndo: id => consumed.push(id),
    };
    let displayedMessageIds = ['stale'];
    registerInboxTriageUndoShortcut({
      shortcutBus: bus,
      getState: () => state,
      getDisplayedMessageIds: () => displayedMessageIds,
    });

    bus.emit('undo');
    state = { ...state, selectedFolder: 'INBOX', selectedMessageId: 'fresh' };
    displayedMessageIds = ['fresh'];
    bus.emit('undo');

    assert.deepEqual(consumed, ['live']);
  });

  it('removes the exact handler during cleanup', () => {
    const bus = createFakeShortcutBus();
    const consumed = [];
    const state = {
      ...eligible,
      notifications: [undoNotification('candidate')],
      runNotificationUndo: id => consumed.push(id),
    };
    const cleanup = registerInboxTriageUndoShortcut({
      shortcutBus: bus,
      getState: () => state,
      getDisplayedMessageIds: () => state.displayedMessageIds,
    });

    cleanup();
    assert.equal(bus.listenerCount('undo'), 0);
    bus.emit('undo');
    assert.deepEqual(consumed, []);
  });
});
