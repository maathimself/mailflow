import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithUndo } from './gtdClassification.js';

function createHarness(classifyResult = {}) {
  const notifications = [];
  const calls = { classify: [], undo: [], refresh: 0, removed: [] };
  const api = {
    gtdClassify: async (...args) => {
      calls.classify.push(args);
      return classifyResult;
    },
    gtdUndoClassify: async token => {
      calls.undo.push(token);
      return { ok: true, removed: true };
    },
  };
  const store = {
    addNotification: notification => notifications.unshift({ id: `n-${notifications.length + 1}`, ...notification }),
    scheduleGtdSectionsFetch: () => { calls.refresh += 1; },
    dismissUndoNotifications: () => {
      const regular = notifications.filter(n => typeof n.onUndo !== 'function');
      notifications.splice(0, notifications.length, ...regular);
    },
    messages: [{ id: 'message-1' }, { id: 'message-2' }],
    searchResults: [{ id: 'message-1' }],
    removeMessage: id => {
      calls.removed.push(id);
      store.messages = store.messages.filter(row => row.id !== id);
      store.searchResults = store.searchResults.filter(row => row.id !== id);
      if (store.selectedMessageId === id) store.selectedMessageId = null;
    },
    selectedMessageId: 'message-1',
    setSelectedMessage: id => { store.selectedMessageId = id; },
  };
  const t = key => key;
  return { api, store, t, notifications, calls };
}

describe('classifyWithUndo', () => {
  it('offers an exact, one-shot undo when classification created a label copy', async () => {
    const undoToken = {
      messageId: '2e8749a4-f5e5-4ee1-a49c-f93e4a27d39b',
      state: 'todo',
      folder: 'GTD/Todo',
      uid: 902,
    };
    const harness = createHarness({ ok: true, applied: true, undoToken });

    await classifyWithUndo('message-1', 'todo', harness);

    assert.deepEqual(harness.calls.classify, [['message-1', 'todo']]);
    assert.equal(harness.calls.refresh, 1);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].pluginId, 'gtd');
    assert.equal(typeof harness.notifications[0].onUndo, 'function');

    await harness.notifications[0].onUndo();
    await harness.notifications[0].onUndo();

    assert.deepEqual(harness.calls.undo, [undoToken]);
    assert.equal(harness.calls.refresh, 2);
  });

  it('uses a regular notification when the server cannot issue an undo token', async () => {
    const harness = createHarness({ ok: true, applied: true, undoToken: null });

    await classifyWithUndo('message-1', 'watch', harness);

    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].pluginId, 'gtd');
    assert.equal(harness.notifications[0].onUndo, undefined);
  });

  it('reports undo failures without refreshing the GTD sections', async () => {
    const undoToken = {
      messageId: '2e8749a4-f5e5-4ee1-a49c-f93e4a27d39b',
      state: 'delegated',
      folder: 'GTD/Delegated',
      uid: 903,
    };
    const harness = createHarness({ ok: true, applied: true, undoToken });
    harness.api.gtdUndoClassify = async () => { throw new Error('offline'); };

    await classifyWithUndo('message-1', 'delegated', harness);
    await harness.notifications[0].onUndo();

    assert.equal(harness.calls.refresh, 1);
    assert.equal(harness.notifications[0].type, 'error');
    assert.equal(harness.notifications[0].title, 'gtd.undoFailed');
  });

  it('preserves the existing classification failure notification', async () => {
    const harness = createHarness();
    harness.api.gtdClassify = async () => { throw new Error('offline'); };

    const result = await classifyWithUndo('message-1', 'todo', harness);

    assert.equal(result, null);
    assert.equal(harness.calls.refresh, 1);
    assert.equal(harness.notifications[0].type, 'error');
    assert.equal(harness.notifications[0].title, 'gtd.classifyFailed');
  });
});


