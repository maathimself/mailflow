import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithUndo } from './classification.js';

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
