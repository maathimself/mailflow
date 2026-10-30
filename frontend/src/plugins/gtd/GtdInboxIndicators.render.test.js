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
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : d?.state ? `${d.state}: ${d.count}` : d?.defaultValue ?? k), i18n: { language: "en", changeLanguage: () => {} } });',
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
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const Indicator = (await import('./GtdInboxIndicators.jsx')).default;
const { patchGtdMetadata, clearGtdMetadata, tickGtdMetadataClock } = await import('./metadataStore.js');

test('waiting chips keep their state accessible and age without a metadata request', async () => {
  const root = createRoot(document.getElementById('root'));
  const now = Date.parse('2026-10-09T00:00:00Z');
  const message = { id: 'aged-row', account_id: 'account' };
  try {
    tickGtdMetadataClock(now);
    patchGtdMetadata(message, 'watch', new Date(now - 14 * 86400000).toISOString());
    await React.act(async () => root.render(React.createElement(Indicator, { message })));
    const chip = document.querySelector('[aria-label]');
    assert.equal(chip.textContent, '⏱ 14d');
    assert.ok(chip.getAttribute('aria-label').includes('gtd.state.watch'));
    const color = chip.style.color;
    await React.act(async () => { tickGtdMetadataClock(now + 86400000); });
    assert.equal(chip.textContent, '⏱ 15d');
    assert.notEqual(chip.style.color, color);
    await React.act(async () => { clearGtdMetadata(); });
    assert.equal(document.querySelector('[aria-label]'), null);
  } finally { await React.act(async () => root.unmount()); }
});


test('runtime fetches GTD search results even for accounts excluded from unified inbox', async () => {
  const { useStore } = await import('../../store/index.js');
  const { api } = await import('../../utils/api.js');
  const Runtime = (await import('./GtdRuntime.jsx')).default;
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  api.gtdMetadata = async (account, ids) => { calls.push([account, ids]); return { messages: {} }; };
  useStore.setState({ user: { id: 'search-user' }, enabledPlugins: ['gtd'],
    accounts: [{ id: 'excluded', enabled: true, gtd_enabled: true, include_in_unified_inbox: false }],
    selectedAccountId: null, selectedFolder: 'INBOX', searchQuery: 'test',
    searchResults: [{ id: 'search-row', account_id: 'excluded' }], messages: [], activeGtdTab: null });
  try {
    await React.act(async () => root.render(React.createElement(Runtime)));
    assert.deepEqual(calls, [['excluded', ['search-row']]]);
    await React.act(async () => { useStore.setState({ searchResults: [{ id: 'search-row', account_id: 'excluded', is_read: true }] }); });
    assert.equal(calls.length, 1, 'read-state churn keeps the same visible identity pool');
    await React.act(async () => {
      useStore.setState({ accounts: [{ id: 'excluded', enabled: true, gtd_enabled: true, include_in_unified_inbox: false, unread_count: 1 }] });
    });
    assert.equal(calls.length, 1, 'unread-counter churn keeps the same enabled-account configuration');
    const { invalidateGtdMetadata } = await import('./metadataStore.js');
    await React.act(async () => { invalidateGtdMetadata(); });
    assert.equal(calls.length, 2, 'label changes still refresh unchanged rows');
    await React.act(async () => {
      useStore.setState({ accounts: [{ id: 'excluded', enabled: true, gtd_enabled: true, include_in_unified_inbox: false, gtd_folders: { todo: 'Next Actions' } }] });
    });
    assert.equal(calls.length, 3, 'folder-map changes still refresh unchanged rows');
  } finally { await React.act(async () => root.unmount()); }
});