describe('GTD state switch safety', () => {
  it('ends older GTD and unrelated Undo windows but keeps regular notifications', async () => {
    const harness = createHarness({ applied: true, switched: true, sourceRemoved: false });
    const invoked = [];
    harness.notifications.push(
      { id: 'todo', pluginId: 'gtd', onUndo: () => invoked.push('todo') },
      { id: 'archive-b', onUndo: () => invoked.push('archive-b') },
      { id: 'regular', title: 'background update' },
    );
    await classifyWithUndo('message-1', 'watch', harness);
    assert.equal(harness.notifications.some(n => typeof n.onUndo === 'function'), false);
    assert.equal(harness.notifications.some(n => n.id === 'regular'), true);
    harness.notifications.shift(); // switch toast dismissed or expired
    harness.notifications.find(n => n.onUndo)?.onUndo();
    assert.deepEqual(invoked, []);
  });

  it('keeps a scheduled archive committing after its Undo window is ended', async () => {
    const harness = createHarness({ applied: true, switched: true });
    const { createUndoableCommit } = await import('./undoableAction.js');
    const calls = [];
    let commit;
    const archive = createUndoableCommit({
      schedule: fn => { commit = fn; return 1; },
      cancel: () => assert.fail('archive must still commit'),
      commit: () => calls.push('archive-b'), undo: () => calls.push('undo-b'),
    });
    harness.notifications.push({ id: 'archive-b', onUndo: archive.undo });
    await classifyWithUndo('message-1', 'watch', harness);
    await commit();
    assert.deepEqual(calls, ['archive-b']);
    assert.equal(harness.notifications.some(n => n.id === 'archive-b'), false);
  });

  it('ends stale undo and refreshes sections on an uncertain mutation failure', async () => {
    const harness = createHarness();
    harness.notifications.push({ id: 'stale', onUndo: () => assert.fail('stale undo') });
    harness.api.gtdClassify = async () => { throw new Error('disconnected after EXPUNGE'); };
    await classifyWithUndo('message-1', 'watch', harness);
    assert.equal(harness.notifications.some(n => n.onUndo), false);
    assert.equal(harness.calls.refresh, 1);
    assert.equal(harness.store.selectedMessageId, null);
    assert.deepEqual(harness.calls.removed, []);
  });

  it('suppresses a second shortcut while its source classification is in flight', async () => {
    const harness = createHarness();
    let finish;
    harness.api.gtdClassify = async (...args) => {
      harness.calls.classify.push(args);
      return new Promise(resolve => { finish = resolve; });
    };
    const first = classifyWithUndo('message-1', 'todo', harness);
    const second = classifyWithUndo('message-1', 'watch', harness);
    assert.equal(harness.calls.classify.length, 1);
    finish({ applied: true, switched: true, sourceRemoved: true });
    await Promise.all([first, second]);
    assert.equal(harness.store.selectedMessageId, null);
    assert.equal(harness.notifications.length, 1);
  });

  it('preserves a new unrelated selection while removing the former source selection', async () => {
    const harness = createHarness();
    let finish;
    harness.api.gtdClassify = () => new Promise(resolve => { finish = resolve; });
    const pending = classifyWithUndo('message-1', 'watch', harness);
    harness.store.selectedMessageId = 'message-2';
    finish({ applied: true, switched: true, sourceRemoved: true });
    await pending;
    assert.equal(harness.store.selectedMessageId, 'message-2');
    assert.deepEqual(harness.calls.removed, ['message-1']);
    assert.deepEqual(harness.store.messages, [{ id: 'message-2' }]);
    assert.deepEqual(harness.store.searchResults, []);
  });

  it('still offers Undo for a new additive classification after a switch', async () => {
    const harness = createHarness({ switched: true });
    await classifyWithUndo('message-1', 'watch', harness);
    harness.api.gtdClassify = async () => ({ applied: true, undoToken: { uid: 78 } });
    await classifyWithUndo('message-2', 'todo', harness);
    assert.equal(typeof harness.notifications[0].onUndo, 'function');
  });
});
