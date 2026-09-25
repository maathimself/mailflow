// Render test for #455: the profile modal must escape the mobile sidebar drawer.
//
// The drawer hides with transform: translateX(-100%), and a transformed ancestor is the
// containing block for position: fixed descendants, so a modal rendered inline inside the
// sidebar slides off-screen with it. The behavior under test is structural and only a real
// render can show it: wherever the modal is MOUNTED, its overlay must land under
// document.body via a portal, outside any transformed wrapper.
//
// Same loader hooks as ConversationPane.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed.

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
const { default: ProfileModal } = await import('./ProfileModal.jsx');
const { useStore } = await import('../store/index.js');

describe('ProfileModal placement (#455)', () => {
  test('escapes a transformed ancestor into document.body', async () => {
    useStore.setState({ user: { username: 'matt', displayName: 'Matt' } });
    const host = document.getElementById('root');
    // The mobile drawer, reduced to the property that causes the bug.
    const drawer = document.createElement('div');
    drawer.id = 'drawer';
    drawer.style.transform = 'translateX(-100%)';
    host.appendChild(drawer);

    const root = createRoot(drawer);
    await act(async () => { root.render(React.createElement(ProfileModal, { onClose: () => {} })); });

    const overlay = [...document.body.children].find(el => el !== host && el.querySelector && el.textContent.includes('profile.'));
    assert.ok(overlay, 'the modal overlay must be a direct child of document.body, not of the drawer');
    assert.equal(drawer.children.length, 0, 'nothing of the modal remains inside the transformed drawer');

    await act(async () => { root.unmount(); });
    assert.ok(![...document.body.children].some(el => el !== host && el.textContent?.includes('profile.')), 'portal cleans up on unmount');
  });
});
