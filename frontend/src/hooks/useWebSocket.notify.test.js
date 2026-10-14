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
// "Notify me" (#588): the server alerts for mail a rule filed out of the Inbox. With nothing new left
// in the Inbox, the toast still shows, for the message in the folder it went to.
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
globalThis.Audio = class { play() { return Promise.resolve(); } };
dom.window.Audio = globalThis.Audio;

test('an alert for filed mail shows, for its own folder, with no new inbox mail to list', async () => {
  const root = createRoot(document.getElementById('root'));
  useStore.getState().setAccounts([{ id: 'a', enabled: true }]);
  useStore.setState({ notifications: [], selectedAccountId: 'a', selectedFolder: 'INBOX' });
  const original = api.getUnreadCounts;
  api.getUnreadCounts = async () => ({ byAccount: {}, snapshots: {} });
  let listRefreshes = 0;
  window.addEventListener('mailflow:refresh', () => listRefreshes++);
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    const filed = { id: 'm1', folder: 'Shops/Coolblue', fromName: 'Coolblue', subject: 'Order confirmed' };
    await React.act(async () => socket.onmessage({ data: JSON.stringify({ type: 'new_messages', accountId: 'a',
      folder: 'INBOX', messages: [], count: 0, alertMessages: [filed], alertCount: 1 }) }));
    const shown = useStore.getState().notifications.filter(n => n.type === 'new_mail');
    assert.equal(shown.length, 1, 'the toast shows');
    assert.equal(shown[0].messageId, 'm1');
    assert.equal(shown[0].folder, 'Shops/Coolblue', 'for the folder the rule filed it in');
    assert.equal(listRefreshes, 0, 'nothing new to list in the Inbox');

    useStore.setState({ notifications: [] });
    await React.act(async () => socket.onmessage({ data: JSON.stringify({ type: 'new_messages', accountId: 'a',
      folder: 'INBOX', messages: [{ id: 'm2' }], count: 1, alertMessages: [], alertCount: 0 }) }));
    assert.equal(useStore.getState().notifications.filter(n => n.type === 'new_mail').length, 0, 'silenced mail still shows no toast');
    assert.equal(listRefreshes, 1, 'but is listed');
  } finally {
    await React.act(async () => root.unmount());
    api.getUnreadCounts = original;
  }
});
