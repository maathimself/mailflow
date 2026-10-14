// Images a reader loaded through MailFlow's image proxy, in the composer: a reply's or forward's
// quoted email and a reopened draft keep the proxy URLs while they are on screen, so opening the
// composer never loads an image from its sender, and what is sent or saved carries the email's
// own references, which recipients and other mail clients can load.

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


const requests = [];
globalThis.fetch = async (url, options) => {
  const path = String(url);
  if (path.endsWith('/mail/draft')) { requests.push(['draft', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ uid: 40 + requests.length, folder: 'Drafts' }) }; }
  if (path.endsWith('/mail/send')) { requests.push(['send', JSON.parse(options.body)]); return { ok: true, status: 200, json: async () => ({ messageId: '<x@y>' }) }; }
  return { ok: true, status: 200, json: async () => ({}) };
};
const ACCOUNTS = [{ id: 'acct', email_address: 'me@example.test', aliases: [], signature: '', signature_enabled: true }];

const proxyOf = (id, raw) => `/api/mail/messages/${id}/image?u=${encodeURIComponent(raw)}`;
const QUOTED_RAW = 'https://img.example/logo.png?x=1&amp;y=2';
const BODY_RAW = 'https://img.example/draft.png';
const SIG_RAW = 'https://img.example/sig.png';
const ORIGINAL = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const DRAFT = '9a1b2c3d-0000-4000-8000-000000000001';
const quoted = `<div><p>On Monday, Ann wrote:</p><img src="${proxyOf(ORIGINAL, QUOTED_RAW)}" alt="logo"></div>`;

const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
async function mount(composeData) {
  requests.length = 0;
  useStore.setState({ accounts: ACCOUNTS, plaintextEmail: false, composing: true, prepareComposeSwitch: null, composeData });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(ComposeModal)));
  await React.act(async () => {});
  return root;
}
const unmount = root => React.act(async () => root.unmount());
const send = async () => {
  await click([...document.querySelectorAll('button')].find(b => b.textContent.includes('compose.send')));
  await React.act(async () => { await new Promise(r => setImmediate(r)); });
  return requests.filter(([kind]) => kind === 'send').map(([, body]) => body);
};
const save = async () => {
  await React.act(async () => { await useStore.getState().prepareComposeSwitch(); });
  return requests.filter(([kind]) => kind === 'draft').map(([, body]) => body);
};
const edit = () => React.act(async () => { document.querySelector('.ProseMirror').editor.commands.insertContent('Thanks.'); });
// Every image the composer puts on screen, by the address the browser would load.
const shownImages = () => [...document.querySelectorAll('img')].map(img => img.getAttribute('src'));

const reply = {
  accountId: 'acct', to: ['ann@example.test'], subject: 'Re: Hi', body: '', isReply: true,
  quotedBody: '\n\n> hi', quotedBodyHtml: quoted,
};
const draft = {
  accountId: 'acct', draftUid: 7, draftFolder: 'Drafts', to: ['ann@example.test'], subject: 'Re: Hi', bodyIsHtml: true,
  body: `<p>Draft</p><p><img src="${proxyOf(DRAFT, BODY_RAW)}"></p>`,
  signature: `<p>Me</p><img src="${proxyOf(DRAFT, SIG_RAW)}">`,
};

test('a reply shows the quoted images through the proxy and sends the email\'s own references', async () => {
  const root = await mount(reply);
  try {
    const shown = shownImages();
    assert.ok(shown.includes(proxyOf(ORIGINAL, QUOTED_RAW)), `the quoted image is shown through the proxy: ${shown}`);
    assert.ok(shown.every(src => !/img\.example/.test(src.split('?')[0]) && src.startsWith('/api/')), `nothing loads from the sender: ${shown}`);
    const [sent] = await send();
    assert.match(sent.quotedBodyHtml, /src="https:\/\/img\.example\/logo\.png\?x=1&amp;y=2"/);
    assert.doesNotMatch(sent.quotedBodyHtml, /\/api\/mail/);
  } finally { await unmount(root); }
});

test('a reply\'s saved draft carries the email\'s own references', async () => {
  const root = await mount(reply);
  try {
    await edit();
    const [saved] = await save();
    assert.match(saved.quotedBodyHtml, /src="https:\/\/img\.example\/logo\.png\?x=1&amp;y=2"/);
    assert.doesNotMatch(saved.quotedBodyHtml, /\/api\/mail/);
  } finally { await unmount(root); }
});

test('a reopened draft shows its images through the proxy and saves and sends its own references', async () => {
  const root = await mount(draft);
  try {
    const shown = shownImages();
    assert.ok(shown.length >= 2 && shown.every(src => src.startsWith('/api/mail/messages/')), `nothing loads from the sender: ${shown}`);
    await edit();
    const [saved] = await save();
    assert.match(saved.body, /src="https:\/\/img\.example\/draft\.png"/);
    assert.match(saved.editedSignature, /src="https:\/\/img\.example\/sig\.png"/);
    assert.doesNotMatch(`${saved.body}${saved.editedSignature}`, /\/api\/mail/);
    const [sent] = await send();
    assert.match(sent.body, /src="https:\/\/img\.example\/draft\.png"/);
    assert.match(sent.editedSignature, /src="https:\/\/img\.example\/sig\.png"/);
    assert.doesNotMatch(`${sent.body}${sent.editedSignature}`, /\/api\/mail/);
  } finally { await unmount(root); }
});
