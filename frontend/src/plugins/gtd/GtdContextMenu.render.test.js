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
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = dom.window.matchMedia;
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { buildGtdContextItems } = await import('./GtdContextMenu.jsx');
const { useStore } = await import('../../store/index.js');
const { api } = await import('../../utils/api.js');
const { closeDelegation, getDelegationSnapshot } = await import('./delegationController.js');
const { submitOpenDelegation } = await import('./delegation.js');
const { buildGtdMovePickerSections } = await import('./movePickerSections.js');
const t = key => key;
const message = { id: 'clicked', account_id: 'account', folders: ['Todo'] };
const account = { id: 'account', gtd_enabled: true };

async function menu({ targets, connected = true } = {}) {
  closeDelegation();
  const calls = { classify: [], delegate: [], close: [], status: 0 };
  api.carddav.status = async () => { calls.status++; return { connected }; };
  api.gtdDelegate = async (...args) => {
    calls.delegate.push(args);
    return { status: 'success', successCount: 1, failureCount: 0, results: [] };
  };
  api.gtdClassify = async (...args) => { calls.classify.push(args); return {}; };
  useStore.setState({ addNotification() {}, scheduleGtdSectionsFetch() {} });
  let submenu;
  const items = buildGtdContextItems({
    message, account, targetMessageIds: targets, t,
    onClose: () => calls.close.push(getDelegationSnapshot().phase),
    openSubmenu: render => { submenu = render(() => {}); },
  });
  items.find(item => item.label === 'gtd.title').action();
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(submenu));
  return { calls, items, root, async click(label) {
    const row = [...document.querySelectorAll('span')].find(el => el.textContent === label);
    assert.ok(row, `menu contains ${label}`);
    await React.act(async () => row.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  } };
}

test('context root offers the existing GTD submenu without a parallel Delegate action', async () => {
  const h = await menu();
  try { assert.deepEqual(h.items.map(item => item.label), ['gtd.title']); }
  finally { await React.act(async () => h.root.unmount()); }
});

for (const [name, targets, expected] of [
  ['single', undefined, ['clicked']],
  ['bulk', ['second', 'clicked', 'second', null], ['second', 'clicked']],
]) {
  test(`GTD → Delegated opens the CardDAV picker with frozen ${name} targets`, async () => {
    const h = await menu({ targets });
    try {
      await h.click('gtd.state.delegated');
      targets?.push('later-selection');
      const snapshot = getDelegationSnapshot();
      assert.equal(snapshot.phase, 'picker');
      assert.deepEqual(snapshot.messageIds, expected);
      assert.ok(Object.isFrozen(snapshot.messageIds));
      assert.equal(h.calls.status, 1);
      assert.deepEqual(h.calls.classify, []);
      assert.deepEqual(h.calls.close, ['checking']);
      await submitOpenDelegation('carddav-person', { api, store: useStore.getState(), t });
      assert.deepEqual(h.calls.delegate, [[expected, 'carddav-person']]);
    } finally { closeDelegation(); await React.act(async () => h.root.unmount()); }
  });
}

test('GTD → Delegated submits without a person when CardDAV is disconnected', async () => {
  const h = await menu({ connected: false, targets: ['clicked', 'second', 'clicked'] });
  try {
    await h.click('gtd.state.delegated');
    assert.deepEqual(h.calls.delegate, [[['clicked', 'second'], null]]);
    assert.deepEqual(h.calls.classify, []);
    assert.equal(getDelegationSnapshot().phase, 'closed');
    assert.equal(h.calls.close.length, 1);
  } finally { await React.act(async () => h.root.unmount()); }
});

