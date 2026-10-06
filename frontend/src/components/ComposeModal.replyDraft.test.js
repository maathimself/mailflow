import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (key) => key, i18n: { language: "en", changeLanguage: () => {} } });',
      'export const initReactI18next = { type: "3rdParty", init: () => {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${readFileSync(new URL(url), 'utf8')}` };
  if (url.endsWith('.jsx')) {
    const code = transform(readFileSync(new URL(url), 'utf8'), {
      transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url,
    }).code;
    return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true,
      source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', PROD: true } });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

test('a mounted external reply sends headers and updates the UID used by its next save', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/mail/draft')) {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ uid: requests.length + 5, folder: 'Drafts' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    selectedAccountId: null, plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
      persistedKey: 'account-1:Drafts:5',
      source: 'inboxReplyDraft', to: ['to@example.test'], subject: 'Re: old', body: 'reply',
      signature: '', inReplyTo: '<parent@example.test>',
      references: '<root@example.test> <parent@example.test>' } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    assert.equal(typeof useStore.getState().prepareComposeSwitch, 'function');
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    assert.ok(subject);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Re: edited');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), true));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].inReplyTo, '<parent@example.test>');
    assert.equal(requests[0].references, '<root@example.test> <parent@example.test>');
    assert.equal(requests[0].existingUid, 5);
    assert.equal(useStore.getState().composeData.persistedKey, 'account-1:Drafts:6::');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Re: edited again');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), true));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].existingUid, 6);
    assert.equal(requests[1].inReplyTo, '<parent@example.test>');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('text-only save keeps the existing attachment warning while switching remains blocked', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/mail/draft')) {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ uid: 7, folder: 'Drafts' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', to: ['to@example.test'], body: 'text to keep',
      forwardedAttachments: [{ messageId: '11111111-1111-4111-8111-111111111111', part: '2', filename: 'report.txt' }] } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), false));
    const save = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'compose.saveDraft');
    assert.ok(save);
    await React.act(async () => save.click());
    assert.equal(requests.length, 0);
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'compose.closeDraft.save');
    assert.ok(confirm);
    await React.act(async () => confirm.click());
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body, 'text to keep');
    await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), false));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('mobile close keeps a composer with unsaved forwarded attachments open', async () => {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', to: ['to@example.test'], body: 'text',
      forwardedAttachments: [{ messageId: '11111111-1111-4111-8111-111111111111', part: '2', filename: 'report.txt' }] } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    const close = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'common.cancel');
    assert.ok(close);
    await React.act(async () => close.click());
    assert.equal(useStore.getState().composing, true);
    assert.ok([...document.querySelectorAll('button')]
      .some(button => button.textContent.trim() === 'compose.discardDraft.keepEditing'));
  } finally {
    await React.act(async () => root.unmount());
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }
});

