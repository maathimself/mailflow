// Render test for MessagePane.
//
// Every other frontend test covers a .js util. This one mounts the actual component, because
// the AI-run changes (#428) live in its effects and its refs, and a unit test of the registry
// cannot tell you the component still mounts, still re-renders when you change message, and
// still leaves in-flight runs alone. Those are exactly the ways that change could regress.
//
// node --test cannot parse JSX, so the loader hook below transforms .jsx with sucrase, which is
// already present via the build toolchain. react-i18next is stubbed because the component only
// needs t() to return something; wiring a real i18n instance would test i18next, not this.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join("\n") };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    // import.meta.env is Vite's; Node has no equivalent, so point it at a stub object.
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// jsdom implements neither of these, and the component asks the window for both.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { aiRuns } = await import('../utils/aiRunRegistry.js');
const MessagePane = (await import('./MessagePane.jsx')).default;

const MSG_A = { id: 'a1', account_id: 'acct', folder: 'INBOX', uid: 1, subject: 'First', from_email: 'x@y.z', from_name: 'X', date: new Date().toISOString(), is_read: true, to_addresses: [], cc_addresses: [] };
const MSG_B = { ...MSG_A, id: 'b2', uid: 2, subject: 'Second' };
const ctrl = () => ({ aborted: false, abort() { this.aborted = true; } });

