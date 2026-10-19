// Render test for the names the sidebar's empty and delete actions show (#623 follow-up).
//
// SmarterMail's Trash is a folder named "Deleted Items" flagged \Trash, which the sidebar labels
// "Trash". Emptying it asked about and reported "Deleted Items", a name the sidebar never shows.
// The harness is Sidebar.render.test.js's, with English strings so the messages can be read.

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
        // English strings with their {{values}} filled in: the folder names in the messages are
        // what these tests check.
        `const en = ${readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')};`,
        'const t = (k, o) => { const s = k.split(".").reduce((n, p) => n?.[p], en); return typeof s === "string" ? s.replace(/{{(\\w+)}}/g, (m, v) => String(o?.[v] ?? m)) : (typeof o === "string" ? o : o?.defaultValue ?? k); };',
        'export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
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

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', enabled: true, include_in_unified_inbox: true, folder_mappings: {} };
const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', unread_count: 0 },
  { path: 'Deleted Items', name: 'Deleted Items', special_use: '\\Trash', unread_count: 0 },
  { path: 'Junk E-mail', name: 'Junk E-mail', special_use: '\\Junk', unread_count: 0 },
  { path: 'Projects', name: 'Projects', unread_count: 0 },
];

let root;
async function mount(account = ACCOUNT, folders = FOLDERS) {
  if (root) await React.act(async () => root.unmount());
  useStore.setState({
    accounts: [account], accountsReady: true,
    folders: { 'acct-1': folders },
    selectedAccountId: 'acct-1', selectedFolder: 'INBOX',
    expandedAccounts: { 'acct-1': true },
    collapsedFolders: [], hiddenFolders: {}, notifications: [],
  });
  await React.act(async () => {
    root = createRoot(dom.window.document.getElementById('root'));
    root.render(React.createElement(Sidebar));
  });
}

const doc = () => dom.window.document;
const byText = (selector, text) => [...doc().querySelectorAll(selector)].find(el => el.textContent === text);

// Opens a folder row's context menu, picks `item`, and returns the confirmation's message.
async function chooseFromMenu(rowLabel, item) {
  const row = byText('span', rowLabel);
  assert.ok(row, `expected a row labeled ${rowLabel}`);
  await React.act(async () => {
    row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  const entry = [...doc().querySelectorAll('button, [role="menuitem"], div')].reverse()
    .find(el => el.textContent.trim() === item);
  assert.ok(entry, `expected a menu item ${item}`);
  await React.act(async () => entry.click());
  return [...doc().querySelectorAll('p')].map(p => p.textContent).find(text => text.includes('permanently deleted'));
}

describe('Sidebar: emptying a role folder names it as the sidebar does (#623)', () => {
  test('the Trash the server calls "Deleted Items" is asked about and reported as Trash', async () => {
    await mount();
    assert.equal(await chooseFromMenu('Trash', 'Empty folder'),
      'Empty "Trash"? All messages in this folder will be permanently deleted.');
    await React.act(async () => byText('button', 'Delete').click());
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    const titles = useStore.getState().notifications.map(n => n.title);
    assert.ok(titles.includes('Emptying "Trash"…'), `notifications: ${JSON.stringify(titles)}`);
    assert.ok(!titles.some(title => title.includes('Deleted Items')));
  });

  test('so is a spam folder, and one mapped in the account settings', async () => {
    await mount({ ...ACCOUNT, folder_mappings: { archive: 'Projects' } });
    assert.equal(await chooseFromMenu('Spam', 'Empty folder'),
      'Empty "Spam"? All messages in this folder will be permanently deleted.');
    await React.act(async () => byText('button', 'Cancel').click());
    assert.equal(await chooseFromMenu('Archive', 'Empty folder'),
      'Empty "Archive"? All messages in this folder will be permanently deleted.');
  });

  test('a folder without a role keeps its own name', async () => {
    await mount();
    assert.equal(await chooseFromMenu('Projects', 'Delete folder'),
      'Delete folder "Projects"? All messages in it will be permanently deleted.');
  });
});
