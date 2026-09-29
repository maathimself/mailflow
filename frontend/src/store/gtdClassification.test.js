import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');

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
