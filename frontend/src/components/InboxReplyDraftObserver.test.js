import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
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
  useStore.setState({ user: { id: 'reader' }, selectedMessageId: null, selectedFolder: 'INBOX', selectedAccountId: null,
    messages: Array.from({length: count}, (_, i) => row(String(i))), searchResults: [], searchQuery: '',
    threadMessages: {}, composing: false, composeData: null, prepareComposeSwitch: null,
    replyDrafts: {}, replyDraftRevision: 0, notifications: [], autoOpenReplyDrafts, conversationMode: 'off' });
  api.getReplyDraftIndicators = async () => ({ indicators: {} });
  api.getReplyDraft = async id => ({ draft: draft(id), body: { text: `Reply ${id}`, attachments: [] } });
}
async function mount() { await React.act(async () => root.render(React.createElement(Observer, { lookupDelayMs: 0 }))); }
async function select(id) { await React.act(async () => useStore.getState().setSelectedMessage(id)); }

test('default selection and refresh use only synced indicators and leave compose untouched', async () => {
  await reset(); let live = 0;
  api.getReplyDraft = async () => { live++; return { draft: null }; };
  api.getReplyDraftIndicators = async ids => ({ indicators: Object.fromEntries(ids.map(id => [id, { exists: id === '0' }])) });
  await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0'].exists, true);
  assert.equal(useStore.getState().composing, false);
  useStore.setState({ prepareComposeSwitch: async () => true });
  await React.act(async () => useStore.getState().openCompose({ subject: 'Manual' }));
  await select('1'); await select('2');
  await React.act(async () => useStore.getState().invalidateReplyDrafts());
  assert.equal(useStore.getState().composeData.subject, 'Manual');
  assert.equal(useStore.getState().replyDrafts['1'].exists, false);
  assert.equal(live, 0);
});

test('slow cached batches cannot resurrect a newer live absence', async () => {
  await reset({ autoOpenReplyDrafts: true }); const cached = deferred();
  api.getReplyDraftIndicators = () => cached.promise;
  api.getReplyDraft = async () => ({ draft: null });
  await mount(); await select('0');
  await React.act(async () => cached.resolve({ indicators: { '0': { exists: true } } }));
  assert.equal(useStore.getState().replyDrafts['0'].exists, false);
});

