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

test('header metadata pool includes selected Sent and GTD-tab threads', async () => {
  const { useStore } = await import('../../store/index.js');
  const { api } = await import('../../utils/api.js');
  const Runtime = (await import('./GtdRuntime.jsx')).default;
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  api.gtdMetadata = async (account, ids) => { calls.push([account, ids]); return { messages: {} }; };
  const selected = { id: 'selected', account_id: 'account', thread_id: 'thread' };
  useStore.setState({ user: { id: 'header-user' }, enabledPlugins: ['gtd'],
    accounts: [{ id: 'account', gtd_enabled: true }], selectedAccountId: 'account',
    selectedFolder: 'Sent', searchQuery: '', searchResults: [], messages: [selected],
    selectedMessageId: selected.id, activeGtdTab: 'todo', messageWindows: [],
    threadMessages: { thread: [selected, { ...selected, id: 'member' }] }, fetchGtdSections: () => {} });
  try {
    await React.act(async () => root.render(React.createElement(Runtime)));
    assert.deepEqual(calls, [['account', ['member', 'selected']]]);
  } finally { await React.act(async () => root.unmount()); }
});

test('header metadata pool reuses loaded rows and coalesces residual changes without double fetching', async context => {
  const { useStore } = await import('../../store/index.js');
  const { api } = await import('../../utils/api.js');
  const Runtime = (await import('./GtdRuntime.jsx')).default;
  const { invalidateGtdMetadata } = await import('./metadataStore.js');
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  api.gtdMetadata = async (account, ids) => { calls.push([account, ids]); return { messages: {} }; };
  const listed = { id: 'listed', account_id: 'account', thread_id: 'thread', message_id: '<live>' };
  context.mock.timers.enable({ apis: ['setTimeout'] });
  useStore.setState({ user: { id: 'header-user' }, enabledPlugins: ['gtd'],
    accounts: [{ id: 'account', gtd_enabled: true }, { id: 'unused', gtd_enabled: true }], selectedAccountId: 'account',
    selectedFolder: 'INBOX', searchQuery: '', searchResults: [], messages: [listed],
    selectedMessageId: listed.id, activeGtdTab: null, messageWindows: [], fetchGtdSections: () => {},
    threadMessages: { thread: [{ ...listed, message_id: '<stale>' }, { ...listed, id: 'member' }],
      parked: [{ id: 'window', account_id: 'account' }, { id: 'window2', account_id: 'account' }] } });
  const change = patch => React.act(async () => { useStore.setState(patch); });
  const settle = (milliseconds = 230) => React.act(async () => { context.mock.timers.tick(milliseconds); });
  try {
    await React.act(async () => root.render(React.createElement(Runtime)));
    assert.deepEqual(calls, [['account', ['listed', 'member']]]);
    await change({ selectedMessageId: 'member' });
    await change({ selectedMessageId: 'listed' });
    await change({ messages: [{ ...listed, is_read: true, is_starred: true, subject: 'changed', date: '2020-01-01' }], accounts: useStore.getState().accounts.toReversed() });
    await settle();
    assert.equal(calls.length, 1, 'listed selections and in-thread navigation reuse the pool');
    await change({ messageWindows: [{ messageId: listed.id }] });
    await settle();
    assert.equal(calls.length, 1, 'duplicate window keeps active-list provenance and does not refetch');
    await change({ messageWindows: [{ messageId: 'window' }] });
    assert.equal(calls.length, 1, 'residual membership changes wait for the debounce');
    await settle();
    assert.equal(calls.length, 2);
    await change({ messageWindows: [{ messageId: 'window', z: 10, x: 400, minimized: true }] });
    await settle();
    assert.equal(calls.length, 2, 'window geometry does not refetch');
    await change({ messageWindows: [] });
    await settle();
    assert.equal(calls.length, 3, 'window close fetches the new pool once');
    await change({ messageWindows: [{ messageId: 'window' }] });
    await settle(50);
    await change({ messageWindows: [{ messageId: 'window2' }] });
    await settle(199);
    assert.equal(calls.length, 3, 'the replacement pool waits its full 200ms');
    await settle(1);
    assert.equal(calls.length, 4, 'rapid residual membership changes coalesce');
    assert.deepEqual(calls.at(-1)[1], ['listed', 'member', 'window2']);
    await change({ messageWindows: [] });
    await React.act(async () => { invalidateGtdMetadata(); });
    assert.equal(calls.length, 5, 'refresh supersedes the pending debounce immediately');
    await settle();
    assert.equal(calls.length, 5, 'the superseded debounce cannot double fetch');
  } finally { await React.act(async () => root.unmount()); }
});

