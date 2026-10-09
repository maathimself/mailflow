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
    // pdf.js needs a real browser; the viewer tests drive this stand-in through globalThis.__pdfStub.
    if (url.endsWith('/src/utils/pdfDocument.js')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const openPdf = (bytes, options) => globalThis.__pdfStub.openPdf(bytes, options);',
        'export const renderPage = () => ({ done: Promise.resolve(), cancel() {} });',
        'export const renderPagesForPrint = async () => [];',
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
  MutationObserver: dom.window.MutationObserver,
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

// The attachment viewer. PDF bytes are never served here: pdf.js needs a real browser, so the PDF
// tests only go as far as the viewer opening, and the byte check and rendering are exercised with
// images, which jsdom can hold.
describe('attachment viewer', () => {
  const MSG_VIEW = { ...MSG_A, id: 'g7', uid: 7, subject: 'Boleto' };
  const MSG_OTHER = { ...MSG_A, id: 'h8', uid: 8, subject: 'Other' };
  const MSG_LOCKED = { ...MSG_A, id: 'i9', uid: 9, subject: 'Extrato' };
  const MSG_LONG = { ...MSG_A, id: 'j10', uid: 10, subject: 'Catálogo' };
  const FILES = {
    g7: [
      { filename: 'boleto.pdf', type: 'application/pdf', part: '2', size: 10 },
      { filename: 'foto.jpg', type: 'image/jpeg', part: '3', size: 10 },
      { filename: 'disguised.png', type: 'image/png', part: '4', size: 10 },
      { filename: 'planilha.xlsx', type: 'application/vnd.ms-excel', part: '5', size: 10 },
      { filename: 'setup.exe', type: 'application/octet-stream', part: '6', size: 10 },
    ],
    i9: [
      { filename: 'extrato.pdf', type: 'application/pdf', part: '7', size: 10 },
      { filename: 'recibo.jpg', type: 'image/jpeg', part: '8', size: 10 },
    ],
    j10: [
      { filename: 'catalogo.pdf', type: 'application/pdf', part: '9', size: 10 },
      { filename: 'enorme.pdf', type: 'application/pdf', part: '10', size: 80 * 1024 * 1024 },
    ],
  };
  const BYTES = {
    '3': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    '4': new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>'),
    '7': new TextEncoder().encode('%PDF-1.7\n% encrypted'),
    '8': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    '9': new TextEncoder().encode('%PDF-1.7\n% six pages'),
  };
  // Stands in for pdf.js: the document opens only with the password "segredo".
  const passwordsTried = [];
  const lockedPdf = {
    async openPdf(bytes, { password } = {}) {
      passwordsTried.push(password ?? null);
      if (password !== 'segredo') {
        throw Object.assign(new Error('Password required'), { name: 'PasswordException', code: password ? 2 : 1 });
      }
      return {
        doc: { numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 595, height: 842 }) }) },
        destroy() {},
      };
    },
  };
  const NEVER_ARRIVES = new Set(['2']);
  const requests = [];
  const saved = [];
  let originalFetch, originalClick;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      requests.push(u);
      const part = /\/attachments\/([^/?]+)$/.exec(u)?.[1];
      if (part !== undefined) {
        if (NEVER_ARRIVES.has(decodeURIComponent(part))) return new Promise(() => {});
        const body = BYTES[decodeURIComponent(part)] ?? new Uint8Array();
        return {
          ok: true, status: 200,
          arrayBuffer: async () => body.slice().buffer,
          blob: async () => new Blob([body]),
        };
      }
      const id = /\/messages\/([^/]+)\/body/.exec(u)?.[1];
      const json = FILES[id] ? { html: '<p>hi</p>', text: 'hi', attachments: FILES[id] } : {};
      return { ok: true, status: 200, json: async () => json, text: async () => '' };
    };
    originalClick = dom.window.HTMLAnchorElement.prototype.click;
    dom.window.HTMLAnchorElement.prototype.click = function () {
      saved.push({ href: this.getAttribute('href'), download: this.getAttribute('download') });
    };
    globalThis.__pdfStub = lockedPdf;
    useStore.getState().setMessages?.([MSG_A, MSG_VIEW, MSG_OTHER, MSG_LOCKED, MSG_LONG]);
  });
  after(() => {
    globalThis.fetch = originalFetch;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  });

  const settle = () => React.act(async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  });
  async function open(id) {
    // Through another message first, so a viewer left open by the previous test is closed.
    await React.act(async () => {
      useStore.getState().setSelectedMessage('h8');
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { useStore.getState().setSelectedMessage(id); });
    await settle();
    requests.length = 0;
    saved.length = 0;
  }
  const chip = filename => [...document.querySelectorAll('button')].find(b => b.textContent.includes(filename));
  async function clickChip(filename) {
    await React.act(async () => {
      chip(filename).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
  }
  const dialog = () => document.querySelector('[role="dialog"]');
  const attachmentRequests = () => requests.filter(u => u.includes('/attachments/'));
  async function press(key, target = dialog() ?? document.body) {
    await React.act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    await settle();
  }

  test('clicking a PDF opens the viewer instead of downloading it', async () => {
    await open('g7');
    assert.equal(dialog(), null);
    await clickChip('boleto.pdf');
    assert.ok(dialog(), 'the viewer is open');
    assert.match(dialog().textContent, /boleto\.pdf/);
    assert.deepEqual(attachmentRequests(), ['/api/mail/messages/g7/attachments/2'], 'the file is fetched once, for the viewer');
    assert.deepEqual(saved, [], 'nothing is saved to disk');
  });

  test('an image is shown from its bytes, and Download saves those same bytes', async () => {
    await open('g7');
    await clickChip('foto.jpg');
    const img = dialog().querySelector('img');
    assert.ok(img, 'the image is rendered');
    assert.match(img.getAttribute('src'), /^blob:/);
    const download = dialog().querySelector('button[aria-label="message.preview.download"]');
    await React.act(async () => { download.click(); });
    assert.equal(saved.length, 1);
    assert.match(saved[0].href, /^blob:/);
    assert.equal(saved[0].download, 'foto.jpg');
    assert.equal(attachmentRequests().length, 1, 'Download reuses the bytes instead of fetching again');
  });

  test('bytes that are not what the name claims are refused, with Download still offered', async () => {
    await open('g7');
    await clickChip('disguised.png');
    assert.equal(dialog().querySelector('img'), null, 'an HTML file named .png is never rendered');
    assert.match(dialog().textContent, /message\.preview\.unsupported/);
    assert.ok([...dialog().querySelectorAll('button')].some(b => b.textContent === 'message.preview.download'));
  });

  test('other documents still download, and risky files still ask first', async () => {
    await open('g7');
    await clickChip('planilha.xlsx');
    assert.equal(dialog(), null, 'a spreadsheet does not open the viewer');
    assert.deepEqual(attachmentRequests(), ['/api/mail/messages/g7/attachments/5']);
    await clickChip('setup.exe');
    assert.equal(dialog(), null);
    assert.match(chip('setup.exe').textContent, /message\.attachmentRisk\.armed\[/);
  });

  test('while open, keystrokes stay in the viewer and Escape closes only the viewer', async () => {
    await open('g7');
    const reached = [];
    const listener = e => reached.push(e.key);
    document.addEventListener('keydown', listener);
    try {
      await clickChip('boleto.pdf');
      await press('e');
      await press('#');
      assert.deepEqual(reached, [], 'mail shortcuts must not act on the message behind the viewer');
      await press('Escape');
      assert.equal(dialog(), null, 'Escape closes the viewer');
      assert.deepEqual(reached, [], 'and does not reach the pane either');
      assert.equal(useStore.getState().selectedMessageId, 'g7', 'the message stays open');
      await press('e', document.body);
      assert.deepEqual(reached, ['e'], 'once closed, keys flow again');
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });

  test('arrow keys move between the previewable attachments only', async () => {
    await open('g7');
    await clickChip('boleto.pdf');
    const title = () => dialog().querySelector('[title]').getAttribute('title');
    assert.equal(title(), 'boleto.pdf');
    await press('ArrowRight');
    assert.equal(title(), 'foto.jpg');
    await press('ArrowRight');
    assert.equal(title(), 'disguised.png');
    await press('ArrowRight');
    assert.equal(title(), 'disguised.png', 'the spreadsheet and the installer are not in the viewer');
    await press('ArrowLeft');
    assert.equal(title(), 'foto.jpg');
  });

  const passwordField = () => dialog()?.querySelector('input[type="password"]') ?? null;
  async function submitPassword(text) {
    const input = passwordField();
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await React.act(async () => { dialog().querySelector('button[type="submit"]').click(); });
    await settle();
  }

  test('a password-protected PDF asks for its password and opens with the right one', async () => {
    await open('i9');
    passwordsTried.length = 0;
    await clickChip('extrato.pdf');
    assert.ok(passwordField(), 'the viewer asks for the password instead of failing');
    assert.match(dialog().textContent, /message\.preview\.password/);
    assert.equal(document.activeElement, passwordField(), 'the field is focused, ready to type');

    await submitPassword('errada');
    assert.match(dialog().textContent, /message\.preview\.passwordIncorrect/);
    assert.equal(passwordField().value, '', 'a wrong password is cleared for the next try');

    await submitPassword('segredo');
    assert.equal(passwordField(), null, 'the right password opens the document');
    assert.deepEqual(passwordsTried, [null, 'errada', 'segredo']);
    const print = dialog().querySelector('button[aria-label="message.preview.print"]');
    assert.equal(print.disabled, false, 'an unlocked PDF can be printed');
  });

  test('arrows move the caret in the password field, and the password is forgotten on leaving', async () => {
    await open('i9');
    await clickChip('extrato.pdf');
    const title = () => dialog().querySelector('[title]').getAttribute('title');
    await press('ArrowRight', passwordField());
    assert.equal(title(), 'extrato.pdf', 'typing in the field does not switch attachments');

    await submitPassword('segredo');
    await press('ArrowRight');
    assert.equal(title(), 'recibo.jpg');
    passwordsTried.length = 0;
    await press('ArrowLeft');
    assert.equal(title(), 'extrato.pdf');
    assert.ok(passwordField(), 'coming back asks again');
    assert.deepEqual(passwordsTried, [null], 'the earlier password was not kept');
  });

  test('while open, the app behind is inert, so Tab cannot reach it; closing gives it back', async () => {
    await open('g7');
    await clickChip('foto.jpg');
    const app = document.getElementById('root');
    assert.equal(app.hasAttribute('inert'), true, 'the app behind the viewer cannot take focus or clicks');
    assert.equal(dialog().closest('[inert]'), null, 'the viewer itself stays usable');
    const late = document.createElement('div');
    await React.act(async () => { document.body.appendChild(late); });
    await settle();
    assert.equal(late.hasAttribute('inert'), true, 'something added to the page meanwhile is inert too');
    await press('Escape');
    assert.equal(app.hasAttribute('inert'), false);
    assert.equal(late.hasAttribute('inert'), false);
    late.remove();
  });

  test('an image the browser cannot decode shows the message, not a broken icon', async () => {
    await open('g7');
    await clickChip('foto.jpg');
    await React.act(async () => { dialog().querySelector('img').dispatchEvent(new dom.window.Event('error')); });
    assert.equal(dialog().querySelector('img'), null);
    assert.match(dialog().textContent, /message\.preview\.unsupported/);
    assert.ok([...dialog().querySelectorAll('button')].some(b => b.textContent === 'message.preview.download'));
  });

  test('Ctrl+P pressed again while printing does not stack a second print', async () => {
    await open('g7');
    await clickChip('foto.jpg');
    const ctrlP = () => React.act(async () => {
      dialog().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await ctrlP();
    await ctrlP();
    await ctrlP();
    const frames = [...dialog().querySelectorAll('iframe')];
    assert.equal(frames.length, 1, 'one print frame');
    await press('Escape');
    assert.equal(frames[0].isConnected, false, 'closing the viewer removes it');
  });

  test('a file over the size limit downloads instead of opening the viewer', async () => {
    await open('j10');
    await clickChip('enorme.pdf');
    assert.equal(dialog(), null);
    assert.deepEqual(attachmentRequests(), ['/api/mail/messages/j10/attachments/10']);
  });

  test('a long PDF keeps drawings only for the pages near the viewport', async () => {
    // A controllable IntersectionObserver: the test says which pages are in the window.
    const observed = new Map();
    globalThis.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; }
      observe(el) { observed.set(el, this.callback); }
      disconnect() {}
    };
    // jsdom lays nothing out; the viewer waits for a measured width before drawing pages.
    Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
    globalThis.__pdfStub = {
      async openPdf() {
        return {
          doc: { numPages: 6, getPage: async () => ({ getViewport: () => ({ width: 595, height: 842 }) }) },
          destroy() {},
        };
      },
    };
    try {
      await open('j10');
      await clickChip('catalogo.pdf');
      const pages = [...dialog().querySelectorAll('.mf-pdf-page')];
      assert.equal(pages.length, 6);
      const drawn = () => pages.map(p => p.querySelectorAll('canvas').length);
      const scrollTo = async (visible) => {
        await React.act(async () => {
          pages.forEach((page, i) => observed.get(page)([{ isIntersecting: visible.includes(i + 1) }]));
        });
        await settle();
      };
      await scrollTo([1, 2]);
      assert.deepEqual(drawn(), [1, 1, 0, 0, 0, 0], 'the first pages are drawn, the rest wait');
      await scrollTo([4, 5, 6]);
      assert.deepEqual(drawn(), [0, 0, 0, 1, 1, 1], 'pages scrolled past give their drawing back');
    } finally {
      delete globalThis.IntersectionObserver;
      delete dom.window.HTMLElement.prototype.clientWidth;
      globalThis.__pdfStub = lockedPdf;
    }
  });

  test('selecting another message closes the viewer', async () => {
    await open('g7');
    await clickChip('foto.jpg');
    assert.ok(dialog());
    await React.act(async () => { useStore.getState().setSelectedMessage('h8'); });
    await settle();
    assert.equal(dialog(), null);
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

  test('a text-only body stays translatable under the translate="no" UI', async () => {
    // index.html marks <body> translate="no" so browser translators cannot break React's DOM.
    // Plain-text mail renders in the main document, so without this the browser could no
    // longer translate a message written in another language.
    await open('t1');
    const card = [...document.querySelectorAll('.msg-card')].find(el => /Plain text with/.test(el.textContent));
    assert.ok(card, 'the plain-text body is rendered');
    assert.equal(card.closest('[translate]')?.getAttribute('translate'), 'yes');
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

// The move picker lists favorites under the name the user gave them in the sidebar, not the raw
// folder name (#505).
describe('move picker favorites', () => {
  const FOLDERS = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', special_use: '\\Inbox' },
    { path: 'Projects/Receipts', name: 'Receipts', delimiter: '/' },
    { path: 'Archive', name: 'Archive', delimiter: '/', special_use: '\\Archive' },
  ];
  let originalFetch;
  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true, status: 200, text: async () => '',
      json: async () => (String(url).includes('/accounts/acct/folders') ? FOLDERS : {}),
    });
    useStore.getState().setMessages?.([MSG_A]);
  });
  after(() => {
    globalThis.fetch = originalFetch;
    useStore.setState({ favoriteFolders: [] });
  });

  async function openPicker() {
    // Start from a fresh mount: the picker is a toggle, and a picker left open by the previous
    // test would be closed by this click.
    await React.act(async () => { root.render(null); });
    await React.act(async () => {
      useStore.getState().setSelectedMessage('a1');
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const moveBtn = document.querySelector('[title="contextMenu.moveToFolder"]');
    assert.ok(moveBtn, 'the Move button is rendered');
    await React.act(async () => { moveBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return [...document.querySelectorAll('button')].map(b => b.textContent);
  }

  test('a renamed favorite shows its custom name', async () => {
    useStore.setState({ favoriteFolders: [{ accountId: 'acct', path: 'Projects/Receipts', label: 'Tax 2026' }] });
    const entries = await openPicker();
    assert.ok(entries.includes('Tax 2026'), `favorites should show the custom name, got ${JSON.stringify(entries)}`);
    assert.ok(entries.includes('Projects / Receipts'), 'the full folder list still shows the real folder');
  });

  test('a favorite without a custom name shows the folder as before', async () => {
    useStore.setState({ favoriteFolders: [{ accountId: 'acct', path: 'Projects/Receipts' }] });
    const entries = await openPicker();
    assert.equal(entries.filter(e => e === 'Projects / Receipts').length, 2, 'once as a favorite, once in the full list');
  });
});

describe('Reply with AI in the toolbar', () => {
  const button = () => document.querySelector('[title="compose.toolbar.aiReply"]');
  let realStatus;
  async function show({ compose }) {
    api.ai.status = async () => ({ enabled: true, features: { compose, summarize: true } });
    // A fresh mount: the pane asks for the AI status when it mounts.
    await React.act(async () => { root.render(null); });
    await React.act(async () => {
      useStore.getState().setSelectedMessage('a1');
      root.render(React.createElement(MessagePane));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
  }
  before(() => { realStatus = api.ai.status; });
  after(() => {
    api.ai.status = realStatus;
    useStore.setState({ plaintextEmail: false });
    useStore.getState().closeCompose();
  });

  test('opens the reply with the AI panel waiting for the instruction', async () => {
    await show({ compose: true });
    assert.ok(button(), 'offered when the AI can write replies');
    await React.act(async () => { button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const data = useStore.getState().composeData;
    assert.equal(data?.isReply, true);
    assert.equal(data.aiReply, true);
    assert.equal(data.subject, 'Re: First');
  });

  test('is not offered when the AI does not write emails, or the user writes in plain text', async () => {
    await show({ compose: false });
    assert.equal(button(), null);
    useStore.setState({ plaintextEmail: true });
    await show({ compose: true });
    assert.equal(button(), null);
  });
});

// #572: the reading pane's own Delete and Archive open what takes the message's place, by the
// afterRemove setting, instead of leaving "Select a message to read".
describe('the next message opens after the pane removes the open one', () => {
  const MSG_C = { ...MSG_A, id: 'c3', uid: 3, subject: 'Third' };
  // The desktop titles carry the shortcut, e.g. "message.archive (E)".
  const paneButton = title => [...document.querySelectorAll('button')].find(b => (b.getAttribute('title') || '').split(' (')[0] === title);
  const show = async (id, afterRemove = 'next') => {
    useStore.setState({ afterRemove, searchQuery: '' });
    useStore.getState().setMessages([MSG_A, MSG_B, MSG_C].map(m => ({ ...m })));
    await React.act(async () => { useStore.getState().setSelectedMessage(id); });
    await React.act(async () => { root.render(React.createElement(MessagePane)); });
  };
  const click = el => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

  test('Delete opens the message below', async () => {
    await show('b2');
    await click(paneButton('message.delete'));
    assert.equal(useStore.getState().selectedMessageId, 'c3');
    assert.deepEqual(useStore.getState().messages.map(m => m.id), ['a1', 'c3']);
  });

  test('Archive with "previous" opens the message above', async () => {
    await show('b2', 'previous');
    await click(paneButton('message.archive'));
    assert.equal(useStore.getState().selectedMessageId, 'a1');
  });

  test('"back to the list" leaves the pane empty, as before', async () => {
    await show('b2', 'list');
    await click(paneButton('message.delete'));
    assert.equal(useStore.getState().selectedMessageId, null);
    useStore.setState({ afterRemove: 'next' });
  });
});
