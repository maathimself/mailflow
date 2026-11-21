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

// A push travels through the browser's push service, not the socket, so it still arrives when the
// socket died without closing (a VPN dropping an idle stream). The polled counts rose while the
// list never got the new mail. A push now has the tab check its socket, hidden or not.
// The socket opened a while before (a frame at the very moment of the push would answer it).
function pushArrives(t, after = 5000) {
  t.mock.timers.tick(after);
  window.dispatchEvent(new CustomEvent('mailflow:push_received'));
}
function countEvents(names) {
  const seen = Object.fromEntries(names.map(n => [n, 0]));
  const handlers = names.map(n => [n, () => { seen[n] += 1; }]);
  for (const [n, h] of handlers) window.addEventListener(n, h);
  return { seen, stop: () => { for (const [n, h] of handlers) window.removeEventListener(n, h); } };
}

test('a push has a hidden tab replace a socket that no longer answers, and the reconnect catches up', async (t) => {
  visibility = 'hidden';
  const stale = socket;
  const events = countEvents(['mailflow:refresh', 'mailflow:counts_refresh']);
  try {
    pushArrives(t);
    assert.equal(stale.sent.at(-1), 'ping', 'the socket is asked to prove it is alive, though the tab is hidden');
    assert.equal(events.seen['mailflow:refresh'], 0, 'an OPEN socket is trusted until the probe says otherwise');
    t.mock.timers.tick(8000);
    assert.notEqual(socket, stale, 'no answer, so a new socket is opened');
    socket.onopen();
    await flush();
    assert.equal(events.seen['mailflow:refresh'], 1, 'the reconnect reloads the list');
  } finally {
    events.stop();
  }
});

test('a push with a healthy socket changes nothing', (t) => {
  const live = socket;
  const events = countEvents(['mailflow:refresh', 'mailflow:counts_refresh']);
  try {
    pushArrives(t);
    live.onmessage({ data: JSON.stringify({ type: 'pong' }) });
    t.mock.timers.tick(30_000);
    assert.equal(socket, live);
    assert.deepEqual(events.seen, { 'mailflow:refresh': 0, 'mailflow:counts_refresh': 0 });
  } finally {
    events.stop();
  }
});

test('a push while the socket is down reconnects at once and reloads the list and counts now', (t) => {
  const realRandom = Math.random;
  Math.random = () => 0;
  const events = countEvents(['mailflow:refresh', 'mailflow:counts_refresh']);
  try {
    const dropped = socket;
    dropped.readyState = FakeSocket.CLOSED;
    dropped.onclose({ code: 1006 });
    assert.equal(socket, dropped, 'the reconnect waits out its backoff');
    pushArrives(t, 0);
    assert.notEqual(socket, dropped, 'the push skips the backoff');
    assert.deepEqual(events.seen, { 'mailflow:refresh': 1, 'mailflow:counts_refresh': 1 });
  } finally {
    events.stop();
    Math.random = realRandom;
  }
});

test('two pushes in a row send one probe', (t) => {
  const stale = socket;
  pushArrives(t);
  pushArrives(t);
  assert.equal(stale.sent.filter(s => s === 'ping').length, 1);
  t.mock.timers.tick(8000);
  assert.notEqual(socket, stale);
});
