import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithUndo, classifyManyWithUndo } from './gtdClassification.js';
import {
  beginGtdClassification, endGtdClassification,
  rememberGtdRailSelection, clearGtdRailSelection, getGtdRailSelection,
} from './gtdHotkeys.js';

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
    dismissUndoNotifications: (matches = () => true) => {
      const regular = notifications.filter(n => typeof n.onUndo !== 'function' || !matches(n));
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
  it('ends this source GTD Undo but keeps unrelated Undo and regular notifications', async () => {
    const harness = createHarness({ applied: true, switched: true, sourceRemoved: false });
    const invoked = [];
    harness.notifications.push(
      { id: 'todo', pluginId: 'gtd', gtdUndoScope: { messageId: 'message-1' }, onUndo: () => invoked.push('todo') },
      { id: 'archive-b', onUndo: () => invoked.push('archive-b') },
      { id: 'regular', title: 'background update' },
    );
    await classifyWithUndo('message-1', 'watch', harness);
    assert.deepEqual(harness.notifications.filter(n => n.onUndo).map(n => n.id), ['archive-b']);
    assert.equal(harness.notifications.some(n => n.id === 'regular'), true);
    harness.notifications.shift(); // switch toast dismissed or expired
    harness.notifications.find(n => n.onUndo)?.onUndo();
    assert.deepEqual(invoked, ['archive-b']);
  });

  it('keeps an unrelated archive Undo window and lets its scheduled commit run', async () => {
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
    assert.equal(harness.notifications.some(n => n.id === 'archive-b'), true);
  });

  it('ends stale undo and refreshes sections on an uncertain mutation failure', async () => {
    const harness = createHarness();
    harness.notifications.push({ id: 'stale', pluginId: 'gtd', gtdUndoScope: { messageId: 'message-1' }, onUndo: () => assert.fail('stale undo') });
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

describe('classifyManyWithUndo', () => {
  const messages = [
    { id: 'm1', account_id: 'a1', thread_key: 't1' },
    { id: 'm2', account_id: 'a1', thread_key: 't2' },
    { id: 'm3', account_id: 'a1', thread_id: 't3' },
  ];

  function createManyHarness(results = {}) {
    const harness = createHarness();
    harness.api.gtdClassify = async (...args) => {
      harness.calls.classify.push(args);
      const result = results[args[0]];
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result() : result;
    };
    const tCalls = [];
    harness.t = (key, args) => { tCalls.push([key, args]); return key; };
    harness.tCalls = tCalls;
    return harness;
  }

  const applied = id => ({ applied: true, undoToken: { messageId: id } });

  it('classifies one message at a time', async () => {
    const pending = {};
    const harness = createManyHarness({
      m1: () => new Promise(resolve => { pending.m1 = resolve; }),
      m2: () => new Promise(resolve => { pending.m2 = resolve; }),
    });
    const run = classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(harness.calls.classify.map(([id]) => id), ['m1']);
    pending.m1(applied('m1'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(harness.calls.classify.map(([id]) => id), ['m1', 'm2']);
    pending.m2(applied('m2'));
    assert.deepEqual(await run, { tagged: 2, total: 2 });
  });

  it('posts a single notification with the count', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: applied('m2'), m3: applied('m3') });
    await classifyManyWithUndo(messages, 'reference', harness);
    assert.equal(harness.notifications.length, 1);
    const [notification] = harness.notifications;
    assert.equal(notification.title, 'gtd.classifiedMany');
    assert.equal(notification.pluginId, 'gtd');
    assert.equal(typeof notification.onUndo, 'function');
    assert.equal(notification.gtdUndoScope, undefined);
    assert.deepEqual(
      harness.tCalls.find(([key]) => key === 'gtd.classifiedMany')[1],
      { count: 3, state: 'gtd.state.reference' },
    );
    assert.equal(harness.calls.refresh, 1);
  });

  it('keeps going after a failure and counts honestly', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: new Error('offline'), m3: applied('m3') });
    const result = await classifyManyWithUndo(messages, 'watch', harness);
    assert.deepEqual(harness.calls.classify.map(([id]) => id), ['m1', 'm2', 'm3']);
    assert.deepEqual(result, { tagged: 2, total: 3 });
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].title, 'gtd.classifiedSome');
    assert.deepEqual(
      harness.tCalls.find(([key]) => key === 'gtd.classifiedSome')[1],
      { count: 2, total: 3, state: 'gtd.state.watch' },
    );
  });

  it('a failure ends that thread\'s older GTD undo and clears its selection', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: new Error('disconnected after EXPUNGE') });
    harness.store.selectedMessageId = 'm2';
    harness.notifications.push(
      { id: 'old-t2', pluginId: 'gtd', gtdUndoScope: { messageId: 'x', accountId: 'a1', threadKey: 't2' }, onUndo: () => {} },
      { id: 'old-t9', pluginId: 'gtd', gtdUndoScope: { messageId: 'y', accountId: 'a1', threadKey: 't9' }, onUndo: () => {} },
    );
    await classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
    assert.deepEqual(harness.notifications.filter(n => n.id?.startsWith('old-')).map(n => n.id), ['old-t9']);
    assert.equal(harness.store.selectedMessageId, null);
    assert.deepEqual(harness.calls.removed, []);
  });

  it('undo reverses only successes, newest first, once', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: new Error('offline'), m3: applied('m3') });
    await classifyManyWithUndo(messages, 'todo', harness);
    const { onUndo } = harness.notifications[0];
    assert.equal(await onUndo(), true);
    assert.deepEqual(harness.calls.undo, [{ messageId: 'm3' }, { messageId: 'm1' }]);
    assert.equal(await onUndo(), false);
    assert.equal(harness.calls.undo.length, 2);
  });

  it('skips a message already being classified', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: applied('m2'), m3: applied('m3') });
    assert.equal(beginGtdClassification('m2'), true);
    try {
      const result = await classifyManyWithUndo(messages, 'todo', harness);
      assert.deepEqual(harness.calls.classify.map(([id]) => id), ['m1', 'm3']);
      assert.deepEqual(result, { tagged: 2, total: 3 });
      assert.equal(harness.notifications[0].title, 'gtd.classifiedSome');
    } finally {
      endGtdClassification('m2');
    }
  });

  it('zero successes shows the error toast', async () => {
    const harness = createManyHarness({ m1: new Error('a'), m2: new Error('b'), m3: new Error('c') });
    const result = await classifyManyWithUndo(messages, 'someday', harness);
    assert.deepEqual(result, { tagged: 0, total: 3 });
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].type, 'error');
    assert.equal(harness.notifications[0].title, 'gtd.classifyFailed');
    assert.equal(harness.notifications[0].onUndo, undefined);
  });

  it('does nothing for an empty selection', async () => {
    const harness = createManyHarness();
    const result = await classifyManyWithUndo([], 'todo', harness);
    assert.deepEqual(result, { tagged: 0, total: 0 });
    assert.deepEqual(harness.calls.classify, []);
    assert.equal(harness.calls.refresh, 0);
    assert.deepEqual(harness.notifications, []);
  });

  it('a failed undo still reverses the older tags and reports once', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: applied('m2'), m3: applied('m3') });
    await classifyManyWithUndo(messages, 'watch', harness);
    const attempted = [];
    harness.api.gtdUndoClassify = async token => {
      attempted.push(token.messageId);
      if (token.messageId !== 'm1') throw new Error('offline');
    };
    assert.equal(await harness.notifications[0].onUndo(), false);
    assert.deepEqual(attempted, ['m3', 'm2', 'm1']);
    assert.equal(harness.notifications.filter(n => n.title === 'gtd.undoFailed').length, 1);
  });

  it('a failed undo shows undoFailed', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: applied('m2') });
    await classifyManyWithUndo(messages.slice(0, 2), 'delegated', harness);
    harness.api.gtdUndoClassify = async () => { throw new Error('offline'); };
    assert.equal(await harness.notifications[0].onUndo(), false);
    assert.equal(harness.notifications[0].type, 'error');
    assert.equal(harness.notifications[0].title, 'gtd.undoFailed');
  });

  it('sourceRemoved removes that row and clears its selection', async () => {
    const harness = createManyHarness({ m1: { applied: true, sourceRemoved: true }, m2: applied('m2') });
    harness.store.messages = [{ id: 'm1' }, { id: 'm2' }];
    harness.store.removeMessage = id => {
      harness.calls.removed.push(id);
      harness.store.messages = harness.store.messages.filter(row => row.id !== id);
    };
    harness.store.selectedMessageId = 'm1';
    rememberGtdRailSelection({ id: 'm1' }, 'todo');
    try {
      await classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
      assert.deepEqual(harness.calls.removed, ['m1']);
      assert.deepEqual(harness.store.messages, [{ id: 'm2' }]);
      assert.equal(harness.store.selectedMessageId, null);
      assert.equal(getGtdRailSelection(), null);
    } finally {
      clearGtdRailSelection('m1');
    }
  });

  it('counts an already-labelled message as tagged, without an undo for it', async () => {
    const harness = createManyHarness({
      m1: { ok: true, applied: false, undoToken: null },
      m2: { ok: true, applied: false, undoToken: null },
    });
    const result = await classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
    assert.deepEqual(result, { tagged: 2, total: 2 });
    assert.equal(harness.notifications[0].title, 'gtd.classifiedMany');
    assert.equal(harness.notifications[0].onUndo, undefined);
  });

  it('offers no Undo when one message switched state, since Undo could not restore it', async () => {
    const harness = createManyHarness({
      m1: { ok: true, applied: true, undoToken: null, switched: true, sourceRemoved: false },
      m2: applied('m2'),
    });
    const result = await classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
    assert.deepEqual(result, { tagged: 2, total: 2 });
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].title, 'gtd.classifiedMany');
    assert.equal(harness.notifications[0].onUndo, undefined);
    assert.equal(harness.notifications[0].gtdUndoScopes, undefined);
  });

  it('offers no Undo when one copy came back without an undo token', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: { ok: true, applied: true, undoToken: null } });
    await classifyManyWithUndo(messages.slice(0, 2), 'watch', harness);
    assert.equal(harness.notifications[0].onUndo, undefined);
  });

  it('tags a message listed twice only once', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: applied('m2') });
    const result = await classifyManyWithUndo([messages[0], messages[1], { ...messages[0] }], 'todo', harness);
    assert.deepEqual(harness.calls.classify.map(([id]) => id), ['m1', 'm2']);
    assert.deepEqual(result, { tagged: 2, total: 2 });
    assert.equal(harness.notifications[0].title, 'gtd.classifiedMany');
  });

  it('scopes the bulk undo to every tag it can undo', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: new Error('offline'), m3: applied('m3') });
    await classifyManyWithUndo(messages, 'todo', harness);
    assert.deepEqual(harness.notifications[0].gtdUndoScopes, [
      { messageId: 'm1', accountId: 'a1', threadKey: 't1' },
      { messageId: 'm3', accountId: 'a1', threadKey: 't3' },
    ]);
  });

  it('a later switch of one tagged thread ends the bulk undo', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: applied('m2') });
    await classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
    harness.notifications.push({ id: 'other', pluginId: 'gtd', gtdUndoScope: { messageId: 'z', accountId: 'a1', threadKey: 't9' }, onUndo: () => {} });
    harness.api.gtdClassify = async () => ({ applied: true, switched: true, undoToken: { messageId: 'm2b' } });
    await classifyWithUndo('m2b', 'watch', { ...harness, message: { id: 'm2b', account_id: 'a1', thread_key: 't2' } });
    assert.deepEqual(harness.notifications.filter(n => n.title === 'gtd.classifiedMany'), []);
    assert.equal(harness.notifications.some(n => n.id === 'other'), true);
  });

  it('a switch of an already-labelled thread keeps the bulk undo', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: { ok: true, applied: false, undoToken: null } });
    await classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
    assert.deepEqual(harness.notifications[0].gtdUndoScopes, [{ messageId: 'm1', accountId: 'a1', threadKey: 't1' }]);
    harness.api.gtdClassify = async () => ({ applied: true, switched: true, undoToken: { messageId: 'm2b' } });
    await classifyWithUndo('m2b', 'watch', { ...harness, message: { id: 'm2b', account_id: 'a1', thread_key: 't2' } });
    assert.equal(harness.notifications.filter(n => n.title === 'gtd.classifiedMany').length, 1);
  });

  it('a switch of an untagged thread keeps the bulk undo', async () => {
    const harness = createManyHarness({ m1: applied('m1'), m2: new Error('offline') });
    await classifyManyWithUndo(messages.slice(0, 2), 'todo', harness);
    harness.api.gtdClassify = async () => ({ applied: true, switched: true, undoToken: { messageId: 'm2b' } });
    await classifyWithUndo('m2b', 'watch', { ...harness, message: { id: 'm2b', account_id: 'a1', thread_key: 't2' } });
    assert.equal(harness.notifications.filter(n => n.title === 'gtd.classifiedSome').length, 1);
  });

  it('switched ends only that thread\'s older GTD undo', async () => {
    const harness = createManyHarness({ m1: { applied: true, switched: true, undoToken: { messageId: 'm1' } }, m2: applied('m2') });
    harness.notifications.push(
      { id: 'old-t1', pluginId: 'gtd', gtdUndoScope: { messageId: 'other', accountId: 'a1', threadKey: 't1' }, onUndo: () => {} },
      { id: 'old-t2', pluginId: 'gtd', gtdUndoScope: { messageId: 'x', accountId: 'a1', threadKey: 't2' }, onUndo: () => {} },
    );
    await classifyManyWithUndo(messages.slice(0, 2), 'watch', harness);
    assert.deepEqual(harness.notifications.filter(n => n.id?.startsWith('old-')).map(n => n.id), ['old-t2']);
  });
});