test('header chips show every actual state by name and obey both activation gates', async () => {
  await import('./index.jsx');
  const { PluginSlot } = await import('../PluginSlot.jsx');
  const { useStore } = await import('../../store/index.js');
  const { fetchVisibleGtdMetadata, getGtdMetadataClock } = await import('./metadataStore.js');
  const root = createRoot(document.getElementById('root'));
  const message = { id: 'header', account_id: 'account' };
  let account = { id: 'account', gtd_enabled: true };
  const states = ['todo', 'watch', 'delegated', 'reference', 'someday'];
  const render = () => root.render(React.createElement(PluginSlot, { name: 'message-header-meta', ctx: { message, account } }));
  const labels = () => [...document.querySelectorAll('[role="img"]')].map(chip => chip.textContent);
  useStore.setState({ enabledPlugins: ['gtd'], accounts: [account] });
  try {
    for (let mask = 0; mask < 32; mask += 1) {
      const actual = states.filter((_, index) => mask & (1 << index));
      await React.act(async () => {
        await fetchVisibleGtdMetadata([message], { api: { gtdMetadata: async () => ({ messages: {
          header: { states: [...actual.toReversed(), ...actual, 'unknown', '__proto__', '<img src=x>'], date: '2020-01-01' },
        } }) } });
        render();
      });
      assert.deepEqual(labels(), actual.map(state => `gtd.state.${state}`));
      assert.equal(document.querySelector('img'), null);
      for (const chip of document.querySelectorAll('[role="img"]')) assert.ok(chip.getAttribute('aria-label'));
    }
    const watch = document.querySelector('[aria-label^="gtd.state.watch"]');
    const title = watch.title;
    await React.act(async () => { tickGtdMetadataClock(getGtdMetadataClock() + 86400000); });
    assert.notEqual(watch.title, title, 'the accessible age updates with the shared clock');
    assert.equal(watch.textContent, 'gtd.state.watch', 'age never replaces the visible state');
    await React.act(async () => { useStore.setState({ enabledPlugins: [] }); });
    assert.deepEqual(labels(), []);
    await React.act(async () => { useStore.setState({ enabledPlugins: ['gtd'] }); account = { ...account, gtd_enabled: false }; render(); });
    assert.deepEqual(labels(), []);
    await React.act(async () => { account = { ...account, gtd_enabled: true }; clearGtdMetadata(); render(); });
    assert.equal(document.getElementById('root').innerHTML, '');
  } finally { await React.act(async () => root.unmount()); clearGtdMetadata(); }
});

