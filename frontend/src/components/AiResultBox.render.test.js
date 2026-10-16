// The AI result box under a message: "Generating…" shows once while it waits (#618).

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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const AiResultBox = (await import('./AiResultBox.jsx')).default;

describe('generating indicator (#618)', () => {
  let root;
  const render = async (result) => {
    root ??= createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(AiResultBox, { result, canRegen: true, onRegen() {}, onDismiss() {} })));
    return document.getElementById('root');
  };
  const count = (el) => (el.innerHTML.match(/compose\.toolbar\.aiGenerating/g) || []).length;
  test('once, in the body, before any text arrives', async () => {
    const el = await render({ status: 'loading', text: '', label: '[T] Translate & Summarize' });
    assert.equal(count(el), 1);
  });
  test('once, in the header, while text streams in', async () => {
    const el = await render({ status: 'loading', text: 'Partial **out', label: 'x' });
    assert.equal(count(el), 1);
    assert.match(el.innerHTML, /Partial/);
  });
  test('not at all once done', async () => {
    const el = await render({ status: 'done', text: 'Done', label: 'x' });
    assert.equal(count(el), 0);
  });
});
