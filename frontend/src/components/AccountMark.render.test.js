// A mailbox mark (#376): the emoji where one is set, otherwise the color dot.

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
const { useStore } = await import('../store/index.js');
const AccountMark = (await import('./AccountMark.jsx')).default;

describe('AccountMark', () => {
  let root;
  const render = async (props) => {
    root ??= createRoot(document.getElementById('root'));
    await React.act(async () => root.render(React.createElement(AccountMark, props)));
    return document.getElementById('root').firstElementChild;
  };

  test('shows the mailbox emoji, about twice the dot', async () => {
    useStore.setState({ accounts: [{ id: 'a', icon: '💼', color: '#ff0000' }] });
    const el = await render({ accountId: 'a', color: '#ff0000', size: 6 });
    assert.equal(el.textContent, '💼');
    assert.equal(el.style.fontSize, '12px');
  });

  test('without one, the color dot as before', async () => {
    useStore.setState({ accounts: [{ id: 'a', icon: null, color: '#ff0000' }] });
    const el = await render({ accountId: 'a', color: 'rgb(255, 0, 0)', size: 8 });
    assert.equal(el.textContent, '');
    assert.equal(el.style.width, '8px');
    assert.equal(el.style.borderRadius, '50%');
    assert.equal(el.style.background, 'rgb(255, 0, 0)');
  });

  test('changes as soon as the icon is set in settings', async () => {
    useStore.setState({ accounts: [{ id: 'a', icon: null, color: '#ff0000' }] });
    await render({ accountId: 'a', color: '#ff0000' });
    await React.act(async () => useStore.setState({ accounts: [{ id: 'a', icon: '🏠', color: '#ff0000' }] }));
    assert.equal(document.getElementById('root').textContent, '🏠');
    await React.act(async () => root.unmount());
  });
});
