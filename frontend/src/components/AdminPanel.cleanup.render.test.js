// Render test for Mailbox Cleanup over several senders at once (#602).
//
// One confirm covers every ticked sender, each sender is still looked up on the server on its own
// and moved in batches of at most 500, and nothing can be changed while a run is going.
//
// Same loader hooks as ProfileModal.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed so t() returns its key.

import { test, describe, before, afterEach } from 'node:test';
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
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const AdminPanel = (await import('./AdminPanel.jsx')).default;

const ACCOUNTS = [
  { id: '11111111-1111-4111-8111-111111111111', email_address: 'me@example.invalid' },
  { id: '22222222-2222-4222-8222-222222222222', email_address: 'other@example.invalid' },
];
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const SENDERS = {
  'deals@shop.invalid': ids('deals', 1200),
  'news@paper.invalid': ids('news', 3),
  'promo@brand.invalid': ids('promo', 7),
};
const usage = (senders = SENDERS) => ({
  accountId: ACCOUNTS[0].id, inboxTotal: 5000, bulkTotal: 1210, archiveAvailable: true,
  tier1Senders: Object.entries(senders).map(([fromEmail, list]) => ({ fromEmail, fromName: '', count: list.length })),
  tier2Keywords: [],
});

describe('Mailbox Cleanup: several senders at once (#602)', () => {
  let calls, confirms, root, current, gate;

  before(() => {
    api.admin.getSettings = async () => ({ settings: {} });
    api.getUnreadCounts = async () => ({});
    api.mailboxUsage = async (id) => { calls.push(['usage', id]); return usage(current); };
    api.cleanupPreview = async (accountId, fromEmail) => {
      calls.push(['preview', accountId, fromEmail]);
      if (gate) await gate;
      return { ids: current[fromEmail] ?? [] };
    };
    api.bulkArchive = async (list) => {
      calls.push(['archive', list.length, list[0]]);
      for (const k of Object.keys(current)) current[k] = current[k].filter(id => !list.includes(id));
      for (const k of Object.keys(current)) if (!current[k].length) delete current[k];
    };
    api.bulkDelete = async (list) => { calls.push(['trash', list.length, list[0]]); };
  });
  afterEach(() => React.act(async () => root.unmount()));

  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  const checkbox = (email) => document.querySelector(`input[type="checkbox"][aria-label="${email}"]`);
  const batchButton = () => document.getElementById('cleanup-select-all').parentElement.querySelector('button');

  async function open() {
    calls = []; confirms = []; gate = null;
    current = Object.fromEntries(Object.entries(SENDERS).map(([k, v]) => [k, [...v]]));
    window.confirm = (text) => { confirms.push(text); return true; };
    useStore.setState({ user: { id: 'u1' }, accounts: ACCOUNTS, adminTab: 'cleanup' });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(AdminPanel)); });
  }

  test('ticked senders run with one confirm, each looked up on its own, in batches of 500', async () => {
    await open();
    assert.equal(batchButton().disabled, true, 'nothing ticked: the batch button is off');
    await click(checkbox('deals@shop.invalid'));
    await click(checkbox('promo@brand.invalid'));
    assert.match(batchButton().textContent, /\(2\)$/);

    calls = [];
    await click(batchButton());

    assert.equal(confirms.length, 1, 'one confirm for the whole run');
    assert.deepEqual(calls, [
      ['preview', ACCOUNTS[0].id, 'deals@shop.invalid'],
      ['archive', 500, 'deals-0'], ['archive', 500, 'deals-500'], ['archive', 200, 'deals-1000'],
      ['preview', ACCOUNTS[0].id, 'promo@brand.invalid'],
      ['archive', 7, 'promo-0'],
      ['usage', ACCOUNTS[0].id],
    ]);
    assert.deepEqual([...document.querySelectorAll('input[type="checkbox"][aria-label]')].map(c => c.getAttribute('aria-label')),
      ['news@paper.invalid'], 'the cleared senders are gone and the untouched one stays');
    assert.equal(checkbox('news@paper.invalid').checked, false);
  });

  test('select all, then the row button still runs only its own sender', async () => {
    await open();
    await click(document.getElementById('cleanup-select-all'));
    assert.match(batchButton().textContent, /\(3\)$/);
    assert.equal(document.querySelector('label[for="cleanup-select-all"]').textContent, 'messageList.deselectAll');

    calls = [];
    const row = checkbox('news@paper.invalid').parentElement;
    await click(row.querySelector('button'));
    assert.equal(confirms.length, 1);
    assert.deepEqual(calls.filter(c => c[0] !== 'usage'), [['preview', ACCOUNTS[0].id, 'news@paper.invalid'], ['archive', 3, 'news-0']]);
  });

  test('while a run is going, the boxes, the account and the action cannot change', async () => {
    await open();
    await click(checkbox('news@paper.invalid'));
    await click(checkbox('promo@brand.invalid'));
    let release; gate = new Promise(r => { release = r; });
    // act() returns once the click is handled; the run itself waits on the gate.
    await React.act(async () => {
      batchButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    assert.ok([...document.querySelectorAll('input[type="checkbox"]')].every(c => c.disabled), 'every box is off');
    assert.equal(document.querySelector('select').disabled, true, 'the account picker is off');
    assert.ok([...document.querySelectorAll('button')].filter(b => b.textContent === 'admin.cleanup.moveToTrash').every(b => b.disabled));
    assert.match(batchButton().textContent, /^0\/10$/, 'the batch button shows the combined progress');

    await React.act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
    assert.equal(document.querySelector('select').disabled, false);
  });

  test('a cancelled confirm moves nothing', async () => {
    await open();
    await click(checkbox('deals@shop.invalid'));
    window.confirm = () => false;
    calls = [];
    await click(batchButton());
    assert.deepEqual(calls, []);
  });

  test('switching account clears the ticks', async () => {
    await open();
    await click(checkbox('deals@shop.invalid'));
    const select = document.querySelector('select');
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    await React.act(async () => { setValue.call(select, ACCOUNTS[1].id); select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    assert.equal(checkbox('deals@shop.invalid').checked, false);
    assert.equal(batchButton().disabled, true);
  });
});