test('header lifecycle follows classification Undo Done configuration and reconnect with stale-session isolation', async () => {
  await import('./index.jsx');
  const { PluginSlot, PluginRuntime } = await import('../PluginSlot.jsx');
  const { useStore } = await import('../../store/index.js');
  const { api } = await import('../../utils/api.js');
  const { classifyWithUndo } = await import('../../utils/gtdClassification.js');
  const { doneGtdRow } = await import('../../utils/gtdDone.js');
  const { dispatchPluginWsMessage, dispatchPluginReconnect } = await import('../events.js');
  const { invalidateGtdMetadata } = await import('./metadataStore.js');
  const root = createRoot(document.getElementById('root'));
  const row = { id: 'lifecycle', account_id: 'account' };
  let states = ['watch'];
  const previous = api.gtdMetadata;
  api.gtdMetadata = async (_account, ids) => ({ messages: Object.fromEntries(ids.map(id => [id, { states: [...states] }])) });
  useStore.setState({ user: { id: 'lifecycle-user' }, enabledPlugins: ['gtd'],
    accounts: [{ id: 'account', gtd_enabled: true, gtd_folders: { watch: 'Custom/Waiting' } }, { id: 'other', gtd_enabled: true }],
    selectedAccountId: 'other', selectedFolder: 'Sent', searchQuery: '', searchResults: [], messages: [],
    selectedMessageId: row.id, activeGtdTab: 'watch', threadMessages: { parked: [row] },
    messageWindows: [], notifications: [], fetchGtdSections: () => {}, scheduleGtdSectionsFetch: () => {} });
  const render = () => {
    const state = useStore.getState();
    const message = Object.values(state.threadMessages).flat().find(message => message.id === state.selectedMessageId);
    root.render(React.createElement(React.Fragment, null, React.createElement(PluginRuntime),
      React.createElement(PluginSlot, { name: 'message-header-meta', ctx: { message, account: state.accounts.find(account => account.id === message.account_id) } })));
  };
  const labels = () => [...document.querySelectorAll('[role="img"]')].map(chip => chip.textContent);
  try {
    await React.act(async () => { render(); });
    assert.deepEqual(labels(), ['gtd.state.watch']);
    await React.act(async () => { await classifyWithUndo(row.id, 'todo', { store: useStore, message: row, t: key => key,
      api: { gtdClassify: async () => { states.push('todo'); return { applied: true, undoToken: { messageId: row.id } }; },
        gtdUndoClassify: async () => { states = ['watch']; } } }); });
    assert.deepEqual(labels(), ['gtd.state.todo', 'gtd.state.watch']);
    await React.act(async () => { await useStore.getState().notifications.at(-1).onUndo(); });
    assert.deepEqual(labels(), ['gtd.state.watch']);
    await React.act(async () => { await doneGtdRow(row, ['watch'], {
      gtdDone: async () => { states = []; return {}; }, removeGtdThread: () => ({}), restoreGtdThread: () => {},
      addNotification: () => {}, scheduleGtdSectionsFetch: () => {}, t: key => key,
    }); });
    assert.deepEqual(labels(), []);
    await React.act(async () => { states = ['reference']; dispatchPluginWsMessage({ type: 'gtd_sections_updated', accountId: row.account_id }); });
    assert.deepEqual(labels(), ['gtd.state.reference']);
    await React.act(async () => { states = ['someday']; dispatchPluginReconnect(); });
    assert.deepEqual(labels(), ['gtd.state.someday']);
    await React.act(async () => { states = ['delegated']; useStore.setState({ accounts: useStore.getState().accounts.map(account => ({ ...account, gtd_folders: { delegated: 'Custom/Delegated' } })) }); render(); });
    assert.deepEqual(labels(), ['gtd.state.delegated']);
    let finishOld;
    api.gtdMetadata = (account, ids) => account === 'account' ? new Promise(resolve => { finishOld = resolve; })
      : Promise.resolve({ messages: { [ids[0]]: { states: ['reference'] } } });
    await React.act(async () => { invalidateGtdMetadata(); });
    await React.act(async () => { useStore.setState({ user: { id: 'new-session' }, selectedMessageId: 'next', threadMessages: { parked: [{ id: 'next', account_id: 'other' }] } }); render(); });
    await React.act(async () => { finishOld({ messages: { lifecycle: { states: ['todo'] } } }); });
    assert.deepEqual(labels(), ['gtd.state.reference'], 'old session cannot populate the new header');
    await React.act(async () => { useStore.setState({ enabledPlugins: [] }); });
    assert.deepEqual(labels(), []);
  } finally { await React.act(async () => root.unmount()); api.gtdMetadata = previous; clearGtdMetadata(); }
});

test('header runtime lifecycle replay immediately starts the surviving initial generation', async () => {
  const { useStore } = await import('../../store/index.js');
  const { api } = await import('../../utils/api.js');
  const Runtime = (await import('./GtdRuntime.jsx')).default;
  const { getGtdMetadata } = await import('./metadataStore.js');
  const root = createRoot(document.getElementById('root'));
  const requests = [];
  api.gtdMetadata = () => new Promise(resolve => { requests.push(resolve); });
  useStore.setState({ user: { id: 'replay-user' }, enabledPlugins: ['gtd'], accounts: [{ id: 'account', gtd_enabled: true }],
    selectedFolder: 'INBOX', activeGtdTab: null, searchQuery: '', messages: [{ id: 'replay', account_id: 'account' }],
    selectedMessageId: null, messageWindows: [], threadMessages: {}, fetchGtdSections: () => {} });
  try {
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Runtime))));
    assert.equal(requests.length, 2, 'the replayed initial request must not wait for navigation debounce');
    await React.act(async () => { requests[0]({ messages: { replay: { states: ['todo'] } } }); });
    assert.equal(getGtdMetadata('replay'), null, 'abandoned generation cannot commit');
    await React.act(async () => { requests[1]({ messages: { replay: { states: ['watch'] } } }); });
    assert.deepEqual(getGtdMetadata('replay').states, ['watch']);
  } finally { await React.act(async () => root.unmount()); }
});