let root;
before(() => {
  useStore.getState().setUser({ id: 'u1' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([{ id: 'acct', enabled: true, email_address: 'x@y.z', color: '#fff' }]);
  useStore.getState().setMessages?.([MSG_A, MSG_B]);
  root = createRoot(document.getElementById('root'));
});
after(async () => { await React.act(async () => root.unmount()); aiRuns.abortAll(); });

describe('MessagePane renders', () => {
  test('mounts with a message selected without throwing', async () => {
    useStore.getState().setSelectedMessage('a1');
    await React.act(async () => { root.render(React.createElement(MessagePane)); });
    assert.ok(document.getElementById('root').innerHTML.length > 0, 'rendered something');
  });

  test('changing the selected message re-renders without throwing', async () => {
    await React.act(async () => { useStore.getState().setSelectedMessage('b2'); });
    assert.ok(document.getElementById('root').innerHTML.length > 0);
  });
});

describe('MessagePane leaves in-flight AI runs alone (#428)', () => {
  test('navigating to another message does not abort a run', async () => {
    // The regression this guards: the pane used to abort every in-flight run whenever the
    // selected message changed, so the result was discarded and never persisted.
    const run = ctrl();
    aiRuns.start('a1', 'summarize', run);
    await React.act(async () => { useStore.getState().setSelectedMessage('a1'); });
    await React.act(async () => { useStore.getState().setSelectedMessage('b2'); });
    assert.equal(run.aborted, false, 'a run must survive navigating away from its message');
    assert.equal(aiRuns.size, 1);
  });

  test('unmounting the pane does not abort a run either', async () => {
    // The pane also unmounts when a pop-out closes or the layout changes.
    const run = ctrl();
    aiRuns.start('a1', 'translate', run);
    await React.act(async () => { root.unmount(); });
    assert.equal(run.aborted, false, 'closing a pop-out must not cancel work in progress');
    root = createRoot(document.getElementById('root'));
  });
});

describe('Download all asks first when an attachment is risky', () => {
  const MSG_BLOCK = { ...MSG_A, id: 'c3', uid: 3, subject: 'Invoice' };
  const MSG_SAFE = { ...MSG_A, id: 'd4', uid: 4, subject: 'Photos' };
  const MSG_WARN = { ...MSG_A, id: 'e5', uid: 5, subject: 'Login page' };
  const ATTACHMENTS = {
    c3: [
      { filename: 'invoice.pdf', type: 'application/pdf', part: '2', size: 10 },
      { filename: 'invoice.pdf.exe', type: 'application/octet-stream', part: '3', size: 10 },
    ],
    d4: [
      { filename: 'rink-1.jpg', type: 'image/jpeg', part: '2', size: 10 },
      { filename: 'rink-2.jpg', type: 'image/jpeg', part: '3', size: 10 },
    ],
    e5: [
      { filename: 'photo.jpg', type: 'image/jpeg', part: '2', size: 10 },
      { filename: 'account-login.html', type: 'text/html', part: '3', size: 10 },
    ],
  };
  const downloads = [];
  let originalFetch, originalClick;
  before(() => {
    // Rendering a body measures it on the next frame, which jsdom does not provide.
    globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
    dom.window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
    dom.window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const id = /\/messages\/([^/]+)\/body/.exec(String(url))?.[1];
      const json = ATTACHMENTS[id] ? { html: '<p>hi</p>', text: 'hi', attachments: ATTACHMENTS[id] } : {};
      return { ok: true, status: 200, json: async () => json, text: async () => '' };
    };
    // jsdom cannot download. Record the downloads the component starts itself instead.
    originalClick = dom.window.HTMLAnchorElement.prototype.click;
    dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.getAttribute('href')); };
    useStore.getState().setMessages?.([MSG_A, MSG_B, MSG_BLOCK, MSG_SAFE, MSG_WARN]);
  });
  after(() => {
    globalThis.fetch = originalFetch;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  });

  async function open(id) {
    await React.act(async () => {
      useStore.getState().setSelectedMessage(id);
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
  }

  const downloadAllLink = () => {
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.includes('message.downloadAll'));
    assert.ok(link, 'the Download all link is rendered');
    return link;
  };

  async function fire(event) {
    const link = downloadAllLink();
    await React.act(async () => { link.dispatchEvent(event); });
    return downloadAllLink();
  }
  const click = () => fire(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  const armedNote = /message\.attachmentRisk\.confirm/;

  test('with a blocked file, the link has nothing to fetch until a second click downloads', async () => {
    await open('c3');
    // No href means a right-click "Save link as", a middle click or a long press cannot get the zip either.
    assert.equal(downloadAllLink().hasAttribute('href'), false);
    downloads.length = 0;

    const armed = await click();
    assert.match(armed.textContent, armedNote);
    assert.equal(armed.hasAttribute('href'), false, 'arming does not expose the zip');
    assert.deepEqual(downloads, [], 'the first click must not download');

    const done = await click();
    assert.deepEqual(downloads, ['/api/mail/messages/c3/attachments.zip'], 'the second click downloads once');
    assert.doesNotMatch(done.textContent, armedNote, 'and the link asks again next time');
  });

  test('a warn-level file alone is enough to ask, and Enter arms it like a click', async () => {
    await open('e5');
    const link = downloadAllLink();
    assert.equal(link.hasAttribute('href'), false);
    assert.equal(link.getAttribute('role'), 'button');
    downloads.length = 0;
    const armed = await fire(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.match(armed.textContent, armedNote);
    assert.deepEqual(downloads, []);
  });

  test('switching messages drops a half-confirmed Download all', async () => {
    await open('c3');
    assert.match((await click()).textContent, armedNote);
    await open('d4');
    await open('c3');
    assert.doesNotMatch(downloadAllLink().textContent, armedNote);
  });

  test('with only safe attachments, it stays a plain download link', async () => {
    await open('d4');
    const link = downloadAllLink();
    assert.equal(link.getAttribute('href'), '/api/mail/messages/d4/attachments.zip');
    assert.equal(link.hasAttribute('download'), true);
    let cancelled;
    const record = e => { cancelled = e.defaultPrevented; e.preventDefault(); };
    document.addEventListener('click', record);
    const after = await click();
    document.removeEventListener('click', record);
    assert.equal(cancelled, false, 'the first click downloads');
    assert.doesNotMatch(after.textContent, armedNote);
  });
});