test('other GTD states still classify the clicked thread and close the menu', async () => {
  const h = await menu({ targets: ['clicked', 'second'] });
  try {
    for (const state of ['todo', 'watch', 'reference', 'someday']) await h.click(`gtd.state.${state}`);
    assert.deepEqual(h.calls.classify, [
      ['clicked', 'todo'], ['clicked', 'watch'], ['clicked', 'reference'], ['clicked', 'someday'],
    ]);
    assert.equal(h.calls.close.length, 4);
    assert.equal(h.calls.status, 0);
    assert.deepEqual(h.calls.delegate, []);
  } finally { await React.act(async () => h.root.unmount()); }
});

test('Remove from state and sidebar Done keep their existing actions', async () => {
  const h = await menu();
  const removals = [];
  api.gtdUnclassify = async (...args) => { removals.push(args); };
  try {
    await h.click('gtd.state.todo: undefined');
    assert.deepEqual(removals, [['clicked', 'todo']]);
    assert.equal(h.calls.close.length, 1);
    const actions = [];
    const items = buildGtdContextItems({
      message, account, variant: 'gtdSidebar', t,
      onAction: action => actions.push(action),
    });
    assert.deepEqual(items.map(item => item.label), ['gtd.title', 'gtd.done']);
    items[1].action();
    assert.deepEqual(actions, ['gtdDone']);
    assert.equal(h.calls.status, 0);
  } finally { await React.act(async () => h.root.unmount()); }
});

test('folder and label picker contributions keep their single existing GTD section', () => {
  const sections = buildGtdMovePickerSections({ account, messages: [message], t }, {
    classifyOne() {}, classifyMany() {}, renderStateIcon() {},
  });
  assert.deepEqual(sections.map(section => section.key), ['gtd']);
  assert.deepEqual(sections[0].items.map(item => item.label), [
    'gtd.state.todo', 'gtd.state.delegated', 'gtd.state.watch', 'gtd.state.reference', 'gtd.state.someday',
  ]);
});

test('reader and detached slots keep person pills and generic actions without a GTD Delegate button', async () => {
  await import('./index.jsx');
  const { PluginSlot } = await import('../PluginSlot.jsx');
  const { registerSlot } = await import('../registry.js');
  const { patchGtdDelegation } = await import('./metadataStore.js');
  registerSlot('message-pane-actions', {
    pluginId: 'fixture-plugin', render: () => React.createElement('button', null, 'Other plugin action'),
  });
  useStore.setState({ enabledPlugins: ['gtd', 'fixture-plugin'], accounts: [account] });
  patchGtdDelegation(message.id, { displayName: 'Casey', delegatedAt: '2026-10-23T00:00:00Z' });
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(PluginSlot, { name: 'message-pane-actions', ctx: { message } }),
      React.createElement(PluginSlot, { name: 'message-pane-meta', ctx: { message } }),
    )));
    assert.deepEqual([...document.querySelectorAll('button')].map(el => el.textContent), ['Other plugin action']);
    assert.ok(document.body.textContent.includes('Casey'));
  } finally { await React.act(async () => root.unmount()); }
});


test('the submenu picker requests only CardDAV contacts and restores focus on Escape', async () => {
  const h = await menu();
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const queries = [];
  api.getContacts = async query => { queries.push(query); return { contacts: [] }; };
  const Picker = (await import('./DelegateContactPicker.jsx')).default;
  try {
    await h.click('gtd.state.delegated');
    assert.equal(getDelegationSnapshot().phase, 'picker');
    await React.act(async () => h.root.unmount());
    const root = createRoot(document.getElementById('root'));
    try {
      await React.act(async () => root.render(React.createElement(Picker, {
        targetCount: 1, onCancel: closeDelegation, onSelect() {},
      })));
      assert.equal(document.activeElement.getAttribute('role'), 'combobox');
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
      assert.deepEqual(queries, [{ q: '', limit: 30, offset: 0, source: 'carddav' }]);
      await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.equal(getDelegationSnapshot().phase, 'closed');
    } finally { await React.act(async () => root.unmount()); }
    assert.equal(document.activeElement, trigger);
  } finally { trigger.remove(); closeDelegation(); }
});