test('editing an externally attached draft cannot replace it with an attachment-free copy', async () => {
  let writes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/mail/draft')) writes++;
    return { ok: true, status: 200, json: async () => ({ uid: 7, folder: 'Drafts' }) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
      to: ['to@example.test'], subject: 'Re: old', body: 'reply',
      externalAttachments: [{ part: '2' }],
      forwardedAttachments: [{ messageId: '11111111-1111-4111-8111-111111111111', part: '2', filename: 'report.txt' }] } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Re: changed');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), false));
    assert.equal(writes, 0);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('an untouched rich-text draft stays clean after its editor initializes', async () => {
  let writes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/mail/draft')) writes++;
    return { ok: true, status: 200, json: async () => ({ uid: 7, folder: 'Drafts' }) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: false, composing: true,
    composeData: { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
      to: ['to@example.test'], subject: 'Re: old', body: '<p>reply text</p>', signature: '' } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    assert.ok(document.querySelector('.tiptap'));
    await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), true));
    assert.equal(writes, 0);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('signature edits made during save are sent again before a switch', async () => {
  const requests = [];
  let finishFirst;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/mail/draft')) {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) await new Promise(resolve => { finishFirst = resolve; });
      return { ok: true, status: 200, json: async () => ({ uid: requests.length + 5, folder: 'Drafts' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [], signature: '<p>Old</p>' }],
    plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
      to: ['to@example.test'], subject: 'Re: old', body: 'reply', signature: '<p>Old</p>' } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    const signature = [...document.querySelectorAll('textarea')].find(el => el.value.includes('Old'));
    assert.ok(signature);
    const edit = async value => React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(signature, value);
      signature.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await edit('First edit');
    let preparing;
    await React.act(async () => { preparing = useStore.getState().prepareComposeSwitch(); await Promise.resolve(); });
    assert.equal(requests.length, 1);
    await edit('Second edit');
    await React.act(async () => { finishFirst(); assert.equal(await preparing, true); });
    assert.deepEqual(requests.map(r => r.editedSignature), ['First edit', 'Second edit']);
    assert.equal(requests[1].existingUid, 6);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('an imported draft shows its saved signature even without an account default', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [], signature: null }],
    plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
      to: ['to@example.test'], body: 'reply', signature: '<p>Saved signature</p>' } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    assert.ok([...document.querySelectorAll('textarea')].some(el => el.value === 'Saved signature'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('a send waiting for draft save stops a concurrent selection handoff', async () => {
  let finishSave;
  const requests = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/mail/draft')) {
      requests.push('draft');
      await new Promise(resolve => { finishSave = resolve; });
      return { ok: true, status: 200, json: async () => ({ uid: 6, folder: 'Drafts' }) };
    }
    if (path.endsWith('/mail/send')) requests.push('send');
    return { ok: true, status: 200, json: async () => ({ sentFolder: 'Sent' }) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
      source: 'inboxReplyDraft',
      to: ['to@example.test'], subject: 'Re: old', body: 'reply' } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Re: edited');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    let handoff;
    await React.act(async () => { handoff = useStore.getState().prepareComposeSwitch(); await Promise.resolve(); });
    assert.deepEqual(requests, ['draft']);
    const send = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'compose.send');
    assert.ok(send);
    await React.act(async () => { send.click(); await Promise.resolve(); });
    assert.deepEqual(requests, ['draft']);
    let handoffAllowed;
    await React.act(async () => { finishSave(); handoffAllowed = await handoff; await Promise.resolve(); });
    assert.equal(handoffAllowed, false);
    assert.ok(requests.includes('send'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('reopening the same draft keeps its mounted save handoff', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/mail/draft')) {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ uid: 6, folder: 'Drafts' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const opening = { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
    persistedKey: 'account-1:Drafts:5',
    source: 'inboxReplyDraft', to: ['to@example.test'], subject: 'Re: old', body: 'reply' };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: true, composeData: opening });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    const prepare = useStore.getState().prepareComposeSwitch;
    assert.equal(typeof prepare, 'function');
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Re: edited');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await React.act(async () => useStore.getState().openCompose({ ...opening, subject: 'stale' }));
    assert.equal(useStore.getState().prepareComposeSwitch, prepare);
    await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), true));
    assert.equal(requests[0].subject, 'Re: edited');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('an unsupported saved sender requires an explicit configured From choice', async () => {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/mail/send')) sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: true,
    composeData: { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
      to: ['recipient@example.test'], subject: 'Reply', body: 'Reply', signature: '',
      unsupportedFrom: 'external@example.test', references: '<parent@example.test>' } });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    const from = document.querySelector('select');
    assert.equal(from.value, '', 'the configured identity must not be silently preselected');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(from, 'account:account-1');
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const send = [...document.querySelectorAll('button')].find(el => el.textContent === 'compose.send');
    await React.act(async () => send.click());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].references, '<parent@example.test>');
    assert.equal(sent[0].editedSignature, '');
  } finally { await React.act(async () => root.unmount()); }
});

for (const action of ['save and close', 'send']) test(`an earlier ${action} cannot close a newer compose session`, async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  globalThis.fetch = async url => {
    if (String(url).endsWith(action === 'send' ? '/mail/send' : '/mail/draft')) return pending;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  useStore.setState({ accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: false, composeData: null });
  useStore.getState().openCompose({ accountId: 'account-1', to: ['recipient@example.test'], subject: 'Old', body: 'Reply', signature: '' });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    if (action === 'save and close') {
      const subject = document.querySelector('input[placeholder="compose.subject"]');
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Edited old');
        subject.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await React.act(async () => document.querySelector('[title="compose.toolbar.close"]').click());
      const save = [...document.querySelectorAll('button')].find(el => el.textContent === 'compose.closeDraft.save');
      assert.ok(save); await React.act(async () => save.click());
    } else {
      const send = [...document.querySelectorAll('button')].find(el => el.textContent === 'compose.send');
      assert.ok(send); await React.act(async () => send.click());
    }
    // Model a replacement already authorized by another flow while this response
    // is pending; ordinary Compose clicks now wait for the current writer.
    await React.act(async () => { useStore.getState().closeCompose(); useStore.getState().openCompose({ subject: 'New manual', body: 'New edits' }); });
    await React.act(async () => {
      finish({ ok: true, status: 200, json: async () => ({ uid: 6, folder: 'Drafts' }) });
      await new Promise(resolve => setImmediate(resolve));
    });
    assert.equal(useStore.getState().composing, true);
    assert.equal(useStore.getState().composeData.subject, 'New manual');
  } finally { await React.act(async () => root.unmount()); }
});

