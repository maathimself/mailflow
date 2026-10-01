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
const { api } = await import('../utils/api.js');
api.savePreferences = async () => ({ ok: true });
const Observer = (await import('./InboxReplyDraftObserver.js')).default;
const { openReplyDraft } = await import('../utils/openReplyDraft.js');
const row = id => ({ id, account_id: 'acct', folder: 'INBOX', message_id: `<${id}@example.test>` });
const draft = id => ({ id: `draft-${id}`, account_id: 'acct', folder: 'Drafts', uid: 5,
  message_id: `<draft-${id}@example.test>`, in_reply_to: `<${id}@example.test>`, attachments_complete: true,
  from_email: 'me@example.test', to_addresses: ['recipient@example.test'] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let root;
before(async () => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });
async function reset({ autoOpenReplyDrafts = false, count = 3 } = {}) {
  await React.act(async () => root.render(null));
  useStore.setState({ selectedMessageId: null, selectedFolder: 'INBOX', selectedAccountId: null,
    messages: Array.from({length: count}, (_, i) => row(String(i))), searchResults: [], searchQuery: '',
    threadMessages: {}, composing: false, composeData: null, prepareComposeSwitch: null,
    replyDrafts: {}, replyDraftRevision: 0, notifications: [], autoOpenReplyDrafts, conversationMode: 'off' });
  api.getReplyDraftIndicators = async () => ({ indicators: {} });
  api.getReplyDraft = async id => ({ draft: draft(id), body: { text: `Reply ${id}`, attachments: [] } });
}
async function mount() { await React.act(async () => root.render(React.createElement(Observer, { lookupDelayMs: 0 }))); }
async function select(id) { await React.act(async () => useStore.getState().setSelectedMessage(id)); }

test('default selection reports a live draft without opening or closing compose', async () => {
  await reset(); await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0'].exists, true);
  assert.equal(useStore.getState().composing, false);
  useStore.getState().openCompose({ subject: 'Manual' });
  await select('1');
  assert.equal(useStore.getState().composeData.subject, 'Manual');
});

test('slow cached batches cannot resurrect a newer live absence', async () => {
  await reset(); const cached = deferred();
  api.getReplyDraftIndicators = () => cached.promise;
  api.getReplyDraft = async () => ({ draft: null });
  await mount(); await select('0');
  await React.act(async () => cached.resolve({ indicators: { '0': { exists: true } } }));
  assert.equal(useStore.getState().replyDrafts['0'].exists, false);
});

test('rapid selection ignores stale live results and batching chunks at 100', async () => {
  await reset({ count: 201 }); const batches = [];
  api.getReplyDraftIndicators = async ids => { batches.push(ids); return { indicators: {} }; };
  const old = deferred(); api.getReplyDraft = id => id === '0' ? old.promise : Promise.resolve({ draft: null });
  await mount(); await select('0'); await select('1');
  await React.act(async () => old.resolve({ draft: draft('0') }));
  assert.deepEqual(batches.map(ids => ids.length), [100, 100, 1]);
  assert.equal(useStore.getState().replyDrafts['1'].exists, false);
  assert.equal(useStore.getState().composing, false);
});

test('opt-in opens an automatic draft but never replaces an explicit/manual composer', async () => {
  await reset({ autoOpenReplyDrafts: true }); await mount(); await select('0');
  assert.equal(useStore.getState().composeData.source, 'automaticReplyDraft');
  useStore.getState().openCompose({ subject: 'Manual' });
  await select('1');
  assert.equal(useStore.getState().composeData.subject, 'Manual');
});

test('explicit opening revalidates after saving and keeps a failed save open', async () => {
  await reset(); await select('0');
  useStore.getState().openCompose({ subject: 'Old' });
  useStore.setState({ prepareComposeSwitch: async () => false });
  assert.equal(await openReplyDraft('0'), false);
  assert.equal(useStore.getState().composeData.subject, 'Old');
  let calls = 0;
  useStore.setState({ prepareComposeSwitch: async () => true });
  api.getReplyDraft = async () => ++calls === 1 ? { draft: draft('0'), body: { text: 'Reply', attachments: [] } } : { draft: null };
  assert.equal(await openReplyDraft('0'), false);
  assert.equal(calls, 2);
  assert.equal(useStore.getState().composeData.subject, 'Old');
});

test('a different manual compose opened during a pending save owns the composer', async () => {
  await reset(); await select('0');
  useStore.getState().openCompose({ subject: 'Old' });
  const saving = deferred(); useStore.setState({ prepareComposeSwitch: () => saving.promise });
  const opening = openReplyDraft('0'); await Promise.resolve(); await Promise.resolve();
  useStore.getState().openCompose({ subject: 'New manual' });
  saving.resolve(true);
  assert.equal(await opening, false);
  assert.equal(useStore.getState().composeData.subject, 'New manual');
});

test('explicit opening owns a manual session and retains From provenance', async () => {
  await reset(); await select('0');
  assert.equal(await openReplyDraft('0'), true);
  assert.equal(useStore.getState().composeData.source, 'manualReplyDraft');
  assert.equal(useStore.getState().composeData.accountId, 'acct');
});

test('navigation outside inbox cancels pending lookup and a lookup failure remains an error', async () => {
  await reset(); const pending = deferred(); api.getReplyDraft = () => pending.promise;
  await mount(); await select('0');
  await React.act(async () => useStore.setState({ selectedFolder: 'Sent' }));
  await React.act(async () => pending.resolve({ draft: draft('0') }));
  assert.equal(useStore.getState().composing, false);
  await reset(); api.getReplyDraft = async () => { throw new Error('Server unavailable'); };
  await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0'].error, 'Server unavailable');
});


test('an explicit opening wins over a concurrent automatic opening', async () => {
  await reset(); await select('0');
  const pending = deferred(); api.getReplyDraft = () => pending.promise;
  const manual = openReplyDraft('0');
  const automatic = openReplyDraft('0', { automatic: true });
  pending.resolve({ draft: draft('0'), body: { text: 'Reply', attachments: [] } });
  assert.equal(await automatic, false);
  assert.equal(await manual, true);
  assert.equal(useStore.getState().composeData.source, 'manualReplyDraft');
});

test('changing conversation or search scope invalidates earlier live indicators', async () => {
  await reset();
  useStore.getState().setReplyDraftStatus('0', { exists: false }, 'live');
  useStore.getState().setConversationMode('pane');
  assert.deepEqual(useStore.getState().replyDrafts, {});
  useStore.getState().setReplyDraftStatus('0', { exists: true }, 'live');
  useStore.getState().setSearchQuery('report');
  assert.deepEqual(useStore.getState().replyDrafts, {});
});

test('a selected inbox message parked by a deep link gets a live reading-pane indicator', async () => {
  await reset({ count: 0 });
  useStore.setState({ threadMessages: { '__dl_0': [row('0')] } });
  await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0']?.exists, true);
  assert.equal(useStore.getState().composing, false);
});

test('automatic opening reuses the freshly validated body from one live request', async () => {
  await reset({ autoOpenReplyDrafts: true });
  const requests = [];
  api.getReplyDraft = async (id, scope) => {
    requests.push({ id, scope });
    return { draft: draft(id), body: { text: 'Fresh reply', attachments: [] } };
  };
  await mount(); await select('0');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].scope.open, true);
  assert.equal(useStore.getState().composeData.body, 'Fresh reply');
});

