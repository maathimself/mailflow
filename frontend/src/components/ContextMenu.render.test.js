// Render test for the Categorize submenu's "Always for this sender / domain" (#490).
//
// The harness mirrors MessageList.render.test.js: node --test cannot parse JSX, so the loader
// hook transforms .jsx with sucrase, and react-i18next is stubbed to return the key.

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

const ContextMenu = (await import('./ContextMenu.jsx')).default;

const ACCOUNT = { id: 'acct-1', email_address: 'a@example.com', name: 'A', enabled: true };
let root;
async function openMenu(message) {
  if (root) await React.act(async () => root.unmount());
  useStore.setState({ accounts: [ACCOUNT], categorizationEnabled: true, folders: {} });
  const calls = [];
  await React.act(async () => {
    root = createRoot(dom.window.document.getElementById('root'));
    root.render(React.createElement(ContextMenu, {
      x: 10, y: 10, message, onClose: () => {}, onAction: (...args) => calls.push(args),
    }));
  });
  return calls;
}
const byText = text => [...dom.window.document.querySelectorAll('span, div')].find(el => el.textContent === text && !el.children.length);
async function click(text) {
  const el = byText(text);
  assert.ok(el, `expected "${text}" in the menu`);
  await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
}

describe('ContextMenu — Always for this sender / domain (#490)', () => {
  const MESSAGE = { id: 'm1', account_id: 'acct-1', folder: 'INBOX', from_email: 'Orders@Shop.example', category: null, is_read: true };

  test('Categorize offers both, and a category under one of them saves it for that scope', async () => {
    const calls = await openMenu(MESSAGE);
    await click('contextMenu.categorize');
    assert.ok(byText('contextMenu.categoryAlwaysSender'));
    assert.ok(byText('contextMenu.categoryAlwaysDomain'));
    await click('contextMenu.categoryAlwaysDomain');
    assert.ok(byText('contextMenu.categoryAlwaysFor'), 'expected the scoped list with its back row');
    await click('messageList.categories.automated');
    assert.deepEqual(calls, [['setCategoryAlways', { scope: 'domain', category: 'automated' }]]);
  });

  test('a plain category still changes only this message', async () => {
    const calls = await openMenu(MESSAGE);
    await click('contextMenu.categorize');
    await click('messageList.categories.social');
    assert.deepEqual(calls, [['setCategory', 'social']]);
  });

  test('without a sender address there is nothing to match, so neither appears', async () => {
    await openMenu({ ...MESSAGE, from_email: '' });
    await click('contextMenu.categorize');
    assert.equal(byText('contextMenu.categoryAlwaysSender'), undefined);
  });
});

describe('ContextMenu — Forward as attachment (#466)', () => {
  test('sits with the compose actions and asks for a forward as attachment', async () => {
    const calls = await openMenu({ id: 'm1', account_id: 'acct-1', folder: 'INBOX', from_email: 'a@b.example', is_read: true });
    await click('contextMenu.forwardAsAttachment');
    assert.deepEqual(calls, [['forwardAsAttachment']]);
  });
});

describe('ContextMenu — a snoozed message (#269)', () => {
  // Picker rows are an icon and their text: matched by their own text, not their whole content.
  const ownText = text => [...dom.window.document.querySelectorAll('div, span')].find(el =>
    [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === text));
  const clickOwn = async (text) => {
    const el = ownText(text);
    assert.ok(el, `expected "${text}" in the menu`);
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  const SNOOZED = { id: 'm9', account_id: 'acct-1', folder: 'Snoozed', from_email: 'a@b.example', is_read: true, snooze_until: '2030-01-01T09:00:00Z' };

  test('offers to change when it comes back, or to bring it back now, not to snooze it again', async () => {
    const calls = await openMenu(SNOOZED);
    assert.equal(byText('contextMenu.snooze.label'), undefined);
    await click('contextMenu.snooze.unsnooze');
    assert.deepEqual(calls, [['unsnooze']]);
  });

  test('the same picker then changes the time', async () => {
    const calls = await openMenu(SNOOZED);
    await click('contextMenu.snooze.change');
    assert.ok(ownText('contextMenu.snooze.change'), 'the picker says what it does');
    await clickOwn('contextMenu.snooze.threeHours');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'changeSnooze');
    assert.ok(new Date(calls[0][1]) > new Date(), 'a time in the future');
  });

  test('a message in any other folder is snoozed as before', async () => {
    const calls = await openMenu({ ...SNOOZED, folder: 'INBOX', snooze_until: undefined });
    assert.equal(byText('contextMenu.snooze.unsnooze'), undefined);
    await click('contextMenu.snooze.label');
    await clickOwn('contextMenu.snooze.threeHours');
    assert.equal(calls[0][0], 'snooze');
  });
});