// A replacement editor must remount even if both open operations occur in one render.
test('replacing an open editor advances numeric ownership; duplicate persisted drafts keep edits', async () => {
  useStore.setState({ composing: false, composeData: null, prepareComposeSwitch: null });
  const store = useStore.getState();
  store.openCompose({ persistedKey: 'a:Drafts:5', subject: 'Original' });
  const first = useStore.getState().composeSession;
  store.openCompose({ persistedKey: 'a:Drafts:5', subject: 'Stale copy' });
  assert.equal(useStore.getState().composeSession, first);
  assert.equal(useStore.getState().composeData.subject, 'Original');
  useStore.setState({ prepareComposeSwitch: async () => true });
  await store.openCompose({ persistedKey: 'a:Drafts:6', subject: 'Other' });
  assert.equal(useStore.getState().composeSession, first + 1);
  store.updateComposePersistedKey(first, 'stale');
  assert.equal(useStore.getState().composeData.persistedKey, 'a:Drafts:6');
});

for (const withAttachment of [false, true]) test(`Undo-restored automatic reply ${withAttachment ? 'with attachments refuses' : 'saves before'} another reply handoff`, async () => {
  const { api } = await import('../utils/api.js');
  const original = { post: api.post, cancelSend: api.cancelSend, getSendStatus: api.getSendStatus, saveDraft: api.saveDraft };
  const writes = [];
  let pending = 0;
  api.post = async () => ({ pending: true, pendingId: `restore-${++pending}`, remainingMs: 10000 });
  api.cancelSend = async () => ({ cancelled: true });
  api.getSendStatus = async () => ({ status: 'pending' });
  api.saveDraft = async value => { writes.push(value); return { uid: 23, folder: 'Drafts' }; };
  useStore.setState({ user: { id: 'undo-owner' }, accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, notifications: [], composing: false, composeData: null });
  const first = { accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts', draftAccountId: 'account-1',
    persistedKey: 'account-1:Drafts:5', source: 'automaticReplyDraft', to: ['to@example.test'],
    cc: ['cc@example.test'], bcc: ['bcc@example.test'], subject: 'First reply', body: 'Edited after last save',
    signature: '<p>Saved signature</p>', inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>',
    ...(withAttachment ? { attachments: [{ name: 'note.txt', size: 3, type: 'text/plain', data: 'YWJj' }] } : {}) };
  useStore.getState().openCompose(first);
  const Host = () => {
    const composing = useStore(s => s.composing);
    const session = useStore(s => s.composeSession);
    return composing ? React.createElement(ComposeModal, { key: session }) : null;
  };
  const root = createRoot(document.getElementById('root'));
  const send = async () => React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send').click());
  try {
    await React.act(async () => root.render(React.createElement(Host)));
    await send();
    const undo = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => useStore.getState().openCompose({ ...first, persistedKey: 'account-1:Drafts:6', draftUid: 6, subject: 'Second reply', attachments: [] }));
    await React.act(async () => undo.onUndo());
    assert.equal(document.querySelector('input[placeholder="compose.subject"]').value, 'Second reply');
    await send();
    assert.equal(document.querySelector('input[placeholder="compose.subject"]').value, 'First reply');
    const restored = useStore.getState().composeData;
    assert.deepEqual(restored.cc, ['cc@example.test']);
    assert.deepEqual(restored.bcc, ['bcc@example.test']);
    assert.equal(restored.body, 'Edited after last save');
    assert.equal(restored.signature, 'Saved signature');
    let allowed;
    await React.act(async () => { allowed = await useStore.getState().prepareComposeSwitch(); });
    assert.equal(allowed, !withAttachment);
    assert.equal(writes.length, withAttachment ? 0 : 1);
    if (!withAttachment) {
      assert.equal(writes[0].existingUid, 5);
      assert.equal(writes[0].body, 'Edited after last save');
      assert.equal(useStore.getState().composeData.persistedKey, 'account-1:Drafts:23::');
    } else assert.match(document.body.textContent, /note\.txt/);
  } finally {
    await React.act(async () => { useStore.setState({ user: null }); root.unmount(); });
    Object.assign(api, original);
  }
});


