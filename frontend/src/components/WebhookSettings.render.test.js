import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
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

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { UserWebhookSettings, AdminWebhookSettings, default: WebhookSettings } = await import('./WebhookSettings.jsx');
const host = document.getElementById('root');
let root, config, admin, calls;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
globalThis.fetch = async (url, init) => {
  const body = init.body && JSON.parse(init.body);
  calls.push({ url, method: init.method, body, headers: init.headers });
  if (url.endsWith('/admin')) {
    if (init.method === 'PUT') admin = body;
    return json(admin);
  }
  if (url.endsWith('/test')) return json({ ok: true });
  if (init.method === 'PUT') config = { ...config, ...body, urlConfigured: !!body.url || config.urlConfigured, tokenConfigured: body.token === '' ? false : !!body.token || config.tokenConfigured };
  return json(config);
};
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function mount(Component = UserWebhookSettings, props = {}) {
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component, props)); });
  await flush();
}
const click = el => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text);
const checkbox = text => [...host.querySelectorAll('label')].find(l => l.textContent === text)?.querySelector('input');
async function setValue(el, value) {
  const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
}
beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  calls = [];
  config = { available: true, enabled: true, format: 'ntfy', urlConfigured: true, tokenConfigured: true, includeSender: false, includeSubject: false, failures: 0, lastError: null };
  admin = { enabled: true, allowedOrigins: ['http://192.168.1.2:80'] };
});
after(async () => { if (root) await act(async () => root.unmount()); });

describe('webhook settings', () => {
  test('keeps secrets blank and omits them when saving unrelated opt-ins', async () => {
    await mount();
    assert.deepEqual([...host.querySelectorAll('input[type=password]')].map(el => el.value), ['', '']);
    assert.ok(host.textContent.includes('webhooks.sender'));
    assert.ok(host.textContent.includes('webhooks.subject'));
    await click(checkbox('webhooks.sender'));
    assert.equal(button('webhooks.test').disabled, true);
    await click(button('common.save'));
    const write = calls.find(c => c.method === 'PUT');
    assert.deepEqual(write.body, { enabled: true, format: 'ntfy', includeSender: true, includeSubject: false });
    assert.equal(write.headers['X-Requested-With'], 'MailFlow');
    assert.equal(button('webhooks.test').disabled, false);
  });
  test('clears a saved token only after explicit selection and save', async () => {
    await mount();
    await click(checkbox('webhooks.clearToken'));
    await click(button('common.save'));
    assert.equal(calls.find(c => c.method === 'PUT').body.token, '');
  });
  test('does not send hidden pending token changes after switching to generic', async () => {
    await mount();
    await setValue(host.querySelectorAll('input[type=password]')[1], 'secret-new-token');
    await setValue(host.querySelector('select'), 'generic');
    await click(button('common.save'));
    const write = calls.find(c => c.method === 'PUT');
    assert.equal(write.body.format, 'generic');
    assert.ok(!Object.hasOwn(write.body, 'token'));
  });
  test('shows automatic disable reason and requires explicit re-enable before testing', async () => {
    config.enabled = false; config.failures = 5; config.lastError = 'Delivery timed out';
    await mount();
    assert.match(host.textContent, /webhooks.disabled/);
    assert.match(host.textContent, /Delivery timed out/);
    assert.equal(button('webhooks.test').disabled, true);
    await click(checkbox('webhooks.enable'));
    await click(button('common.save'));
    assert.equal(calls.find(c => c.method === 'PUT').body.enabled, true);
    await click(button('webhooks.test'));
    assert.equal(calls.filter(c => c.url.endsWith('/test')).length, 1);
    assert.match(host.textContent, /webhooks.testSent/);
  });
  test('admin saves normalized origin lines and nonadmins never load admin controls', async () => {
    await mount(AdminWebhookSettings);
    await setValue(host.querySelector('textarea'), ' https://notify.example.com:443 \n\n http://192.168.1.20:8080 ');
    await click(button('common.save'));
    assert.deepEqual(calls.find(c => c.method === 'PUT').body, { enabled: true, allowedOrigins: ['https://notify.example.com:443', 'http://192.168.1.20:8080'] });
    await act(async () => root.unmount()); calls = [];
    await mount(WebhookSettings);
    assert.ok(!calls.some(c => c.url.endsWith('/admin')));
  });
  test('global disable prevents user actions', async () => {
    config.available = false;
    await mount();
    assert.match(host.textContent, /webhooks.unavailable/);
    assert.equal(host.querySelector('fieldset').disabled, true);
  });
});
