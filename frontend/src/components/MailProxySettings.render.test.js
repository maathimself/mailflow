// Outbound mail proxy settings: masked secrets, independent routing and saved connection tests.
import { test, describe, afterEach } from 'node:test';
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
const { api } = await import('../utils/api.js');
const { default: MailProxySettings, AccountProxySettings } = await import('./MailProxySettings.jsx');
let root;
afterEach(() => React.act(async () => root?.unmount()));
const click = el => React.act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
const base = { enabled: true, type: 'http', host: 'proxy.example.com', port: 8080, allowPrivate: false, hasUsername: true, hasPassword: true };
async function render(node) {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(node));
}
async function type(input, value) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
describe('outbound mail proxy WebUI', () => {
  test('preserves masked credentials when saving unrelated fields and clears the password input after save', async () => {
    const saves = [];
    api.admin.getMailProxy = async () => base;
    api.admin.saveMailProxy = async data => { saves.push(data); return base; };
    await render(React.createElement(MailProxySettings));
    const password = document.querySelector('input[type=password]');
    assert.equal(password.value, '');
    assert.equal(password.placeholder, 'admin.mailProxy.keepSecret');
    await click(button('admin.mailProxy.save'));
    assert.equal(saves[0].password, undefined);
    assert.equal(saves[0].username, undefined);
    await type(password, 'new-password');
    await click(button('admin.mailProxy.save'));
    assert.equal(saves[1].password, 'new-password');
    assert.equal(password.value, '');
    assert.match(document.querySelector('[role=status]').textContent, /admin.mailProxy.saved/);
  });
  test('keeps IMAP and SMTP selections independent and tests the saved account', async () => {
    api.getMailProxyStatus = async () => ({ enabled: true });
    const tests = [];
    api.testAccountConnection = async (id, protocol) => { tests.push({ id, protocol }); return { mode: 'proxy' }; };
    let latest;
    function Wrapper() {
      const [form, setForm] = React.useState({ imap_use_proxy: false, smtp_use_proxy: false }); latest = form;
      return React.createElement(AccountProxySettings, { form, set: (key, value) => setForm(f => ({ ...f, [key]: value })), accountId: 'account-1' });
    }
    await render(React.createElement(Wrapper));
    await click(document.querySelectorAll('input[type=checkbox]')[0]);
    assert.deepEqual(latest, { imap_use_proxy: true, smtp_use_proxy: false });
    await click(document.querySelectorAll('button')[1]);
    assert.deepEqual(tests, [{ id: 'account-1', protocol: 'smtp' }]);
    assert.match(document.querySelector('[role=status]').textContent, /admin.mailProxy.testPassed/);
    assert.match(document.body.textContent, /admin.mailProxy.testSaved/);
  });
  test('shows blocked proxy mode when the administrator disables the proxy', async () => {
    api.getMailProxyStatus = async () => ({ enabled: false });
    await render(React.createElement(AccountProxySettings, { form: { imap_use_proxy: true }, set: () => {} }));
    assert.match(document.body.textContent, /admin.mailProxy.blocked/);
    assert.match(document.body.textContent, /admin.mailProxy.unavailable/);
  });
});