test('explicit draft handoff adopts the revision from its real mounted save before revalidation', async () => {
  const { api } = await import('../utils/api.js');
  const { openReplyDraft } = await import('../utils/openReplyDraft.js');
  const original = { saveDraft: api.saveDraft, getReplyDraft: api.getReplyDraft };
  const saved = []; let lookups = 0;
  api.saveDraft = async value => { saved.push(value); return { uid: 6, folder: 'Drafts' }; };
  api.getReplyDraft = async () => { lookups++; return { draft: { id: 'new-draft', account_id: 'account-1', folder: 'Drafts', uid: 9,
    message_id: '<other-reply@example.test>', in_reply_to: '<other-parent@example.test>', attachments_complete: true },
    body: { text: 'Other reply', attachments: [] } }; };
  useStore.setState({ user: { id: 'save-owner' }, accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, selectedFolder: 'INBOX', selectedMessageId: 'other', selectedAccountId: null,
    composing: false, composeData: null, replyDraftRevision: 0 });
  useStore.getState().openCompose({ accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
    persistedKey: 'account-1:Drafts:5', source: 'automaticReplyDraft', subject: 'Old', to: ['to@example.test'], body: 'Reply', signature: '' });
  const Host = () => {
    const composing = useStore(s => s.composing); const session = useStore(s => s.composeSession);
    return composing ? React.createElement(ComposeModal, { key: session }) : null;
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(Host)));
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Edited current reply');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    let opened;
    await React.act(async () => { opened = await openReplyDraft('other'); });
    assert.equal(opened, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].subject, 'Edited current reply');
    assert.equal(lookups, 2);
    assert.equal(useStore.getState().replyDraftRevision, 1);
    assert.equal(useStore.getState().composeData.body, 'Other reply');
  } finally { await React.act(async () => root.unmount()); Object.assign(api, original); }
});

test('an automatic handoff save does not start a second observer lookup for its own invalidation', async () => {
  const Observer = (await import('./InboxReplyDraftObserver.js')).default;
  const { api } = await import('../utils/api.js');
  const original = { saveDraft: api.saveDraft, getReplyDraft: api.getReplyDraft, getReplyDraftIndicators: api.getReplyDraftIndicators };
  let calls = 0, release;
  const result = { draft: { id: 'new-draft', account_id: 'account-1', folder: 'Drafts', uid: 9,
    message_id: '<other-reply@example.test>', attachments_complete: true }, body: { text: 'Other reply', attachments: [] } };
  api.saveDraft = async () => ({ uid: 6, folder: 'Drafts' });
  api.getReplyDraftIndicators = async () => ({ indicators: {} });
  api.getReplyDraft = async () => { calls++; return calls === 2 ? new Promise(resolve => { release = () => resolve(result); }) : result; };
  useStore.setState({ user: { id: 'auto-save-owner' }, accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, selectedFolder: 'INBOX', selectedMessageId: null, selectedAccountId: null,
    messages: [{ id: 'other', account_id: 'account-1', folder: 'INBOX' }], threadMessages: {}, searchQuery: '', conversationMode: 'off',
    autoOpenReplyDrafts: false, composing: false, composeData: null, replyDraftRevision: 0, replyDrafts: {} });
  useStore.getState().openCompose({ accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
    persistedKey: 'account-1:Drafts:5', source: 'automaticReplyDraft', subject: 'Old', to: ['to@example.test'], body: 'Reply', signature: '' });
  const Host = () => {
    const composing = useStore(s => s.composing); const session = useStore(s => s.composeSession);
    return React.createElement(React.Fragment, null, React.createElement(Observer, { lookupDelayMs: 0 }),
      composing ? React.createElement(ComposeModal, { key: session }) : null);
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(Host)));
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Edited current reply');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
      useStore.setState({ autoOpenReplyDrafts: true, selectedMessageId: 'other' });
      await new Promise(resolve => setImmediate(resolve));
    });
    assert.equal(calls, 2, 'one body lookup, then post-save identity revalidation');
    await React.act(async () => { release(); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(useStore.getState().composeData.body, 'Other reply');
    assert.equal(calls, 2, 'the opened session must not trigger another lookup');
  } finally { if (release) release(); await React.act(async () => root.unmount()); Object.assign(api, original); }
});

