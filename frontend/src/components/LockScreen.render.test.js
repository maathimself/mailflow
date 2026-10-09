// Render test for signing out from the lock screen (#523).
//
// The sidebar's sign-out followed the SSO end-session URL the server returns when RP-initiated
// logout is on (#310); the lock screen's dropped it, so signing out there left the SSO session
// alive. jsdom cannot navigate to another page, but it does follow a hash change on the same
// one, so the test's end-session URL is the page itself with a hash.

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
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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

const ORIGIN = 'https://mail.example.invalid';
const dom = new JSDOM('<div id="root"></div>', { url: `${ORIGIN}/`, pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

let LOGOUT_BODY = { ok: true, endSessionUrl: null };
const requested = [];
globalThis.fetch = async (url) => {
  requested.push(String(url));
  const body = String(url).endsWith('/auth/logout') ? LOGOUT_BODY : {};
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const LockScreen = (await import('./LockScreen.jsx')).default;

let root;
async function signOutFromLockScreen() {
  if (root) await React.act(async () => root.unmount());
  localStorage.setItem('mailflow_locked', '1');
  localStorage.setItem('mailflow_expanded_accounts', '{"acct-1":true}');
  useStore.setState({ user: { id: 'u1', username: 'alice' }, isLocked: true });
  await React.act(async () => {
    root = createRoot(dom.window.document.getElementById('root'));
    root.render(React.createElement(LockScreen));
  });
  const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'lockScreen.signOut');
  assert.ok(button, 'expected the lock screen sign-out button');
  await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
}

describe('LockScreen — sign out (#523)', () => {
  test('follows the SSO end-session URL the server returns', async () => {
    LOGOUT_BODY = { ok: true, endSessionUrl: `${ORIGIN}/#sso-ended` };
    await signOutFromLockScreen();
    assert.ok(requested.some(u => u.endsWith('/auth/logout')));
    assert.equal(dom.window.location.hash, '#sso-ended');
  });

  test('signs out locally like the sidebar: no user, unlocked, mailbox state cleared', async () => {
    LOGOUT_BODY = { ok: true, endSessionUrl: `${ORIGIN}/#sso-ended-again` };
    await signOutFromLockScreen();
    assert.equal(useStore.getState().user, null);
    assert.equal(useStore.getState().isLocked, false);
    assert.equal(localStorage.getItem('mailflow_locked'), null);
    assert.equal(localStorage.getItem('mailflow_expanded_accounts'), null);
  });
});
