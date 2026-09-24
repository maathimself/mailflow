import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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
      sessionKey: 'saved:draft-1', persistedKey: 'account-1:Drafts:5',
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
    assert.equal(useStore.getState().composeData.persistedKey, 'account-1:Drafts:6');
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
      sessionKey: 'saved:draft-1', source: 'inboxReplyDraft',
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
    sessionKey: 'saved:draft-1', persistedKey: 'account-1:Drafts:5',
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
