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


// The signature on/off toggle (#555): a per-message choice, a per-mailbox default, and an off
// state that is saved with drafts and sent as an empty override.

const requests = [];
globalThis.fetch = async (url, options) => {
  const path = String(url);
  if (path.endsWith('/mail/draft')) { requests.push(['draft', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ uid: 40 + requests.length, folder: 'Drafts' }) }; }
  if (path.endsWith('/mail/send')) { requests.push(['send', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ messageId: '<x@y>' }) }; }
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [
  { id: 'on', email_address: 'on@example.test', aliases: [], signature: '<p>On sig</p>', signature_enabled: true },
  { id: 'off', email_address: 'off@example.test', aliases: [], signature: '<p>Off sig</p>', signature_enabled: false },
];
const toggle = () => document.querySelector('button[aria-label="compose.insertSignature"]');
const signatureBox = () => [...document.querySelectorAll('textarea')].find(el => /sig|Edited/.test(el.value));
const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const setText = (el, value) => React.act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
});
async function mount(composeData, { plain = true } = {}) {
  requests.length = 0;
  useStore.setState({ accounts: ACCOUNTS, plaintextEmail: plain, composing: true, prepareComposeSwitch: null, composeData });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  return root;
}
const unmount = root => React.act(async () => root.unmount());
const send = async () => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('compose.send'));
  await click(button);
  await React.act(async () => { await new Promise(r => setImmediate(r)); });
  return requests.filter(([kind]) => kind === 'send').map(([, body]) => body);
};
const save = async () => {
  await React.act(async () => { await useStore.getState().prepareComposeSwitch(); });
  return requests.filter(([kind]) => kind === 'draft').map(([, body]) => body);
};

test('off sends an empty signature override, and turning it back on keeps the edits', async () => {
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    assert.equal(toggle().getAttribute('aria-pressed'), 'true');
    await setText(signatureBox(), 'Edited sig');
    await click(toggle());
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    assert.equal(signatureBox(), undefined, 'the signature is hidden while off');
    await click(toggle());
    assert.equal(signatureBox().value, 'Edited sig');
    await click(toggle());
    const [sent] = await send();
    assert.equal(sent.editedSignature, '');
  } finally { await unmount(root); }
});

test('a mailbox with the default off starts off, and changing From applies the new default', async () => {
  const root = await mount({ accountId: 'off', to: ['to@example.test'], subject: 's', body: 'hi' });
  try {
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    const from = document.querySelector('select');
    await React.act(async () => { from.value = 'account:on'; from.dispatchEvent(new window.Event('change', { bubbles: true })); });
    assert.equal(toggle().getAttribute('aria-pressed'), 'true');
    assert.equal(signatureBox().value, 'On sig');
    const [sent] = await send();
    assert.equal(sent.editedSignature, 'On sig');
  } finally { await unmount(root); }
});

test('a default applied by a From change is not an edit, but the toggle is', async () => {
  // Both mailboxes share the signature text, so only the default differs. (On main a From change
  // that swaps in a different signature already counts as an edit, toggle or not.)
  useStore.setState({ accounts: [...ACCOUNTS.slice(0, 1), { id: 'off', email_address: 'off@example.test', aliases: [], signature: '<p>On sig</p>', signature_enabled: false }] });
  requests.length = 0;
  useStore.setState({ plaintextEmail: true, composing: true, prepareComposeSwitch: null, composeData: { accountId: 'off', to: ['to@example.test'], subject: 's', body: 'hi' } });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  try {
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    const from = document.querySelector('select');
    await React.act(async () => { from.value = 'account:on'; from.dispatchEvent(new window.Event('change', { bubbles: true })); });
    assert.deepEqual(await save(), [], 'an untouched composer has nothing to save');
    await click(toggle());
    const [draft] = await save();
    assert.equal(draft.editedSignature, '', 'off is saved as an empty signature');
  } finally { await unmount(root); }
});

test('a draft saved with the signature off reopens off, with the From signature ready', async () => {
  const root = await mount({ accountId: 'on', draftUid: 7, draftFolder: 'Drafts', to: ['to@example.test'], subject: 'Re: s', body: 'reply', signature: '' });
  try {
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    assert.equal(signatureBox(), undefined);
    await click(toggle());
    assert.equal(signatureBox().value, 'On sig');
  } finally { await unmount(root); }
});

test('a draft saved with a signature reopens on, whatever the mailbox default', async () => {
  const root = await mount({ accountId: 'off', draftUid: 8, draftFolder: 'Drafts', to: ['to@example.test'], subject: 'Re: s', body: 'reply', signature: '<p>Saved sig</p>' });
  try {
    assert.equal(toggle().getAttribute('aria-pressed'), 'true');
    assert.equal(signatureBox().value, 'Saved sig');
  } finally { await unmount(root); }
});

test('there is no toggle without a signature to turn on', async () => {
  useStore.setState({ accounts: [{ id: 'none', email_address: 'none@example.test', aliases: [], signature: null }] });
  requests.length = 0;
  useStore.setState({ plaintextEmail: true, composing: true, prepareComposeSwitch: null, composeData: { accountId: 'none', to: ['to@example.test'], subject: 's', body: 'hi' } });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  try { assert.equal(toggle(), null); } finally { await unmount(root); }
});

for (const plain of [true, false]) test(`the toggle is in the ${plain ? 'plain-text footer' : 'rich-text toolbar'} on a desktop`, async () => {
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' }, { plain });
  try { assert.ok(toggle()); } finally { await unmount(root); }
});

for (const plain of [true, false]) test(`the toggle is reachable on a phone (${plain ? 'plain text' : 'rich text'})`, async () => {
  // useMobile() reads window.innerWidth first.
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  const root = await mount({ accountId: 'on', to: ['to@example.test'], subject: 's', body: 'hi' }, { plain });
  try {
    assert.ok(toggle());
    // Plain text has no toolbar on a phone; its strip also carries the attach button.
    if (plain) assert.ok(document.querySelector('button[aria-label="compose.toolbar.attachFile"]'));
    const signatureShown = () => [...document.querySelectorAll('div')].some(el => el.textContent.trim() === '-- signature');
    assert.equal(signatureShown(), true);
    await click(toggle());
    assert.equal(toggle().getAttribute('aria-pressed'), 'false');
    assert.equal(signatureShown(), false, 'the signature is hidden while off');
  } finally {
    await unmount(root);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }
});
