// The GTD rail's read against a "Mark as unread" from the reading pane (utils/readOrder.js).
//
// Marking a rail row read collects the thread's ids with a getThread round trip before it sends
// the bulk read. A "Mark as unread" from the reading pane in that gap reached the server first, and
// the slower read landed after it: the message ended up read on the server although the user's
// last action on it was unread. These run the real api.bulkRead against a stubbed fetch that plays
// the server, writing each request as it arrives.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: k => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { markMessageUnread } = await import('../utils/messageHotkeys.js');
const { _resetReadOrder, _readIntentSize } = await import('../utils/readOrder.js');
const { useGtdTriage } = await import('./useGtdTriage.js');

const deferred = () => {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
};
const tick = () => new Promise(r => setTimeout(r, 0));

let root, triage, saved, server, requests, hold;
// Message id: Message-ID, for the server's fan-out to copies.
const copies = new Map([['head', '<head@example.invalid>'], ['inbox', '<head@example.invalid>'], ['reply', '<reply@example.invalid>']]);

function Probe() {
  triage = useGtdTriage();
  return null;
}

beforeEach(async () => {
  _resetReadOrder();
  saved = { getThread: api.getThread, fetch: globalThis.fetch, state: useStore.getState() };
  server = new Map([['head', false], ['inbox', false], ['reply', false]]);
  requests = [];
  // Set to a deferred to hold the next bulk-read reply until it is resolved.
  hold = null;
  globalThis.fetch = async (url, opts) => {
    const { ids, read } = JSON.parse(opts.body);
    requests.push({ ids, read });
    // The server writes the row as the request arrives, with the account's other copies of the
    // message (the GTD fan-out), and answers after the IMAP store.
    for (const id of ids) {
      server.set(id, read);
      for (const [other, mid] of copies) if (mid === copies.get(id)) server.set(other, read);
    }
    const wait = hold;
    hold = null;
    if (wait) await wait.promise;
    return new Response(JSON.stringify({ ok: true, updated: ids }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  useStore.setState({ scheduleGtdSectionsFetch() {} });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Probe)));
});

afterEach(async () => {
  await React.act(async () => root.unmount());
  api.getThread = saved.getThread;
  globalThis.fetch = saved.fetch;
  useStore.setState(saved.state);
});

const railThread = () => ({ id: 'head', message_id: '<head@example.invalid>', thread_key: 'k', account_id: 'a', is_read: false });

// What the reading pane's "Mark as unread" sends for the message it shows.
const unreadFromPane = id => markMessageUnread({ id, account_id: 'a', is_read: true }, { patch: api.bulkRead });

describe('the GTD rail read and a reading-pane unread', () => {
  test('an unread clicked while the rail is still collecting the thread wins on the server', async () => {
    const thread = deferred();
    api.getThread = () => thread.promise;
    const reading = triage.rowActions.setRead(railThread(), true);
    await tick();
    unreadFromPane('head');
    await tick();
    thread.resolve({ messages: [{ id: 'head' }, { id: 'reply' }] });
    await React.act(async () => { await reading; });
    await tick();
    assert.equal(server.get('head'), false, 'the last action on head was unread');
    assert.equal(server.get('reply'), true, 'the rest of the thread is still read');
    assert.deepEqual(requests.at(-1), { ids: ['reply'], read: true });
    assert.equal(_readIntentSize(), 0, 'done, the rail keeps nothing about the messages');
  });

  test('with every message unread by hand meanwhile, the rail sends no read at all', async () => {
    const thread = deferred();
    api.getThread = () => thread.promise;
    const reading = triage.rowActions.setRead(railThread(), true);
    await tick();
    unreadFromPane('head');
    unreadFromPane('reply');
    thread.resolve({ messages: [{ id: 'head' }, { id: 'reply' }] });
    await React.act(async () => { await reading; });
    await tick();
    assert.deepEqual(requests.map(r => r.read), [false, false]);
    assert.equal(server.get('head'), false);
  });

  // Sent in the order the user acted, the server applies them in that order too.
  test('an unread clicked while the rail read is in flight goes out after it, at once', async () => {
    api.getThread = async () => ({ messages: [{ id: 'head' }, { id: 'reply' }] });
    const reply = deferred();
    hold = reply;
    const reading = triage.rowActions.setRead(railThread(), true);
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(requests.length, 1, 'the read is out');
    unreadFromPane('head');
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(requests.length, 2, 'the unread does not wait for its answer');
    assert.deepEqual(requests.at(-1), { ids: ['head'], read: false });
    reply.resolve();
    await React.act(async () => { await reading; });
    assert.equal(server.get('head'), false);
  });

  // The thread endpoint lists the Inbox copy, the rail row is the label copy, and the server fans
  // a read of either out to the other: reading the Inbox copy would undo the unread of the label copy.
  test('an unread of another copy of the message wins too', async () => {
    const thread = deferred();
    api.getThread = () => thread.promise;
    const reading = triage.rowActions.setRead(railThread(), true);
    await tick();
    unreadFromPane('head');
    thread.resolve({ messages: [
      { id: 'inbox', message_id: '<head@example.invalid>', account_id: 'a' },
      { id: 'reply', message_id: '<reply@example.invalid>', account_id: 'a' },
    ] });
    await React.act(async () => { await reading; });
    await tick();
    assert.deepEqual(requests.at(-1), { ids: ['reply'], read: true });
    assert.equal(server.get('head'), false);
    assert.equal(server.get('inbox'), false);
  });

  test('an unread from before the rail read does not hold any message back', async () => {
    api.getThread = async () => ({ messages: [{ id: 'head' }, { id: 'reply' }] });
    unreadFromPane('head');
    await tick();
    await React.act(async () => { await triage.rowActions.setRead(railThread(), true); });
    assert.deepEqual(requests.at(-1), { ids: ['head', 'reply'], read: true });
    assert.equal(server.get('head'), true);
  });
});
