import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');
const { classifyWithUndo } = await import('../utils/gtdClassification.js');

test('ending Undo windows removes callbacks atomically and retains regular notifications', () => {
  useStore.setState({ notifications: [
    { id: 'todo', pluginId: 'gtd', onUndo: () => {} },
    { id: 'archive', onUndo: () => {} },
    { id: 'regular', title: 'background update' },
  ] });
  let updates = 0;
  const unsubscribe = useStore.subscribe(() => updates++);
  assert.equal(typeof useStore.getState().dismissUndoNotifications, 'function');
  useStore.getState().dismissUndoNotifications();
  unsubscribe();
  assert.deepEqual(useStore.getState().notifications, [{ id: 'regular', title: 'background update' }]);
  assert.equal(updates, 1);
});

test('scoped dismissal preserves other Undo callbacks and regular notifications atomically', () => {
  const otherUndo = { id: 'archive', onUndo: () => {} };
  const regular = { id: 'regular', title: 'background update' };
  useStore.setState({ notifications: [
    { id: 'todo', pluginId: 'gtd', onUndo: () => {} }, otherUndo, regular,
  ] });
  let updates = 0;
  const unsubscribe = useStore.subscribe(() => updates++);
  useStore.getState().dismissUndoNotifications(n => n.id === 'todo');
  unsubscribe();
  assert.deepEqual(useStore.getState().notifications, [otherUndo, regular]);
  assert.equal(updates, 1);
});

function classificationHarness() {
  useStore.setState({ notifications: [], messages: [], searchResults: [], selectedMessageId: null });
  const copies = new Set();
  const store = { getState: () => ({ ...useStore.getState(), scheduleGtdSectionsFetch() {} }) };
  const classify = (message, result, mutate = () => {}) => classifyWithUndo(message.id, 'todo', {
    message, store, t: key => key,
    api: {
      gtdClassify: async () => { mutate(); return result; },
      gtdUndoClassify: async token => { copies.delete(token.uid); },
    },
  });
  const addCopy = async (message, uid) => {
    copies.add(uid);
    await classify(message, { applied: true, undoToken: { messageId: message.id, state: 'todo', folder: 'Todo', uid } });
    return useStore.getState().notifications[0];
  };
  return { copies, classify, addCopy };
}

test('switching A keeps delete B Undo and GTD Undo for other threads and accounts', async () => {
  const harness = classificationHarness();
  const a = { id: 'a-inbox', account_id: 'account-a', thread_id: 'thread-a' };
  const b = { id: 'b-inbox', account_id: 'account-a', thread_id: 'thread-b' };
  const c = { id: 'c-inbox', account_id: 'account-c', thread_id: 'thread-a' };
  const stale = await harness.addCopy(a, 11);
  const bUndo = await harness.addCopy(b, 22);
  const cUndo = await harness.addCopy(c, 33);
  const deleted = { id: 'deleted-b', account_id: 'account-a', thread_id: 'thread-b' };
  useStore.getState().addNotification({ title: 'Deleted B', onUndo: () => useStore.getState().restoreMessages([deleted]) });
  const deleteUndo = useStore.getState().notifications[0];

  // The filed row is a different member of A, absent from the main list.
  await harness.classify({ id: 'a-filed', account_id: a.account_id, thread_key: a.thread_id }, { switched: true, sourceRemoved: true });

  const pending = useStore.getState().notifications.filter(n => n.onUndo);
  assert.deepEqual(pending.map(n => n.id), [deleteUndo.id, cUndo.id, bUndo.id]);
  assert.equal(useStore.getState().notifications.some(n => n.id === stale.id), false);
  const latest = useStore.getState().notifications.find(n => n.onUndo);
  useStore.getState().removeNotification(latest.id);
  await latest.onUndo();
  assert.equal(useStore.getState().messages.some(m => m.id === deleted.id), true);
  await bUndo.onUndo();
  await cUndo.onUndo();
  assert.equal(harness.copies.has(22), false);
  assert.equal(harness.copies.has(33), false);
});

test('a main-list switch dismisses GTD Undo created from a rail member of the same thread', async () => {
  const harness = classificationHarness();
  const stale = await harness.addCopy({ id: 'a-rail', account_id: 'account-a', thread_key: 'thread-a' }, 11);
  const unrelated = await harness.addCopy({ id: 'b-inbox', account_id: 'account-a', thread_id: 'thread-b' }, 22);
  await harness.classify({ id: 'a-inbox', account_id: 'account-a', thread_id: 'thread-a' }, { switched: true });
  assert.equal(useStore.getState().notifications.some(n => n.id === stale.id), false);
  assert.equal(useStore.getState().notifications.some(n => n.id === unrelated.id), true);
});

test('switch scope is captured before an in-flight response changes the source row', async () => {
  const harness = classificationHarness();
  const a = { id: 'a-inbox', account_id: 'account-a', thread_id: 'thread-a' };
  const stale = await harness.addCopy(a, 11);
  const bUndo = await harness.addCopy({ id: 'b-inbox', account_id: 'account-a', thread_id: 'thread-b' }, 22);
  const selected = { id: 'a-filed', account_id: a.account_id, thread_key: a.thread_id };
  await harness.classify(selected, { switched: true }, () => {
    selected.thread_key = 'thread-b';
    useStore.setState({ messages: [] });
  });
  assert.equal(useStore.getState().notifications.some(n => n.id === stale.id), false);
  assert.equal(useStore.getState().notifications.some(n => n.id === bUndo.id), true);
});

test('uncertain classification failure clears only this thread GTD Undo', async () => {
  const harness = classificationHarness();
  const a = { id: 'a-inbox', account_id: 'account-a', thread_id: 'thread-a' };
  const stale = await harness.addCopy(a, 11);
  useStore.getState().addNotification({ title: 'Archived B', onUndo: () => {} });
  const archive = useStore.getState().notifications[0];
  await harness.classify({ id: 'a-filed', account_id: a.account_id, thread_key: a.thread_id }, {}, () => { throw new Error('disconnected after EXPUNGE'); });
  assert.equal(useStore.getState().notifications.some(n => n.id === stale.id), false);
  assert.equal(useStore.getState().notifications.some(n => n.id === archive.id), true);
});

test('missing thread metadata dismisses only matching source-row GTD Undo', async () => {
  const harness = classificationHarness();
  const a = { id: 'a-only' };
  const stale = await harness.addCopy(a, 11);
  const other = await harness.addCopy({ id: 'b-only' }, 22);
  await harness.classify(a, { switched: true });
  assert.equal(useStore.getState().notifications.some(n => n.id === stale.id), false);
  assert.equal(useStore.getState().notifications.some(n => n.id === other.id), true);
});
