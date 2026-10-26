// Render test for what MailApp does when the tab comes back to the front.
//
// installResumeRefresh (utils/resumeRefresh.js) decides when a returning tab resynchronises: not
// for a glance, once for a real absence however many signals it fires. MailApp also kept an older
// visibilitychange listener that dispatched mailflow:refresh on every return, so a glance at the
// app switcher still reloaded the list and a real resume reloaded it twice.
//
// A resume often comes before the network does, so its requests fail; that resync has to be
// tried again rather than spent.
//
// MailApp is mounted for real with its children stubbed: the question is only which refreshes
// its own effects ask for.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const STUBS = {
  '/components/Sidebar.jsx': 'export default function Sidebar() { return null; }',
  '/components/MessageList.jsx': 'export default function MessageList() { return null; }',
  '/components/ReadingPane.jsx': 'export default function ReadingPane() { return null; }',
  '/components/NotificationToasts.jsx': 'export default function NotificationToasts() { return null; }',
  '/components/CommandPalette.jsx': 'export default function CommandPalette() { return null; }',
  '/components/ComposeModal.jsx': 'export default function ComposeModal() { return null; }',
  '/components/ContactsPage.jsx': 'export default function ContactsPage() { return null; }',
  '/components/WindowLayer.jsx': 'export default function WindowLayer() { return null; }',
  '/components/AdminPanel.jsx': 'export default function AdminPanel() { return null; }',
  '/components/ElectronNotificationBridge.jsx': 'export default function ElectronNotificationBridge() { return null; }',
  '/components/InboxReplyDraftObserver.js': 'export default function InboxReplyDraftObserver() { return null; }',
  '/plugins/PluginSlot.jsx': 'export const usePluginSlot = () => []; export const usePluginCollected = () => []; export function PluginSlot() { return null; } export function PluginRuntime() { return null; }',
  // An open socket, so the fallback list refresh for a socket that is down stays quiet.
  '/hooks/useWebSocket.js': 'export const useWebSocket = () => ({ current: { readyState: 1 } });',
};

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
    const stub = Object.keys(STUBS).find(path => url.endsWith(path));
    if (stub) return { format: 'module', shortCircuit: true, source: STUBS[stub] };
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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

let visibility = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('../utils/api.js');
const { useStore } = await import('../store/index.js');
const { RESUME_RETRY_MS } = await import('../utils/resumeRefresh.js');
const MailApp = (await import('./MailApp.jsx')).default;

const original = { ...api, todoist: api.todoist };
let root;
let refreshes;
let countsFail;
const countRefresh = () => { refreshes += 1; };

beforeEach(async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  Object.assign(api, {
    getAccounts: async () => [],
    getUnreadCounts: async () => {
      if (countsFail) throw new Error('Failed to fetch');
      return { total: 0, byAccount: {}, snapshots: {}, complete: true };
    },
    getFolders: async () => [],
    todoist: { ...original.todoist, status: async () => ({ connected: false }) },
  });
  useStore.setState({ isLocked: false });
  refreshes = 0;
  countsFail = false;
  visibility = 'visible';
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(MailApp)); });
  dom.window.addEventListener('mailflow:refresh', countRefresh);
});

afterEach(async () => {
  dom.window.removeEventListener('mailflow:refresh', countRefresh);
  await React.act(async () => root.unmount());
  Object.assign(api, original);
});

async function hideFor(t, ms) {
  visibility = 'hidden';
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  t.mock.timers.tick(ms);
  visibility = 'visible';
  await React.act(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
}

describe('MailApp: returning to the tab', () => {
  test('a glance at the app switcher does not reload the list', async (t) => {
    await hideFor(t, 1000);
    assert.equal(refreshes, 0);
  });

  test('coming back after a real absence reloads the list once', async (t) => {
    await hideFor(t, 10 * 60_000);
    assert.equal(refreshes, 1);
  });

  test('a resume that comes back before the network does is tried again', async (t) => {
    countsFail = true;
    await hideFor(t, 10 * 60_000);
    assert.equal(refreshes, 1);
    countsFail = false;
    await React.act(async () => { t.mock.timers.tick(RESUME_RETRY_MS[0]); });
    assert.equal(refreshes, 2, 'the list is asked for again');
    await React.act(async () => { t.mock.timers.tick(60_000); });
    assert.equal(refreshes, 2, 'and only until it works');
  });
});
