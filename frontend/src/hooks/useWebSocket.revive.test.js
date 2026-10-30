// A socket can stay OPEN after the connection under it is gone: a phone that slept, a network
// that changed, a proxy that dropped the stream. onclose never fires, so nothing reconnects and
// the tab silently stops receiving updates. Returning to the tab used to revive only a socket
// that was already CLOSED or CLOSING, and the heartbeat's close() of a silent socket waited on
// a closing handshake that a dead connection never completes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let visibility = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibility });
let socket;
// A dead connection: sends go nowhere and close() never reaches onclose.
class FakeSocket {
  static CLOSED = 3;
  static CLOSING = 2;
  static OPEN = 1;
  constructor() { socket = this; this.readyState = 1; this.sent = []; }
  close() { this.readyState = 2; }
  send(data) { this.sent.push(JSON.parse(data).type); }
}
globalThis.WebSocket = FakeSocket;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useWebSocket } = await import('./useWebSocket.js');
const { installResumeRefresh, RESUME_RETRY_MS } = await import('../utils/resumeRefresh.js');
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
function App() { useWebSocket(); return null; }

const original = api.getUnreadCounts;
let root;
beforeEach(async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  api.getUnreadCounts = async () => ({ byAccount: {}, snapshots: {} });
  visibility = 'visible';
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(App)); });
  socket.onopen();
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  api.getUnreadCounts = original;
});

function comeBack(t, awayMs) {
  visibility = 'hidden';
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  t.mock.timers.tick(awayMs);
  visibility = 'visible';
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
}

test('an open socket that no longer answers is replaced soon after the tab comes back', async (t) => {
  const stale = socket;
  comeBack(t, 20_000);
  assert.equal(stale.sent.at(-1), 'ping', 'the socket is asked to prove it is alive');
  t.mock.timers.tick(7999);
  assert.equal(socket, stale, 'it has a while to answer');
  t.mock.timers.tick(1);
  assert.notEqual(socket, stale, 'no answer, so a new socket is opened');
  assert.equal(stale.onclose, null, 'the abandoned socket cannot schedule a second reconnect');
  let caughtUp = 0;
  const count = () => { caughtUp += 1; };
  window.addEventListener('mailflow:socket_caught_up', count);
  socket.onopen();
  await flush();
  window.removeEventListener('mailflow:socket_caught_up', count);
  assert.equal(caughtUp, 1, 'the new socket catches up, which settles a resume resync still owed');
});

test('an open socket that answers the probe is kept', (t) => {
  const live = socket;
  comeBack(t, 20_000);
  live.onmessage({ data: JSON.stringify({ type: 'pong' }) });
  t.mock.timers.tick(30_000);
  assert.equal(socket, live);
});

test('a silent socket is replaced by the heartbeat even when its close never completes', (t) => {
  const stale = socket;
  t.mock.timers.tick(90_000);
  assert.notEqual(socket, stale);
});

// A reconnect's catch-up settles a resume resync still being retried, but only once its counts
// are in. Failing too (a 502, a network still flapping), it must leave the retry in place.
test('a reconnect whose catch-up fails leaves a resume retry in place', async (t) => {
  const realRandom = Math.random;
  Math.random = () => 0;
  let resyncs = 0;
  const stop = installResumeRefresh({ doc: document, win: window, onResync: () => { resyncs += 1; return Promise.reject(new Error('offline')); } });
  try {
    api.getUnreadCounts = async () => { throw new Error('502'); };
    const pageshow = new dom.window.Event('pageshow');
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    await flush();
    assert.equal(resyncs, 1);
    const dropped = socket;
    dropped.onclose({ code: 1006 });
    t.mock.timers.tick(1000);
    assert.notEqual(socket, dropped);
    socket.onopen();
    await flush();
    t.mock.timers.tick(RESUME_RETRY_MS[0]);
    await flush();
    assert.equal(resyncs, 2, 'the retry still runs');
  } finally {
    stop();
    Math.random = realRandom;
  }
});
