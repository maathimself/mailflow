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
  static OPEN = 1;
  constructor() { socket = this; this.readyState = 1; }
  close() { this.readyState = 3; }
  send() {}
}
globalThis.WebSocket = FakeSocket;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');
function App() { useWebSocket(); return null; }

test('a socket the server closes as soon as it opens is retried with a growing delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const original = api.getUnreadCounts;
  api.getUnreadCounts = async () => ({ byAccount: {}, snapshots: {} });
  const root = createRoot(document.getElementById('root'));
  const delays = [];
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    await React.act(async () => { root.render(React.createElement(App)); });
    for (let i = 0; i < 5; i += 1) {
      const refused = socket;
      refused.onopen();
      refused.onclose({ code: 1008 }); // an address other than APP_URL: refused at once
      let waited = 0;
      while (socket === refused) { t.mock.timers.tick(250); waited += 250; }
      delays.push(waited);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
    // Once a socket stays up, the next drop starts over.
    socket.onopen();
    t.mock.timers.tick(10000);
    const stable = socket;
    stable.onclose({ code: 1006 });
    let waited = 0;
    while (socket === stable) { t.mock.timers.tick(250); waited += 250; }
    assert.equal(waited, 1000);
  } finally {
    Math.random = realRandom;
    await React.act(async () => root.unmount());
    api.getUnreadCounts = original;
    dom.window.close();
  }
});
