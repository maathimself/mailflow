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
const { RESUME_RETRY_EVENT } = await import('../utils/resumeRefresh.js');
const { default: ResumeStatus, RESUME_STATUS_DELAY_MS } = await import('./ResumeStatus.jsx');

// #748: the strip above the list while a resync after the app resumes catches up, or failed to.
const root = createRoot(document.getElementById('root'));
await React.act(async () => root.render(React.createElement(ResumeStatus)));
const strip = () => document.querySelector('[role="status"]');
const set = async (resumeSync) => React.act(async () => { useStore.getState().setResumeSync(resumeSync); });
const wait = ms => React.act(() => new Promise(r => setTimeout(r, ms)));

test('says nothing while idle, or for a resync that finishes inside the delay', async () => {
  await set('idle');
  assert.equal(strip(), null);
  await set('syncing');
  assert.equal(strip(), null, 'not at once');
  await wait(RESUME_STATUS_DELAY_MS / 2);
  await set('idle');
  await wait(RESUME_STATUS_DELAY_MS);
  assert.equal(strip(), null, 'a quick one never shows');
});

test('says it is updating once a resync runs past the delay, and goes when it is done', async () => {
  await set('syncing');
  await wait(RESUME_STATUS_DELAY_MS + 50);
  assert.match(strip()?.textContent || '', /messageList\.resumeUpdating/);
  assert.equal(strip().getAttribute('aria-live'), 'polite');
  await set('idle');
  assert.equal(strip(), null);
});

test('says a failure at once, with Retry asking for the resync now', async () => {
  let asked = 0;
  window.addEventListener(RESUME_RETRY_EVENT, () => { asked += 1; });
  await set('failed');
  assert.match(strip()?.textContent || '', /messageList\.resumeFailed/);
  const button = strip().querySelector('button');
  assert.equal(button.textContent, 'common.retry');
  await React.act(async () => button.click());
  assert.equal(asked, 1);
});

test('while it retries the failure stays, and Retry waits', async () => {
  await set('retrying');
  const button = strip().querySelector('button');
  assert.match(strip().textContent, /messageList\.resumeFailed/);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'messageList.resumeRetrying');
  await set('idle');
  assert.equal(strip(), null);
  await React.act(async () => root.unmount());
});
