import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithUndo, undoLatestGtdNotification } from './classification.js';

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
    assert.equal(harness.calls.refresh, 0);
    assert.equal(harness.notifications[0].type, 'error');
    assert.equal(harness.notifications[0].title, 'gtd.classifyFailed');
  });
});

describe('undoLatestGtdNotification', () => {
  it('removes and invokes only the newest GTD undo notification', () => {
    const invoked = [];
    const notifications = [
      { id: 'unrelated', onUndo: () => invoked.push('unrelated') },
      { id: 'newest-gtd', pluginId: 'gtd', onUndo: () => invoked.push('newest-gtd') },
      { id: 'older-gtd', pluginId: 'gtd', onUndo: () => invoked.push('older-gtd') },
    ];
    const removed = [];

    const handled = undoLatestGtdNotification(notifications, id => removed.push(id));

    assert.equal(handled, true);
    assert.deepEqual(removed, ['newest-gtd']);
    assert.deepEqual(invoked, ['newest-gtd']);
  });

  it('is a no-op without a GTD undo notification', () => {
    const handled = undoLatestGtdNotification(
      [{ id: 'regular', pluginId: 'gtd' }, { id: 'other', onUndo: () => {} }],
      () => assert.fail('must not remove a notification'),
    );

    assert.equal(handled, false);
  });
});
