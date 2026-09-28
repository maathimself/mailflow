// Render test for the admin's user editor and the password field's eye button.
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
const { default: AdminUserEditor } = await import('./AdminUserEditor.jsx');
const { api } = await import('../utils/api.js');

const USER = { id: 'u2', username: 'maria', recoveryEmail: 'maria@example.com', isAdmin: false };
const calls = [];
let failWith = null;
api.admin.updateUser = async (id, data) => { calls.push(['updateUser', id, data]); if (failWith) throw new Error(failWith); return { ok: true }; };
api.admin.setUserPassword = async (id, password) => { calls.push(['setUserPassword', id, password]); return { ok: true }; };

let root, saved, closed;
async function mount(user = USER) {
  calls.length = 0; failWith = null; saved = null; closed = false;
  root?.unmount?.();
  root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(AdminUserEditor, {
      user, isSelf: false, onClose: () => { closed = true; }, onSaved: u => { saved = u; },
    }));
  });
}
const dialog = () => document.querySelector('[role="dialog"]');
const setValue = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
};
const submit = async () => {
  await act(async () => { dialog().querySelector('button[type="submit"]').click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const field = id => document.getElementById(id);

describe('admin user editor', () => {
  test('sends only what changed, normalized', async () => {
    await mount();
    await setValue(field('admin-user-username'), '  Maria.Silva ');
    await submit();
    assert.deepEqual(calls, [['updateUser', 'u2', { username: 'maria.silva' }]]);
    assert.equal(saved.username, 'maria.silva');
    assert.equal(saved.recoveryEmail, 'maria@example.com');
  });

  test('closes without a request when nothing changed', async () => {
    await mount();
    await submit();
    assert.deepEqual(calls, []);
    assert.equal(closed, true);
  });

  test('sets a password only when it is long enough and confirmed', async () => {
    await mount();
    await setValue(field('admin-user-password'), 'curta');
    await submit();
    assert.match(dialog().textContent, /admin\.users\.passwordTooShort/);
    assert.deepEqual(calls, []);

    await setValue(field('admin-user-password'), 'senha-nova-123');
    const confirm = dialog().querySelector('input[aria-label="admin.users.confirmPassword"]');
    await setValue(confirm, 'senha-diferente');
    await submit();
    assert.match(dialog().textContent, /admin\.users\.passwordMismatch/);
    assert.deepEqual(calls, []);

    await setValue(confirm, 'senha-nova-123');
    await submit();
    assert.deepEqual(calls, [['setUserPassword', 'u2', 'senha-nova-123']]);
    assert.ok(saved);
  });

  test('clearing the recovery email removes it', async () => {
    await mount();
    await setValue(field('admin-user-recovery'), '');
    await submit();
    assert.deepEqual(calls, [['updateUser', 'u2', { recoveryEmail: '' }]]);
  });

  test('a taken username is reported in the UI language and nothing is saved', async () => {
    await mount();
    failWith = 'Username already taken';
    await setValue(field('admin-user-username'), 'joao');
    await submit();
    assert.match(dialog().textContent, /admin\.users\.usernameTaken/);
    assert.equal(saved, null);
  });
});
