// Render test for what a screen reader hears of notifications (design 5.4): each new one once,
// errors through role="alert" and the rest through role="status", and the toasts and Undo bars
// themselves not live regions, so nothing is read twice.
//
// Mounted the way ScheduledList.render.test.js mounts the Scheduled view.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (k, o) => (o && typeof o === "object" && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k);',
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
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const NotificationToasts = (await import('./NotificationToasts.jsx')).default;
const UndoBar = (await import('./UndoBar.jsx')).default;

let root = null;
async function mount({ mobile = false } = {}) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: mobile ? 375 : 1280 });
  useStore.setState({ notifications: [] });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(NotificationToasts)); });
}
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = null;
});
const add = n => React.act(async () => { useStore.getState().addNotification(n); });
const region = kind => document.querySelector(`[data-announce="${kind}"]`);
const said = kind => [...region(kind).children].map(el => el.textContent);

test('the live regions are there before anything is said', async () => {
  await mount();
  assert.equal(region('status').getAttribute('role'), 'status');
  assert.equal(region('alert').getAttribute('role'), 'alert');
  assert.deepEqual(said('status'), []);
  assert.deepEqual(said('alert'), []);
});

test('a notice is said politely, an error assertively, each once, with its body', async () => {
  await mount();
  await add({ title: 'Scheduled for Tomorrow 8:00 AM', body: 'Q4 numbers' });
  await add({ type: 'error', title: 'Q4 numbers', body: 'The mail server refused it.' });
  assert.deepEqual(said('status'), ['Scheduled for Tomorrow 8:00 AM. Q4 numbers']);
  assert.deepEqual(said('alert'), ['Q4 numbers. The mail server refused it.']);
  // Another change to the list (one dismissed) says nothing again.
  await React.act(async () => { useStore.getState().removeNotification(useStore.getState().notifications[0].id); });
  assert.deepEqual(said('status'), ['Scheduled for Tomorrow 8:00 AM. Q4 numbers']);
  assert.equal(said('alert').length, 1);
  // The same words again are a new element, so they are said again.
  await add({ title: 'Scheduled for Tomorrow 8:00 AM', body: 'Q4 numbers' });
  assert.equal(said('status').length, 2);
});

test('an Undo notice is said even where a list draws it, and no toast is a live region', async () => {
  await mount();
  await add({ title: 'Sending "Q4 numbers"', onUndo: () => {}, undoMs: 10_000 });
  assert.deepEqual(said('status'), ['Sending "Q4 numbers"']);
  const live = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')];
  assert.deepEqual(live.map(el => el.dataset.announce), ['status', 'alert'], 'only the two regions');
  await React.act(async () => { root.unmount(); });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => {
    root.render(React.createElement(UndoBar, { notification: { title: 'Deleted', onUndo: () => {} }, onDismiss: () => {} }));
  });
  assert.equal(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length, 0, 'the Undo bar is not one');
});

test('on a phone the action bars and toasts are said the same way', async () => {
  await mount({ mobile: true });
  await add({ title: 'Deleted', onUndo: () => {} });
  await add({ type: 'error', title: 'Could not restore it' });
  assert.deepEqual(said('status'), ['Deleted']);
  assert.deepEqual(said('alert'), ['Could not restore it']);
  assert.deepEqual([...document.querySelectorAll('[role="status"], [role="alert"]')].map(el => el.dataset.announce), ['status', 'alert']);
});

// #813: on a desktop the list draws the Undo bars, so a hidden list hid them. With the list off
// screen they float here instead, and only then.
const undoButtons = () => [...document.querySelectorAll('button')].filter(b => /undo/i.test(b.textContent));
async function mountDesktop(state) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  useStore.setState({ notifications: [], layout: 'comfortable', selectedMessageId: null, showContacts: false, ...state });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(NotificationToasts)); });
}

test('desktop: the Undo bar floats while a message is open in List first (#813)', async () => {
  await mountDesktop({ layout: 'list', selectedMessageId: 'm1' });
  await add({ title: 'Sending "Q4 numbers"', onUndo: () => {}, undoMs: 10_000 });
  assert.equal(undoButtons().length, 1);
  assert.match(document.body.textContent, /Sending "Q4 numbers"/);
});

test('desktop: the Undo bar floats while Contacts is open (#813)', async () => {
  await mountDesktop({ showContacts: true });
  await add({ title: 'Deleted', onUndo: () => {} });
  assert.equal(undoButtons().length, 1);
});

test('desktop: with the list on screen the list draws the Undo bar, not this', async () => {
  await mountDesktop({ layout: 'list', selectedMessageId: null });
  await add({ title: 'Deleted', onUndo: () => {} });
  assert.equal(undoButtons().length, 0, 'List first showing the list');
  await React.act(async () => root.unmount());
  await mountDesktop({ layout: 'comfortable', selectedMessageId: 'm1' });
  await add({ title: 'Deleted', onUndo: () => {} });
  assert.equal(undoButtons().length, 0, 'a split layout: the list is beside the message');
});

test('desktop: opening a message hands a running Undo bar over to the floating one', async () => {
  let undone = 0;
  await mountDesktop({ layout: 'list', selectedMessageId: null });
  await add({ title: 'Archived', onUndo: () => { undone++; } });
  assert.equal(undoButtons().length, 0);
  await React.act(async () => { useStore.setState({ selectedMessageId: 'm1' }); });
  assert.equal(undoButtons().length, 1);
  await React.act(async () => { undoButtons()[0].click(); });
  assert.equal(undone, 1);
});

test('a bar for a notification whose window has run out leaves at once', async () => {
  await mountDesktop({ layout: 'list', selectedMessageId: 'm1' });
  await add({ title: 'Deleted', onUndo: () => {}, createdAt: Date.now() - 60_000 });
  await React.act(async () => { await new Promise(r => setTimeout(r, 300)); });
  assert.equal(useStore.getState().notifications.length, 0);
});
