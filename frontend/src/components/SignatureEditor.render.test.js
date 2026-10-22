// Render test for pasting into the signature editor in Settings.
//
// Same loader hooks as ProfileModal.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed so t() returns its key.

import { test, describe } from 'node:test';
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
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const { default: React } = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { default: SignatureEditor } = await import('./SignatureEditor.jsx');

// What Chrome 152 puts on the clipboard for two paragraphs copied out of an email in the
// message pane: each <p> carries the frame's white page and #1a1a1a text.
const NBSP = String.fromCharCode(160);
const PAGE = 'color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;';
const COPIED = `<meta charset='utf-8'><p id="p1" style="${PAGE}">Hi Marty,</p><p id="p2" style="${PAGE}">The ice resurfacer is booked for<span>${NBSP}</span><b>Tuesday at 6am</b>.</p>`;

// jsdom has no editing, so this stands in for the browser twice: insertHTML puts its HTML at the
// caret and fires input, and a paste the page does not cancel inserts the clipboard's HTML as it
// is, which is what the browser's own paste keeps of the colors.
function insertAtCaret(target, html) {
  const selection = window.getSelection();
  let range = selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !target.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(range.createContextualFragment(html));
  target.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function paste(target, html) {
  document.execCommand = (command, showUi, value) => {
    if (command !== 'insertHTML') return false;
    insertAtCaret(target, value);
    return true;
  };
  try {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { getData: type => (type === 'text/html' ? html : '') };
    target.dispatchEvent(event);
    if (!event.defaultPrevented) insertAtCaret(target, html);
  } finally {
    delete document.execCommand;
  }
}

describe('pasting into the signature editor', () => {
  test('text copied from an email is saved without the colors of the page it came from', async () => {
    const saved = [];
    const root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(SignatureEditor, { value: '<p>Marty Example</p>', onChange: html => saved.push(html) }));
    });
    try {
      const editor = document.querySelector('[contenteditable]');
      await act(async () => { paste(editor, COPIED); });
      const signature = saved.at(-1);
      assert.match(signature, /Marty Example/);
      assert.match(signature, /<b>Tuesday at 6am<\/b>/);
      assert.doesNotMatch(signature, /background-color|(?<![\w-])color\s*:/);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
