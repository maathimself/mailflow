// Render test for the sidebar's folder unread badges (#536).
//
// A collapsed folder showed only its own count, so new mail in its subfolders was invisible
// until it was expanded. The harness mirrors MessageList.render.test.js: node --test cannot
// parse JSX, so the loader hook transforms .jsx with sucrase, and react-i18next is stubbed.

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
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const Sidebar = (await import('./Sidebar.jsx')).default;

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', enabled: true, include_in_unified_inbox: true };
// The issue's example: Investments holds no mail itself, its subfolders hold three unread.
const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', unread_count: 0 },
  { path: 'Investments', name: 'Investments', no_select: true },
  { path: 'Investments/SubfolderA', name: 'SubfolderA', unread_count: 1 },
  { path: 'Investments/SubfolderB', name: 'SubfolderB', unread_count: 0 },
  { path: 'Investments/SubfolderC', name: 'SubfolderC', unread_count: 2 },
  { path: 'Banking', name: 'Banking', unread_count: 1 },
  { path: 'Banking/Cards', name: 'Cards', unread_count: 4 },
  { path: 'Banking/Muted', name: 'Muted', unread_count: 7 },
];

let root;
async function mount({ collapsed = [], hidden = [] }) {
  if (root) await React.act(async () => root.unmount());
  useStore.setState({
    accounts: [ACCOUNT], accountsReady: true,
    folders: { 'acct-1': FOLDERS },
    selectedAccountId: 'acct-1', selectedFolder: 'INBOX',
    expandedAccounts: { 'acct-1': true },
    collapsedFolders: collapsed.map(p => `acct-1:${p}`),
    hiddenFolders: hidden.length ? { 'acct-1': hidden } : {},
  });
  await React.act(async () => {
    root = createRoot(dom.window.document.getElementById('root'));
    root.render(React.createElement(Sidebar));
  });
}

// The badge text on a folder's row, found by the row's label; null when the row has no badge.
function badgeOf(name) {
  const label = [...dom.window.document.querySelectorAll('span')].find(s => s.textContent === name);
  assert.ok(label, `expected a row for ${name}`);
  const badge = label.nextElementSibling;
  return badge && badge.tagName === 'SPAN' ? badge.textContent : null;
}

describe('Sidebar — collapsed folders show their subfolders\' unread mail (#536)', () => {
  test('a collapsed container folder shows the total of its subfolders', async () => {
    await mount({ collapsed: ['Investments'] });
    assert.equal(badgeOf('Investments'), '3');
  });

  test('expanded, the parent shows only its own count and each subfolder its own', async () => {
    await mount({ collapsed: [] });
    assert.equal(badgeOf('Investments'), null);
    assert.equal(badgeOf('SubfolderA'), '1');
    assert.equal(badgeOf('SubfolderC'), '2');
    assert.equal(badgeOf('Banking'), '1');
  });

  test('a collapsed folder with mail of its own adds it, and hidden subfolders stay out', async () => {
    await mount({ collapsed: ['Banking'], hidden: ['Banking/Muted'] });
    assert.equal(badgeOf('Banking'), '5');
  });
});
