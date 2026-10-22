// Render test for the admin's AI access controls (#644): the per-user AI switch in the Users list,
// and "Allow AI for new users" in the AI settings. The server enforces both; what only a render
// shows is that each control sends the change and reflects it.
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

const ADMIN = { id: 'u-admin', username: 'admin', isAdmin: true, aiEnabled: true, created_at: '2026-01-01T00:00:00Z' };
const MARIA = { id: 'u-maria', username: 'maria', isAdmin: false, aiEnabled: false, created_at: '2026-02-01T00:00:00Z' };

const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
let root;
afterEach(() => React.act(async () => root.unmount()));

async function open(tab) {
  useStore.setState({ user: { id: ADMIN.id, isAdmin: true }, accounts: [], adminTab: tab });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(AdminPanel)); });
  await React.act(async () => {});
}

describe('Users: per-user AI switch', () => {
  const updates = [];
  let failWith = null;
  before(() => {
    api.admin.getSettings = async () => ({ settings: { registration_open: 'false' } });
    api.admin.getInvites = async () => ({ invites: [], total: 0 });
    api.admin.getUsers = async () => ({ users: [ADMIN, MARIA], total: 2 });
    api.admin.updateUser = async (id, data) => {
      updates.push([id, data]);
      if (failWith) throw new Error(failWith);
      return { ok: true };
    };
  });

  test('shows each user\'s AI access, the admin included', async () => {
    await open('users');
    const switches = [...document.querySelectorAll('[role="switch"]')];
    assert.equal(switches.length, 2, 'one switch per user, the signed-in admin included');
    assert.deepEqual(switches.map(s => s.getAttribute('aria-checked')), ['true', 'false']);
    assert.deepEqual(switches.map(s => s.textContent), ['admin.users.aiOn', 'admin.users.aiOff']);
    assert.equal(switches[0].title, 'admin.users.aiOnHint');
    assert.equal(switches[1].title, 'admin.users.aiOffHint');
  });

  test('turning it on or off sends aiEnabled and shows the new state', async () => {
    updates.length = 0;
    await open('users');
    const [adminSwitch, mariaSwitch] = document.querySelectorAll('[role="switch"]');
    await click(mariaSwitch);
    await click(adminSwitch);
    assert.deepEqual(updates, [[MARIA.id, { aiEnabled: true }], [ADMIN.id, { aiEnabled: false }]]);
    const after = [...document.querySelectorAll('[role="switch"]')];
    assert.deepEqual(after.map(s => s.getAttribute('aria-checked')), ['false', 'true']);
  });

  test('a failed change says so and leaves the switch as it was', async () => {
    const notices = [];
    useStore.setState({ addNotification: n => notices.push(n) });
    failWith = 'Admin access required';
    try {
      await open('users');
      const mariaSwitch = document.querySelectorAll('[role="switch"]')[1];
      await click(mariaSwitch);
      assert.equal(document.querySelectorAll('[role="switch"]')[1].getAttribute('aria-checked'), 'false');
      assert.deepEqual(notices, [{ type: 'error', title: 'admin.users.aiToggleFailed', body: 'Admin access required' }]);
    } finally { failWith = null; }
  });
});

describe('AI settings: Allow AI for new users', () => {
  const saved = [];
  const CONFIG = {
    enabled: true, provider: 'api-key',
    apiKeyConfig: { baseUrl: 'https://api.example.invalid/v1', apiKey: '', model: 'm' },
    chatgptConfig: { model: 'gpt-5.6-luna' },
    features: { compose: true, summarize: true },
  };
  let config;
  let newUsersEnabled;
  before(() => {
    api.ai.getConfig = async () => ({ config, newUsersEnabled });
    api.ai.saveConfig = async (payload) => { saved.push(payload); return { ok: true, config: payload }; };
    api.ai.codex.status = async () => ({ connected: false, state: 'disconnected', reconnectRequired: false });
  });

  const label = () => {
    const el = [...document.querySelectorAll('label')].find(l => l.textContent === 'admin.ai.newUsersEnabled');
    assert.ok(el, 'the AI settings have the new-users toggle');
    return el;
  };
  const toggle = () => {
    const el = label().querySelector('[role="switch"]');
    assert.ok(el, 'the toggle is a switch');
    return el;
  };
  const isOn = (el) => el.getAttribute('aria-checked') === 'true';
  const save = () => React.act(async () => {
    document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });

  test('is on until turned off, and Save keeps it on', async () => {
    saved.length = 0;
    config = CONFIG;
    newUsersEnabled = true;
    await open('ai');
    assert.equal(isOn(toggle()), true);
    assert.match(document.body.textContent, /admin\.ai\.newUsersEnabledHint/);
    await save();
    assert.equal(saved.at(-1).newUsersEnabled, true);
  });

  test('turning it off is saved, and a saved off shows as off', async () => {
    saved.length = 0;
    config = CONFIG;
    newUsersEnabled = true;
    await open('ai');
    await click(toggle());
    assert.equal(isOn(toggle()), false);
    await save();
    assert.equal(saved.at(-1).newUsersEnabled, false);
    await React.act(async () => root.unmount());

    // Stored apart from the provider configuration, which does not carry it.
    newUsersEnabled = false;
    await open('ai');
    assert.equal(isOn(toggle()), false);
  });

  test('clicking its label text toggles it too', async () => {
    config = CONFIG;
    newUsersEnabled = true;
    await open('ai');
    await click(label().querySelector('span:last-child'));
    assert.equal(isOn(toggle()), false);
  });
});
