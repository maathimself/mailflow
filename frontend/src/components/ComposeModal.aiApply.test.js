// Render test for Apply on an AI suggestion. utils/aiText.test.js covers the conversion; this checks
// the composer's Apply goes through it, in the real editor, which rewrites what it is given.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? `${k} ${JSON.stringify(o)}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

let answer = '';

before(() => {
  api.ai.status = async () => ({ enabled: true, features: { compose: true } });
  // A function stands for a model that answers from the text it was given.
  api.ai.chat = async (messages) => (typeof answer === 'function' ? answer(messages[1].content) : answer);
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
});

// A new message, Improve from the AI menu answered with `text`, then Apply. Returns the editor and
// an unmount.
async function improveAndApply(text, body = '<p>draft</p>') {
  answer = text;
  useStore.setState({ plaintextEmail: false, composing: false, composeData: null, prepareComposeSwitch: null });
  useStore.getState().openCompose({ accountId: 'acct', to: ['bob@example.invalid'], cc: [], subject: 'Plan', body, bodyIsHtml: true });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  await React.act(async () => {});
  const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent === label);
  const press = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
  await press(document.querySelector('button[title="compose.toolbar.aiAssist"]'));
  await press(button('compose.toolbar.aiImprove'));
  await React.act(async () => {});
  await React.act(async () => { button('compose.toolbar.aiApply').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  const editor = document.querySelector('.ProseMirror').editor;
  return { editor, close: () => React.act(async () => root.unmount()) };
}

describe('Apply', () => {
  test('keeps the blank lines between the paragraphs of the suggestion', async () => {
    const { editor, close } = await improveAndApply('Hi Bob,\n\nThe plan is approved.\nThanks\n\nMe');
    try {
      assert.equal(editor.getHTML(), '<p>Hi Bob,</p><p></p><p>The plan is approved.<br>Thanks</p><p></p><p>Me</p>');
    } finally { await close(); }
  });

  test('adds no blank line the draft did not have', async () => {
    // A model with nothing to improve returns the text it was given. Each Enter is a paragraph in
    // this editor, and an empty one is a blank line the user typed.
    const draft = '<p>Hi Bob,</p><p></p><p>The plan is approved.</p><p></p><p>Thanks,</p><p>Jordan</p>';
    const { editor, close } = await improveAndApply(given => given, draft);
    try {
      const empty = (html) => html.split('<p></p>').length - 1;
      assert.equal(empty(editor.getHTML()), empty(draft));
    } finally { await close(); }
  });

  test('keeps markup in the suggestion as text, so it cannot put a link into the message', async () => {
    const { editor, close } = await improveAndApply('Pay at <a href="https://evil.example">the portal</a>.');
    try {
      // Counted, not compared: a failed comparison of DOM nodes would print the whole document.
      assert.equal(document.querySelectorAll('.ProseMirror a').length, 0, 'no link was created');
      assert.equal(editor.getText(), 'Pay at <a href="https://evil.example">the portal</a>.');
    } finally { await close(); }
  });
});
