// Run with: node --test src/store/notifications.test.js
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      return {
        format: 'module',
        source: `export default ${readFileSync(new URL(url), 'utf8')}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.localStorage = (() => {
  let values = { mailflow_theme: 'dark' };
  return {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; },
    clear: () => { values = {}; },
  };
})();

const { useStore } = await import('./index.js');
const { UNDO_WINDOW_MS, createInboxTriageUndoMetadata } = await import('../utils/inboxTriageUndo.js');

describe('notification undo consumption', () => {
  beforeEach(() => {
    useStore.setState({ notifications: [] });
  });

  it('consumes a notification before invoking its undo callback', () => {
    let calls = 0;
    useStore.setState({
      notifications: [{ id: 'n1', onUndo: () => { calls += 1; }, undoExpiresAt: 2000 }],
    });

    assert.equal(useStore.getState().runNotificationUndo('n1', 1000), true);
    assert.equal(useStore.getState().runNotificationUndo('n1', 1000), false);
    assert.equal(calls, 1);
    assert.deepEqual(useStore.getState().notifications, []);
  });

  it('removes an expired notification without invoking its callback', () => {
    let calls = 0;
    useStore.setState({
      notifications: [{ id: 'old', onUndo: () => { calls += 1; }, undoExpiresAt: 1000 }],
    });

    assert.equal(useStore.getState().runNotificationUndo('old', 1000), false);
    assert.equal(calls, 0);
    assert.deepEqual(useStore.getState().notifications, []);
  });

  it('assigns undo expiry by default without overwriting an explicit expiry', () => {
    const before = Date.now();
    useStore.getState().addNotification({ onUndo() {} });
    const after = Date.now();
    const defaultExpiry = useStore.getState().notifications[0].undoExpiresAt;

    assert.ok(defaultExpiry >= before + UNDO_WINDOW_MS);
    assert.ok(defaultExpiry <= after + UNDO_WINDOW_MS);

    useStore.getState().addNotification({ onUndo() {}, undoExpiresAt: 1234 });
    assert.equal(useStore.getState().notifications[0].undoExpiresAt, 1234);
  });

  it('starts the full undo window when the notification is registered, not when origin is captured', () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      const captured = createInboxTriageUndoMetadata({
        selectedFolder: 'INBOX',
        searchQuery: '',
        activeGtdTab: null,
        selectedMessageId: 'm1',
        displayedMessageIds: ['m1'],
      });

      Date.now = () => 9_000;
      useStore.getState().addNotification({ ...captured, onUndo() {} });

      assert.equal(useStore.getState().notifications[0].undoExpiresAt, 9_000 + UNDO_WINDOW_MS);
    } finally {
      Date.now = originalNow;
    }
  });

  it('rejects missing and non-finite undo expiries', () => {
    for (const undoExpiresAt of [undefined, null, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      let calls = 0;
      useStore.setState({
        notifications: [{ id: 'invalid', onUndo: () => { calls += 1; }, undoExpiresAt }],
      });

      assert.equal(useStore.getState().runNotificationUndo('invalid', 1_000), false);
      assert.equal(calls, 0);
      assert.deepEqual(useStore.getState().notifications, []);
    }
  });
});
