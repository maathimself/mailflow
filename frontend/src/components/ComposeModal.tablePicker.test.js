import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        // Keys stand in for text. The one string that wraps another (the AI panel's error) shows
        // what it wraps, so a test can tell which error it is.
        'export const useTranslation = () => ({ t: (k, o) => (o?.message ? `${k} ${o.message}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
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

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

describe('phone table picker positioning', () => {
  let root;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let viewportWidth = 360;
  let anchorLeft = 280;
  let pickerWidth = 260;
  before(() => {
    api.ai.status = async () => ({ enabled: false });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.matches('button[aria-label="compose.toolbar.insertTable"]')) {
        return { left: anchorLeft, right: anchorLeft + 24, top: 100, bottom: 124, width: 24, height: 24 };
      }
      if (this.style.position === 'fixed' && [...this.children].some(child => child.textContent === '3×33×44×4')) {
        const scale = useStore.getState().fontSize / 100;
        const left = parseFloat(this.style.left) * scale;
        return { left, right: left + pickerWidth, top: 128, bottom: 220, width: pickerWidth, height: 92 };
      }
      return originalRect.call(this);
    };
  });
  afterEach(async () => {
    if (root) { await React.act(async () => root.unmount()); root = null; }
  });
  after(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    dom.window.close();
  });
  const picker = () => [...document.querySelectorAll('div')].find(element =>
    element.style.position === 'fixed' && [...element.children].some(child => child.textContent === '3×33×44×4'));
  for (const fontSize of [100, 130]) {
    test(`clamps the measured picker width on a 360px phone at ${fontSize}% font size`, async () => {
      viewportWidth = 360; window.innerWidth = viewportWidth; anchorLeft = 280; pickerWidth = 260 * fontSize / 100;
      useStore.setState({ user: { id: 'u1' }, fontSize, plaintextEmail: false, composing: false, composeData: null,
        accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me' }] });
      useStore.getState().openCompose({ accountId: 'acct', subject: '', body: '' });
      root = createRoot(document.getElementById('root'));
      await React.act(async () => root.render(React.createElement(ComposeModal)));
      await React.act(async () => {});
      await React.act(async () => document.querySelector('button[aria-label="compose.toolbar.insertTable"]')
        .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
      assert.ok(picker(), 'the table picker is open');
      const bounds = picker().getBoundingClientRect();
      assert.ok(bounds.left >= 4, `left edge ${bounds.left} is inside the viewport`);
      assert.ok(bounds.right <= viewportWidth - 4, `right edge ${bounds.right} is inside the viewport`);
      viewportWidth = 350; window.innerWidth = viewportWidth;
      await React.act(async () => window.dispatchEvent(new window.Event('resize')));
      assert.ok(picker().getBoundingClientRect().right <= viewportWidth - 4, 'reclamps while the picker is open');
    });
  }
});

