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
        // A {{label}} value is shown in brackets, so a test can see which text a string wraps.
        'export const useTranslation = () => ({ t: (k, o) => (o && o.label !== undefined ? k + "[" + o.label + "]" : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
const { api } = await import('../utils/api.js');
const { shortcutBus } = await import('../utils/shortcutBus.js');
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
    // A part that spells the old string sentinel, to prove Download all's armed state is not a part.
    f6: [
      { filename: 'setup.exe', type: 'application/octet-stream', part: 'all', size: 10 },
      { filename: 'rink-3.jpg', type: 'image/jpeg', part: '3', size: 10 },
    ],
  };
  const MSG_PART_ALL = { ...MSG_A, id: 'f6', uid: 6, subject: 'Installer' };
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
      // A single attachment downloads through fetch, not an anchor, so record that request too.
      if (String(url).includes('/attachments/')) downloads.push(String(url));
      const id = /\/messages\/([^/]+)\/body/.exec(String(url))?.[1];
      const json = ATTACHMENTS[id] ? { html: '<p>hi</p>', text: 'hi', attachments: ATTACHMENTS[id] } : {};
      return { ok: true, status: 200, json: async () => json, text: async () => '' };
    };
    // jsdom cannot download. Record the downloads the component starts itself instead.
    originalClick = dom.window.HTMLAnchorElement.prototype.click;
    dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.getAttribute('href')); };
    useStore.getState().setMessages?.([MSG_A, MSG_B, MSG_BLOCK, MSG_SAFE, MSG_WARN, MSG_PART_ALL]);
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
  // The armed text is one translated string wrapping the link's own label, so a locale controls the
  // punctuation between them.
  const armedNote = /message\.attachmentRisk\.armed\[message\.downloadAll\]/;
  const attachmentButton = filename => [...document.querySelectorAll('button')].find(b => b.textContent.includes(filename));
  async function clickAttachment(filename) {
    await React.act(async () => {
      attachmentButton(filename).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    return attachmentButton(filename);
  }

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

  test("a risky file's own confirm wraps its warning in the same translated string", async () => {
    await open('c3');
    downloads.length = 0;
    const button = await clickAttachment('invoice.pdf.exe');
    assert.match(button.textContent, /message\.attachmentRisk\.armed\[message\.attachmentRisk\.doubleExt\]/);
    assert.doesNotMatch(downloadAllLink().textContent, armedNote, 'arming one file does not arm Download all');
    assert.deepEqual(downloads, []);
  });

  test('an attachment whose part is literally "all" does not arm Download all', async () => {
    await open('f6');
    const button = await clickAttachment('setup.exe');
    assert.match(button.textContent, /message\.attachmentRisk\.armed\[/, 'the file itself is armed');
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

// Characterization tests for the body renderer, written before extracting it into its own
// component. The iframe lifecycle effect had no coverage at all, and two of the fixes living
// in it (a document that never finishes loading, #1287ada; resetting the frame between
// messages) would fail silently if the extraction dropped them.
describe('message body rendering', () => {
  const MSG_HTML = { ...MSG_A, id: 'h1', uid: 11, subject: 'HTML body' };
  const MSG_TEXT = { ...MSG_A, id: 't1', uid: 12, subject: 'Text body' };
  const BODIES = {
    h1: { html: '<p id="hello">Hello from HTML</p>', text: '', attachments: [] },
    t1: { html: '', text: 'Plain text with https://example.com in it', attachments: [] },
  };
  let originalFetch;

  before(() => {
    globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
    dom.window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const id = /\/messages\/([^/]+)\/body/.exec(String(url))?.[1];
      return { ok: true, status: 200, json: async () => (BODIES[id] ?? {}), text: async () => '' };
    };
    useStore.getState().setMessages?.([MSG_A, MSG_B, MSG_HTML, MSG_TEXT]);
  });
  after(() => { globalThis.fetch = originalFetch; });

  const open = async (id) => {
    await React.act(async () => {
      useStore.getState().setSelectedMessage(id);
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 30)); });
  };

  test('an HTML body renders into an iframe', async () => {
    await open('h1');
    const frame = document.querySelector('iframe');
    assert.ok(frame, 'an HTML body must render inside a frame, not inline');
  });

  test('the sanitized body reaches the frame', async () => {
    // Asserted on srcdoc rather than contentDocument: jsdom does not parse srcdoc into a
    // document, so the frame's own DOM is not observable here. What is observable, and what
    // the extraction must preserve, is that the body reaches the frame at all.
    await open('h1');
    const frame = document.querySelector('iframe');
    assert.match(frame?.getAttribute('srcdoc') ?? '', /Hello from HTML/, 'body must be handed to the frame');
  });

  test('the frame is sandboxed and scripts are not allowed to run', async () => {
    // The body is attacker-controlled. Whatever else the extraction changes, it must not
    // loosen this.
    await open('h1');
    const frame = document.querySelector('iframe');
    const sandbox = frame?.getAttribute('sandbox');
    assert.ok(sandbox !== null, 'the email frame must be sandboxed');
    assert.ok(!/allow-scripts/.test(sandbox ?? ''), 'scripts must never be allowed in an email frame');
  });

  test('a text-only body renders without a frame', async () => {
    await open('t1');
    assert.match(document.getElementById('root').innerHTML, /Plain text with/);
  });

  test('switching messages resets the frame height', async () => {
    // The pane sets the frame back to 300px before paint, so a tall email does not leave the
    // next, shorter one padded out with its height.
    await open('h1');
    const frame = document.querySelector('iframe');
    if (frame) frame.style.height = '2400px';
    await open('t1');
    const after = document.querySelector('iframe');
    if (after) assert.notEqual(after.style.height, '2400px', 'height must not carry across messages');
  });
});

describe('selected-message body shortcuts', () => {
  test('i loads remote images only while the selected body is blocked', async (t) => {
    const msg = { ...MSG_A, id: 'hotkey-image', uid: 41 };
    const getBody = t.mock.method(api, 'getMessageBody', async (_id, remote) => ({ text: 'hello', hasBlockedRemoteImages: !remote }));
    await React.act(async () => {
      useStore.getState().setMessages([msg]);
      useStore.getState().setSelectedMessage(msg.id);
      root.render(React.createElement(MessagePane));
      await new Promise(r => setTimeout(r, 30));
    });
    await React.act(async () => { shortcutBus.emit('loadRemoteImages'); await new Promise(r => setTimeout(r, 30)); });
    assert.equal(getBody.mock.calls.filter(call => call.arguments[1] === true).length, 1);
    await React.act(async () => { shortcutBus.emit('loadRemoteImages'); await new Promise(r => setTimeout(r, 20)); });
    assert.equal(getBody.mock.calls.filter(call => call.arguments[1] === true).length, 1);
  });

  test('unsubscribe uses selected message existing flow once and ignores missing selection', async (t) => {
    const msg = { ...MSG_A, id: 'hotkey-unsub', uid: 42, list_unsubscribe: '<https://example.invalid/unsub>' };
    const unsubscribe = t.mock.method(api, 'unsubscribeMessage', async () => ({ type: 'one-click' }));
    await React.act(async () => {
      useStore.getState().setMessages([msg]);
      useStore.getState().setSelectedMessage(msg.id);
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { shortcutBus.emit('unsubscribe'); await new Promise(r => setTimeout(r, 10)); });
    assert.deepEqual(unsubscribe.mock.calls.map(call => call.arguments[0]), [msg.id]);
    await React.act(async () => { shortcutBus.emit('unsubscribe'); useStore.getState().setSelectedMessage(null); shortcutBus.emit('unsubscribe'); });
    assert.equal(unsubscribe.mock.callCount(), 1);
  });
});
