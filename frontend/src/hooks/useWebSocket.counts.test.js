import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let socket;
class FakeSocket {
  static CLOSED = 3;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeSocket;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');
function App() { useWebSocket(); return null; }
test('already-seen arrivals do not inflate badges; count events update without refreshing the message list', async () => {
  const root = createRoot(document.getElementById('root'));
  const counts = { byAccount: { a: 3 }, snapshots: { a: { revision: '1', observedAt: new Date().toISOString(), known: true, stale: false } } };
  useStore.getState().setAccounts([{ id: 'a', enabled: true }]);
  useStore.getState().setUnreadCounts(counts);
  const original = api.getUnreadCounts;
  api.getUnreadCounts = async () => ({ ...counts, byAccount: { a: 2 }, snapshots: { a: { ...counts.snapshots.a, revision: '2' } } });
  let listRefreshes = 0;
  window.addEventListener('mailflow:refresh', () => listRefreshes++);
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    await React.act(async () => { socket.onmessage({ data: JSON.stringify({ type: 'exists_hint', accountId: 'a', delta: 5 }) }); });
    assert.equal(useStore.getState().unreadCounts.byAccount.a,3);
    await React.act(async () => { socket.onmessage({ data: JSON.stringify({ type: 'folder_counts', accountId: 'a' }) }); });
    assert.equal(useStore.getState().unreadCounts.byAccount.a,2);
    assert.equal(listRefreshes,0);
  } finally {
    await React.act(async () => root.unmount());
    api.getUnreadCounts = original;
    dom.window.close();
  }
});
