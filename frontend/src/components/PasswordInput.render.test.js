// Render test for the password field's eye button.
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
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const { default: React } = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { default: PasswordInput } = await import('./PasswordInput.jsx');

async function mount(props = {}) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement('form', null, React.createElement(PasswordInput, { id: 'pw', ...props }))); });
  return root;
}
const input = () => document.getElementById('pw');
const eye = () => input().parentElement.querySelector('button');

describe('password field eye button', () => {
  test('shows and hides what was typed', async () => {
    const root = await mount({ defaultValue: 'segredo' });
    assert.equal(input().type, 'password');
    assert.equal(eye().getAttribute('aria-label'), 'login.showPassword');
    await act(async () => { eye().click(); });
    assert.equal(input().type, 'text');
    assert.equal(input().value, 'segredo', 'the typed value survives the switch');
    assert.equal(eye().getAttribute('aria-pressed'), 'true');
    assert.equal(eye().getAttribute('aria-label'), 'login.hidePassword');
    await act(async () => { eye().click(); });
    assert.equal(input().type, 'password');
    await act(async () => root.unmount());
  });

  test('does not submit the form it sits in', async () => {
    let submitted = false;
    const root = await mount();
    input().form.addEventListener('submit', e => { submitted = true; e.preventDefault(); });
    assert.equal(eye().getAttribute('type'), 'button');
    await act(async () => { eye().click(); });
    assert.equal(submitted, false);
    await act(async () => root.unmount());
  });

  test('passes other props through to the input', async () => {
    const root = await mount({ autoComplete: 'current-password', placeholder: 'Senha' });
    assert.equal(input().getAttribute('autocomplete'), 'current-password');
    assert.equal(input().placeholder, 'Senha');
    await act(async () => root.unmount());
  });
});