test('a mounted draft save response cannot update a different signed-in owner', async () => {
  const { api } = await import('../utils/api.js');
  const original = api.saveDraft;
  let finish;
  api.saveDraft = () => new Promise(resolve => { finish = resolve; });
  useStore.setState({ user: { id: 'save-owner' }, accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: false, composeData: null, replyDraftRevision: 0 });
  useStore.getState().openCompose({ accountId: 'account-1', draftUid: 5, draftFolder: 'Drafts',
    persistedKey: 'account-1:Drafts:5', subject: 'Old', to: ['to@example.test'], body: 'Reply', signature: '', restored: true });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    let saving;
    await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); await Promise.resolve(); });
    await React.act(async () => useStore.getState().setUser({ id: 'new-owner' }));
    await React.act(async () => { finish({ uid: 6, folder: 'Drafts' }); assert.equal(await saving, false); });
    assert.equal(useStore.getState().composeData.persistedKey, 'account-1:Drafts:5');
    assert.equal(useStore.getState().replyDraftRevision, 0);
  } finally { await React.act(async () => root.unmount()); api.saveDraft = original; }
});

for (const action of ['save', 'resend']) test(`Undo-restored reply retains the original draft account when ${action} uses another sender`, async () => {
  const { api } = await import('../utils/api.js');
  const original = { saveDraft: api.saveDraft, post: api.post };
  const writes = [];
  api.saveDraft = async value => { writes.push(value); return { uid: 6, folder: 'Drafts' }; };
  api.post = async (_path, value) => { writes.push(value); return {}; };
  useStore.setState({ user: { id: 'undo-owner' }, accounts: [
    { id: 'old-account', email_address: 'old@example.test', aliases: [] },
    { id: 'send-account', email_address: 'send@example.test', aliases: [] },
  ], plaintextEmail: true, composing: false, composeData: null, notifications: [] });
  useStore.getState().openCompose({ accountId: 'send-account', draftAccountId: 'old-account',
    draftUid: 5, draftFolder: 'Drafts', persistedKey: 'old-account:Drafts:5',
    to: ['to@example.test'], subject: 'Restored reply', body: 'Reply', signature: '', restored: true });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(ComposeModal)));
    if (action === 'save') await React.act(async () => assert.equal(await useStore.getState().prepareComposeSwitch(), true));
    else await React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send').click());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].accountId, 'send-account');
    if (action === 'save') {
      assert.equal(writes[0].existingAccountId, 'old-account');
      assert.equal(writes[0].existingUid, 5);
    } else assert.deepEqual(writes[0].draft, { accountId: 'old-account', uid: 5, folder: 'Drafts' });
  } finally { await React.act(async () => root.unmount()); Object.assign(api, original); }
});

for (const outcome of ['saved', 'failed', 'unsupported']) test(`ordinary compose replacement preserves dirty editor until ${outcome} handoff`, async () => {
  const { api } = await import('../utils/api.js');
  const original = api.saveDraft;
  const writes = [];
  let finish;
  api.saveDraft = value => { writes.push(value); return new Promise((resolve, reject) => { finish = () => outcome === 'failed' ? reject(new Error('Save failed')) : resolve({ uid: 9, folder: 'Drafts' }); }); };
  useStore.setState({ user: { id: 'manual-owner' }, accounts: [{ id: 'account-1', email_address: 'me@example.test', aliases: [] }],
    plaintextEmail: true, composing: false, composeData: null, prepareComposeSwitch: null });
  useStore.getState().openCompose({ accountId: 'account-1', to: ['to@example.test'], subject: 'Current', body: 'Reply', signature: '',
    ...(outcome === 'unsupported' ? { unsupportedFrom: 'other@example.test' } : {}) });
  const session = useStore.getState().composeSession;
  const Host = () => {
    const composing = useStore(s => s.composing);
    const session = useStore(s => s.composeSession);
    return composing ? React.createElement(ComposeModal, { key: session }) : null;
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(Host)));
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(subject, 'Unsaved edits');
      subject.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    let opening;
    await React.act(async () => { opening = useStore.getState().openCompose({ accountId: 'account-1', subject: 'New manual' }); await Promise.resolve(); });
    assert.equal(useStore.getState().composeSession, session);
    assert.equal(document.querySelector('input[placeholder="compose.subject"]').value, 'Unsaved edits');
    if (outcome === 'unsupported') assert.equal(writes.length, 0);
    else { assert.equal(writes[0].subject, 'Unsaved edits'); await React.act(async () => finish()); }
    await React.act(async () => assert.equal(await opening, outcome === 'saved'));
    assert.equal(useStore.getState().composeSession, session + (outcome === 'saved' ? 1 : 0));
    assert.equal(document.querySelector('input[placeholder="compose.subject"]').value, outcome === 'saved' ? 'New manual' : 'Unsaved edits');
  } finally { await React.act(async () => root.unmount()); api.saveDraft = original; }
});
