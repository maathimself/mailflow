import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true,
      source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const Observer = (await import('./InboxReplyDraftObserver.js')).default;
const draft = (id, uid = 5) => ({ id: `draft-${id}`, account_id: 'acct', folder: 'Drafts', uid,
  subject: `Re: ${id}`, in_reply_to: `<${id}@example.test>`, to_addresses: ['to@example.test'] });
const row = id => ({ id, account_id: 'acct', folder: 'INBOX', subject: id });
const response = data => ({ ok: true, status: 200, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let root, requests;

before(async () => { root = createRoot(document.getElementById('root')); await React.act(async () => root.render(React.createElement(Observer, { lookupDelayMs: 0 }))); });
after(async () => { await React.act(async () => root.unmount()); });

async function reset() {
  requests = [];
  globalThis.fetch = url => { const item = deferred(); requests.push({ url: String(url), ...item }); return item.promise; };
  await React.act(async () => useStore.setState({ selectedMessageId: null, selectedFolder: 'INBOX',
    selectedAccountId: null, messages: [row('a'), row('b'), row('c')], searchResults: [],
    searchQuery: '', threadMessages: {}, composing: false, composeData: null,
    prepareComposeSwitch: null, notifications: [] }));
}
async function select(id) { await React.act(async () => useStore.getState().setSelectedMessage(id)); }
async function finish(index, data) { await React.act(async () => { requests[index].resolve(response(data)); await Promise.resolve(); }); }

test('selection opens a matching draft in the existing composer state', async () => {
  await reset(); await select('a');
  assert.match(requests[0].url, /\/messages\/a\/reply-draft$/);
  await finish(0, { draft: draft('a') });
  assert.match(requests[1].url, /\/messages\/draft-a\/body$/);
  await finish(1, { html: '<p>Agent reply</p>', attachments: [] });
  assert.equal(useStore.getState().composeData.body, '<p>Agent reply</p>');
  assert.equal(useStore.getState().composeData.source, 'inboxReplyDraft');
  assert.equal(useStore.getState().selectedMessageId, 'a');
});

test('rapid A to B to C selection ignores all stale lookup and body responses', async () => {
  await reset(); await select('a'); await select('b');
  await finish(1, { draft: draft('b') });
  await select('c');
  await finish(3, { draft: draft('c') });
  await finish(4, { html: '<p>C</p>', attachments: [] });
  await finish(2, { html: '<p>B</p>', attachments: [] });
  await finish(0, { draft: draft('a') });
  assert.equal(useStore.getState().composeData.sourceSelectionId, 'c');
  assert.equal(requests.length, 5);
});

test('a null match closes only an owned composer after handoff', async () => {
  await reset();
  await React.act(async () => useStore.setState({ composing: true, composeData: { source: 'inboxReplyDraft' }, prepareComposeSwitch: async () => true }));
  await select('b'); await finish(0, { draft: null });
  assert.equal(useStore.getState().composing, false);
  await React.act(async () => useStore.setState({ composing: true, composeData: { subject: 'manual' } }));
  await select('c'); await finish(1, { draft: null });
  assert.equal(useStore.getState().composing, true);
});

test('failed handoff and lookup errors retain the old composer and selected pane', async () => {
  await reset();
  await React.act(async () => useStore.setState({ composing: true, composeData: { source: 'inboxReplyDraft', persistedKey: 'old' }, prepareComposeSwitch: async () => false }));
  await select('b'); await finish(0, { draft: draft('b') }); await finish(1, { text: 'B' });
  assert.equal(useStore.getState().composeData.persistedKey, 'old');
  assert.equal(useStore.getState().selectedMessageId, 'b');
  await select('c');
  await React.act(async () => requests[2].resolve({ ok: false, status: 503, json: async () => ({ error: 'IMAP unavailable' }) }));
  assert.equal(useStore.getState().composeData.persistedKey, 'old');
  assert.equal(useStore.getState().selectedMessageId, 'c');
});

test('other folders and other-account rows do not run the inbox lookup', async () => {
  await reset();
  await React.act(async () => useStore.setState({ selectedFolder: 'Sent' }));
  await select('a');
  assert.equal(requests.length, 0);
  await React.act(async () => useStore.setState({ selectedFolder: 'INBOX', selectedAccountId: 'another' }));
  assert.equal(requests.length, 0);
});

test('an all-folder search result from Sent is not treated as an inbox selection', async () => {
  await reset();
  await React.act(async () => useStore.setState({ searchQuery: 'reply',
    searchResults: [{ ...row('sent'), folder: 'Sent' }] }));
  await select('sent');
  assert.equal(requests.length, 0);
});

test('navigation away from the inbox invalidates a pending lookup', async () => {
  await reset(); await select('a');
  await React.act(async () => useStore.setState({ selectedFolder: 'Sent' }));
  await finish(0, { draft: draft('a') });
  assert.equal(requests.length, 1);
  assert.equal(useStore.getState().composing, false);
});

test('the newest selection wins when an older handoff is still saving', async () => {
  await reset();
  const handoff = deferred();
  await React.act(async () => useStore.setState({ composing: true,
    composeData: { source: 'inboxReplyDraft', persistedKey: 'old' },
    prepareComposeSwitch: () => handoff.promise }));
  await select('a'); await finish(0, { draft: draft('a') }); await finish(1, { text: 'A' });
  await select('b'); await finish(2, { draft: draft('b') }); await finish(3, { text: 'B' });
  await React.act(async () => { handoff.resolve(true); await Promise.resolve(); });
  assert.equal(useStore.getState().composeData.sourceSelectionId, 'b');
});

test('rapid keyboard-style selection starts one lookup after a short pause', async () => {
  await reset();
  await React.act(async () => root.render(React.createElement(Observer, { lookupDelayMs: 50 })));
  await select('a'); await select('b'); await select('c');
  assert.equal(requests.length, 0);
  await React.act(async () => new Promise(resolve => setTimeout(resolve, 70)));
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/messages\/c\/reply-draft$/);
  await reset();
  await React.act(async () => root.render(React.createElement(Observer, { lookupDelayMs: 0 })));
});
