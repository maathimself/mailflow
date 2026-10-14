// MessageList's search states (#592): a search still waiting for its response says so instead of
// "no results", and a response that arrives after the query was cleared, or after the account
// or folder changed, is dropped. Harness as MessageList.render.test.js.

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
// useMobile() reads window.innerWidth first, then subscribes to matchMedia. jsdom defaults
// innerWidth to 1024, which is the desktop case the bug report is about.
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
// Search responses are held until a test releases them, as a slow server would.
const pending = [];
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes('/search?')) {
    const body = await new Promise(resolve => pending.push({ path, resolve }));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  }
  const body = path.includes('/mail/messages?') ? { messages: [], total: 0 } : {};
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', color: '#6366f1', include_in_unified_inbox: true };
const hit = (id) => ({
  id, account_id: 'acct-1', folder: 'INBOX', uid: 1, subject: `Synthetic search example ${id}`, snippet: '',
  message_id: `<${id}@example.com>`, from_name: 'S', from_address: 's@example.com', date: new Date().toISOString(),
  is_read: true, is_starred: false, is_deleted: false, has_attachments: false,
});

let root;
const container = () => dom.window.document.getElementById('root');
const text = () => container().textContent;
const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 350)); });
const respond = async (body) => { const next = pending.shift(); assert.ok(next, 'a search request was made'); await React.act(async () => { next.resolve(body); await new Promise(r => setTimeout(r, 0)); }); return next.path; };

async function mount() {
  pending.length = 0;
  if (root) await React.act(async () => root.unmount());
  useStore.setState({
    accounts: [ACCOUNT], accountsReady: true, selectedAccountId: 'acct-1', selectedFolder: 'INBOX',
    messages: [], messagesTotal: 0, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', searchResults: [], isSearching: false, threadedView: false,
    folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }] },
  });
  await React.act(async () => { root = createRoot(container()); root.render(React.createElement(MessageList)); });
}
const search = (q) => React.act(async () => { useStore.getState().setSearchQuery(q); });

describe('MessageList search states (#592)', () => {
  test('says it is searching while the request is pending, and no results only once it says so', async () => {
    await mount();
    await search('Synthetic');
    assert.match(text(), /messageList\.searching/, 'during the debounce');
    assert.doesNotMatch(text(), /messageList\.noSearchResults/);
    await settle();
    assert.match(text(), /messageList\.searching/, 'while the request is pending');
    assert.doesNotMatch(text(), /messageList\.noSearchResults/);
    await respond({ messages: [] });
    assert.match(text(), /messageList\.noSearchResults/);
    assert.equal(container().querySelector('[role="status"]'), null);
  });

  test('shows the results once they arrive', async () => {
    await mount();
    await search('Synthetic');
    await settle();
    await respond({ messages: [hit('a')] });
    assert.match(text(), /Synthetic search example a/);
  });

  test('drops a response that arrives after the query was cleared', async () => {
    await mount();
    await search('Synthetic');
    await settle();
    await search('');
    await respond({ messages: [hit('late')] });
    assert.deepEqual(useStore.getState().searchResults, []);
    assert.doesNotMatch(text(), /Synthetic search example late/);
  });

  // The main search already dropped a response from before a folder change; "load more" checked
  // only the query text, so a page asked for in one folder could be added to another's results.
  test('drops a page of more results that arrives after the folder changed', async () => {
    await mount();
    useStore.setState({ pageSize: 2, folders: { 'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }] } });
    await search('Synthetic');
    await settle();
    await respond({ messages: [hit('a'), hit('b')] });
    const more = [...container().querySelectorAll('button')].find(b => /messageList\.loadMore/.test(b.textContent));
    assert.ok(more, 'a full page offers more');
    await React.act(async () => { more.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const page = pending.shift();
    assert.match(page.path, /offset=2/);
    await React.act(async () => { useStore.setState({ selectedFolder: 'Archive' }); });
    await settle();
    await respond({ messages: [hit('archived')] });
    // The page asked for in INBOX arrives last.
    await React.act(async () => { page.resolve({ messages: [hit('stale')] }); await new Promise(r => setTimeout(r, 0)); });
    assert.deepEqual(useStore.getState().searchResults.map(m => m.id), ['archived']);
  });
});
