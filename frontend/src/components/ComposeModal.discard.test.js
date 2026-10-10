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


// The Discard button (#573): delete whatever the composer saved to Drafts, then close, without
// leaving an orphan behind when an autosave is still running.

const requests = [];
let draftResponder = null;   // set to hold a draft save open
let deleteStatus = 200;
let deleteGate = null;       // set to hold a delete open
globalThis.fetch = async (url, options = {}) => {
  const path = String(url);
  const method = options.method || 'GET';
  if (path.endsWith('/mail/draft') && method === 'POST') {
    requests.push(['draft', JSON.parse(options.body)]);
    const uid = 40 + requests.filter(([k]) => k === 'draft').length;
    if (draftResponder) await new Promise(resolve => { draftResponder = resolve; });
    return { ok: true, status: 200, json: async () => ({ uid, folder: 'Drafts' }) };
  }
  if (method === 'DELETE' && path.includes('/mail/draft/')) {
    requests.push(['delete', path.slice(path.indexOf('/mail/draft/'))]);
    if (deleteGate) await new Promise(resolve => { deleteGate = resolve; });
    return { ok: deleteStatus === 200, status: deleteStatus, json: async () => (deleteStatus === 200 ? { ok: true } : { error: 'IMAP down' }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [{ id: 'on', email_address: 'on@example.test', aliases: [], signature: '', signature_enabled: false }];
const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const settle = () => React.act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); });
const buttons = () => [...document.querySelectorAll('button')];
const byText = text => buttons().find(b => b.textContent.trim() === text);
const discardButton = () => buttons().find(b => b.getAttribute('aria-label') === 'compose.discard');
const deletes = () => requests.filter(([k]) => k === 'delete').map(([, p]) => p);
const drafts = () => requests.filter(([k]) => k === 'draft');
async function mount(composeData) {
  requests.length = 0; draftResponder = null; deleteStatus = 200; deleteGate = null;
  useStore.setState({ accounts: ACCOUNTS, plaintextEmail: true, composing: true, prepareComposeSwitch: null, composeData });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  return root;
}
const unmount = root => React.act(async () => root.unmount());
const subjectInput = () => document.querySelector('input[placeholder="compose.subject"], input[placeholder="compose.subjectPh"]');
const edit = (value = 'typed') => React.act(async () => {
  const input = subjectInput();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
// A prefilled composer starts clean, so type first: only a dirty composer saves.
const save = async () => { await edit(); await React.act(async () => { await useStore.getState().prepareComposeSwitch(); }); };

test('an empty composer with nothing saved closes on Discard without asking', async () => {
  const root = await mount({ accountId: 'on' });
  try {
    await click(discardButton());
    await settle();
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(deletes(), []);
  } finally { await unmount(root); }
});

test('Discard after an autosave confirms, deletes that draft and closes', async () => {
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    await save();
    assert.equal(drafts().length, 1);
    await click(discardButton());
    assert.ok(document.body.textContent.includes('compose.discardDraft.title'), 'asks before deleting');
    assert.equal(byText('compose.closeDraft.save'), undefined, 'the Discard confirmation offers no Save');
    assert.equal(useStore.getState().composing, true);
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.deepEqual(deletes(), ['/mail/draft/41?accountId=on&folder=Drafts']);
    assert.equal(useStore.getState().composing, false);
  } finally { await unmount(root); }
});

test('Keep editing leaves the draft and the composer alone', async () => {
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    await save();
    await click(discardButton());
    await click(byText('compose.discardDraft.keepEditing'));
    await settle();
    assert.deepEqual(deletes(), []);
    assert.equal(useStore.getState().composing, true);
  } finally { await unmount(root); }
});

test('a save still running when Discard is confirmed is waited for, and its draft is the one deleted', async () => {
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    draftResponder = true;
    let saving;
    await edit();
    await React.act(async () => { saving = useStore.getState().prepareComposeSwitch(); });
    await click(discardButton());
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.deepEqual(deletes(), [], 'no delete before the running save has answered');
    await React.act(async () => { draftResponder(); await saving; });
    await settle();
    assert.deepEqual(deletes(), ['/mail/draft/41?accountId=on&folder=Drafts']);
    assert.equal(drafts().length, 1, 'no save after Discard started');
    assert.equal(useStore.getState().composing, false);
  } finally { await unmount(root); }
});

test('a failed delete keeps the composer open with an error, and Discard can be retried', async () => {
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    await save();
    deleteStatus = 500;
    await click(discardButton());
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.equal(useStore.getState().composing, true);
    assert.ok(document.body.textContent.includes('compose.discardFailed'));
    deleteStatus = 200;
    await click(discardButton());
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.equal(deletes().length, 2);
    assert.equal(useStore.getState().composing, false);
  } finally { await unmount(root); }
});

test('a draft opened from Drafts is the one Discard deletes', async () => {
  const root = await mount({ accountId: 'on', draftUid: 12, draftFolder: 'Drafts', draftAccountId: 'on',
    to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    await click(discardButton());
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.deepEqual(deletes(), ['/mail/draft/12?accountId=on&folder=Drafts']);
  } finally { await unmount(root); }
});

test('closing with unsaved edits still offers Save, and its Discard closes without a delete when nothing was saved', async () => {
  const root = await mount({ accountId: 'on' });
  try {
    await edit();
    await click(buttons().find(b => b.getAttribute('title') === 'compose.toolbar.close'));
    assert.ok(byText('compose.closeDraft.save'), 'the close prompt still offers Save');
    await click(byText('compose.closeDraft.discard'));
    await settle();
    assert.deepEqual(deletes(), []);
    assert.equal(useStore.getState().composing, false);
  } finally { await unmount(root); }
});

test('on mobile the header Discard uses the bottom sheet and deletes the saved draft', async () => {
  const width = window.innerWidth;
  window.innerWidth = 390;
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    await save();
    await click(discardButton());
    assert.ok(document.body.textContent.includes('compose.discardDraft.title'));
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.deepEqual(deletes(), ['/mail/draft/41?accountId=on&folder=Drafts']);
    assert.equal(useStore.getState().composing, false);
  } finally { await unmount(root); window.innerWidth = width; }
});

test('no save runs once Discard has started, even while the delete is still on its way', async () => {
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    await save();
    deleteGate = true;
    await click(discardButton());
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.equal(deletes().length, 1);
    await edit('typed again');
    await React.act(async () => { await useStore.getState().prepareComposeSwitch?.(); });
    assert.equal(drafts().length, 1, 'a save during the delete would recreate the draft');
    await React.act(async () => { deleteGate(); });
    await settle();
    assert.equal(useStore.getState().composing, false);
  } finally { await unmount(root); }
});

test('the Discard confirmation never offers Save, even with unsaved edits', async () => {
  const root = await mount({ accountId: 'on' });
  try {
    await edit();
    await click(discardButton());
    assert.ok(document.body.textContent.includes('compose.discardDraft.title'));
    assert.equal(byText('compose.closeDraft.save'), undefined);
    await click(byText('compose.discardDraft.discard'));
    await settle();
    assert.deepEqual(deletes(), []);
    assert.equal(useStore.getState().composing, false);
  } finally { await unmount(root); }
});