test('visible row changes reuse the selected live indicator, while refresh checks again', async () => {
  await reset();
  let lookups = 0;
  api.getReplyDraft = async () => { lookups++; return { draft: null }; };
  await mount(); await select('0');
  assert.equal(lookups, 1);
  await React.act(async () => useStore.setState({ messages: [row('0'), row('3')] }));
  assert.equal(lookups, 1);
  await React.act(async () => useStore.getState().invalidateReplyDrafts());
  assert.equal(lookups, 2);
});

test('an automatic opening cannot apply a live result from the previous selection', async () => {
  await reset(); await select('1');
  assert.equal(await openReplyDraft('0', { automatic: true,
    liveResult: { draft: draft('0'), body: { text: 'Old reply', attachments: [] } } }), false);
  assert.equal(useStore.getState().composing, false);
});

test('automatic reuse rejects a result after account, conversation, or refresh scope changes', async () => {
  for (const change of [
    () => useStore.getState().setConversationMode('pane'),
    () => useStore.setState({ selectedAccountId: 'other-account' }),
    () => useStore.getState().invalidateReplyDrafts(),
  ]) {
    await reset(); await select('0');
    const liveResult = { draft: draft('0'), body: { text: 'Old scope', attachments: [] } };
    const liveScope = { accountId: undefined, threaded: false };
    change();
    assert.equal(await openReplyDraft('0', { automatic: true, liveResult, liveScope, liveRevision: 0 }), false);
    assert.equal(useStore.getState().composing, false);
  }
});
