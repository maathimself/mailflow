import { test } from 'node:test';
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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const BusinessNotice = (await import('./BusinessNotice.jsx')).default;

async function render(props = {}) {
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(BusinessNotice, props)));
  return root;
}

const notice = () => document.querySelector('[data-testid="business-notice"]');

test('an admin sees the notice when the server says it is due, and one choice hides it', async () => {
  const saved = [];
  useStore.setState({ user: { id: 'u', isAdmin: true } });
  api.admin.getBusinessNotice = async () => ({ show: true });
  api.admin.setBusinessNotice = async choice => { saved.push(choice); return { ok: true }; };
  const root = await render();
  try {
    assert.ok(notice(), 'shown to an admin');
    const link = notice().querySelector('a');
    assert.equal(link.getAttribute('href'), 'https://mailflow.sh/#pricing');
    assert.equal(link.getAttribute('target'), '_blank');
    const notBusiness = [...notice().querySelectorAll('button')].find(b => b.textContent === 'admin.businessNotice.notBusiness');
    await React.act(async () => notBusiness.click());
    assert.equal(notice(), null, 'hidden after a choice');
    assert.deepEqual(saved, ['not_business']);
  } finally { await React.act(async () => root.unmount()); }
});

test('each button stores its own choice', async () => {
  useStore.setState({ user: { id: 'u', isAdmin: true } });
  api.admin.getBusinessNotice = async () => ({ show: true });
  for (const [label, choice] of [['haveOne', 'licensed'], ['later', 'later']]) {
    const saved = [];
    api.admin.setBusinessNotice = async c => { saved.push(c); return { ok: true }; };
    const root = await render();
    try {
      const btn = [...notice().querySelectorAll('button')].find(b => b.textContent === `admin.businessNotice.${label}`);
      await React.act(async () => btn.click());
      assert.deepEqual(saved, [choice]);
    } finally { await React.act(async () => root.unmount()); }
  }
});

test('a non-admin never asks the server and sees nothing', async () => {
  let asked = false;
  useStore.setState({ user: { id: 'u', isAdmin: false } });
  api.admin.getBusinessNotice = async () => { asked = true; return { show: true }; };
  const root = await render();
  try {
    assert.equal(notice(), null);
    assert.equal(asked, false);
  } finally { await React.act(async () => root.unmount()); }
});

test('nothing shows when the server says it is not due, when hidden, or when the request fails', async () => {
  useStore.setState({ user: { id: 'u', isAdmin: true } });
  api.admin.getBusinessNotice = async () => ({ show: false });
  let root = await render();
  try { assert.equal(notice(), null); } finally { await React.act(async () => root.unmount()); }

  api.admin.getBusinessNotice = async () => ({ show: true });
  root = await render({ hidden: true });
  try { assert.equal(notice(), null, 'hidden while composing or in settings'); } finally { await React.act(async () => root.unmount()); }

  api.admin.getBusinessNotice = async () => { throw new Error('offline'); };
  root = await render();
  try { assert.equal(notice(), null); } finally { await React.act(async () => root.unmount()); }
});