test('rapid selection ignores stale live results and batching chunks at 100', async () => {
  await reset({ count: 201, autoOpenReplyDrafts: true }); const batches = [];
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
  useStore.setState({ prepareComposeSwitch: async () => true });
  await React.act(async () => useStore.getState().openCompose({ subject: 'Manual' }));
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
  await reset({ autoOpenReplyDrafts: true }); const pending = deferred(); api.getReplyDraft = () => pending.promise;
  await mount(); await select('0');
  await React.act(async () => useStore.setState({ selectedFolder: 'Sent' }));
  await React.act(async () => pending.resolve({ draft: draft('0') }));
  assert.equal(useStore.getState().composing, false);
  await reset({ autoOpenReplyDrafts: true }); api.getReplyDraft = async () => { throw new Error('Server unavailable'); };
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

test('a selected inbox message parked by a deep link gets a synced reading-pane indicator', async () => {
  await reset({ count: 0 });
  let live = 0;
  api.getReplyDraft = async () => { live++; return { draft: null }; };
  api.getReplyDraftIndicators = async ids => ({ indicators: Object.fromEntries(ids.map(id => [id, { exists: true }])) });
  useStore.setState({ threadMessages: { '__dl_0': [row('0')] } });
  await mount(); await select('0');
  assert.equal(useStore.getState().replyDrafts['0']?.exists, true);
  assert.equal(useStore.getState().composing, false);
  assert.equal(live, 0);
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
  await reset({ autoOpenReplyDrafts: true });
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


test('a manual composer prevents any automatic live lookup', async () => {
  await reset({ autoOpenReplyDrafts: true });
  useStore.getState().openCompose({ subject: 'Manual' });
  let calls = 0;
  api.getReplyDraft = async () => { calls++; return { draft: null }; };
  await mount(); await select('0');
  assert.equal(calls, 0);
  assert.equal(useStore.getState().composeData.subject, 'Manual');
});

test('turning auto-open off during lookup discards its response', async () => {
  await reset({ autoOpenReplyDrafts: true });
  const pending = deferred(); api.getReplyDraft = () => pending.promise;
  await mount(); await select('0');
  await React.act(async () => useStore.setState({ autoOpenReplyDrafts: false }));
  await React.act(async () => pending.resolve({ draft: draft('0'), body: { text: 'Old', attachments: [] } }));
  assert.equal(useStore.getState().composing, false);
  assert.equal(useStore.getState().replyDrafts['0'], undefined);
});

for (const stage of ['first lookup', 'after save']) for (const nextUser of [null, { id: 'other-reader' }]) {
  test(`explicit ${stage} cannot update state after ownership changes to ${nextUser?.id || 'signed out'}`, async () => {
    await reset(); await select('0');
    const pending = deferred(); let calls = 0;
    if (stage === 'after save') {
      useStore.getState().openCompose({ subject: 'Existing' });
      useStore.setState({ prepareComposeSwitch: async () => true });
    }
    api.getReplyDraft = async () => ++calls === (stage === 'after save' ? 2 : 1) ? pending.promise
      : { draft: draft('0'), body: { text: 'Reply', attachments: [] } };
    const opening = openReplyDraft('0');
    await new Promise(resolve => setImmediate(resolve));
    useStore.getState().setUser(nextUser);
    pending.resolve({ draft: draft('0'), body: { text: 'Old owner', attachments: [] } });
    assert.equal(await opening, false);
    assert.equal(useStore.getState().composeData?.subject, stage === 'after save' ? 'Existing' : undefined);
    assert.deepEqual(useStore.getState().replyDrafts, {});
    assert.deepEqual(useStore.getState().notifications, []);
  });
}

test('an unrelated revision change while saving cancels an explicit handoff', async () => {
  await reset(); await select('0');
  useStore.getState().openCompose({ subject: 'Existing' });
  useStore.setState({ prepareComposeSwitch: async () => { useStore.getState().invalidateReplyDrafts(); return true; } });
  assert.equal(await openReplyDraft('0'), false);
  assert.equal(useStore.getState().composeData.subject, 'Existing');
});

for (const change of [{ selectedMessageId: '1' }, { selectedAccountId: 'other-account' }]) {
  test(`a live result cannot write status during a batched scope change ${JSON.stringify(change)}`, async () => {
    await reset({ autoOpenReplyDrafts: true });
    const pending = deferred();
    api.getReplyDraft = id => id === '0' ? pending.promise : Promise.resolve({ draft: null });
    await mount(); await select('0');
    await React.act(async () => {
      useStore.setState(change);
      pending.resolve({ draft: draft('0'), body: { text: 'Old scope', attachments: [] } });
      await Promise.resolve();
      assert.equal(useStore.getState().replyDrafts['0'], undefined);
    });
    assert.equal(useStore.getState().composing, false);
  });
}

for (const selections of [['1'], ['1', '0']]) test(`selection during automatic handoff retries ${selections.join(' then ')}`, async () => {
  await reset({ autoOpenReplyDrafts: true });
  const saving = deferred();
  const calls = [];
  useStore.getState().openCompose({ source: 'automaticReplyDraft', subject: 'Initial editor' });
  useStore.setState({ prepareComposeSwitch: () => saving.promise });
  api.getReplyDraft = async id => { calls.push(id); return { draft: draft(id), body: { text: 'Reply ' + id, attachments: [] } }; };
  await mount(); await select('0');
  assert.deepEqual(calls, ['0']);
  for (const id of selections) await select(id);
  await React.act(async () => saving.resolve(true));
  await React.act(async () => new Promise(resolve => setImmediate(resolve)));
  assert.equal(useStore.getState().selectedMessageId, selections.at(-1));
  assert.equal(useStore.getState().composeData.sourceSelectionId, selections.at(-1));
});

for (const change of ['different owner', 'sign out and back', 'close']) test(`ordinary compose handoff cancels after ${change}`, async () => {
  await reset();
  useStore.getState().openCompose({ subject: 'Old' });
  const pending = deferred();
  useStore.setState({ prepareComposeSwitch: () => pending.promise });
  const opening = useStore.getState().openCompose({ subject: 'New manual' });
  if (change === 'close') useStore.getState().closeCompose();
  else if (change === 'different owner') useStore.getState().setUser({ id: 'new-reader' });
  else { useStore.getState().setUser(null); useStore.getState().setUser({ id: 'reader' }); }
  pending.resolve(true);
  assert.equal(await opening, false);
  assert.notEqual(useStore.getState().composeData?.subject, 'New manual');
});
