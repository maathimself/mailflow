// Render test for connecting personal Microsoft accounts through MailFlow's built-in app (#674):
// what Settings > Integrations > Microsoft 365 offers in each state the server reports, the
// admin's switch for the shared app, and the add-account note for Outlook.com addresses.
//
// Same loader hooks as ProfileModal.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed so t() returns its key.

import { test, describe, beforeEach, afterEach } from 'node:test';
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

const PREFIX = 'admin.integrations.microsoft.';
// Status as GET /api/integrations/status reports it for each state.
const BUILTIN = { configured: false, builtinApp: true, builtinAppShipped: true, personalAccounts: true };
const PLACEHOLDER = { configured: false, builtinApp: false, builtinAppShipped: false, personalAccounts: false };
const OPTED_OUT = { configured: false, builtinApp: false, builtinAppShipped: true, personalAccounts: false };
const OWN_APP = { configured: true, builtinApp: true, builtinAppShipped: true, personalAccounts: true };

const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const text = () => document.getElementById('root').textContent;
const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const deviceButton = () => button(PREFIX + 'deviceCodeStart');
let root;
let saved;
let switched;
let deviceStarts;
afterEach(() => React.act(async () => root.unmount()));

beforeEach(() => {
  saved = [];
  switched = [];
  deviceStarts = 0;
  api.setMsBuiltinApp = async (enabled) => { switched.push(enabled); return { ok: true }; };
  api.todoist.status = async () => ({ connected: false });
  api.getIntegrations = async () => ({});
  api.saveIntegration = async (provider, config) => { saved.push([provider, config]); return { ok: true }; };
  api.startMsDeviceFlow = async () => { deviceStarts++; return { userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', interval: 3600 }; };
  api.pollMsDeviceFlow = async () => ({ status: 'pending' });
});

async function openIntegrations({ isAdmin, status }) {
  api.getIntegrationsStatus = async () => ({ microsoft: status, google: { configured: false } });
  useStore.setState({ user: { id: 'u1', isAdmin }, accounts: [], adminTab: 'integrations' });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(AdminPanel)); });
  await React.act(async () => {});
  // The card opens by itself when Microsoft sign-in is available; otherwise open it.
  if (!deviceButton()) {
    await click([...document.querySelectorAll('div')].find(d => d.style.cursor === 'pointer' && d.textContent.startsWith(PREFIX + 'title')));
  }
}

describe('Integrations > Microsoft 365 with the built-in app', () => {
  test('a non-admin can connect a personal account with no configuration', async () => {
    await openIntegrations({ isAdmin: false, status: BUILTIN });
    for (const key of ['personalReady', 'userNoteBuiltin', 'builtinTitle', 'builtinNote']) assert.ok(text().includes(PREFIX + key), key);
    assert.ok(!text().includes(PREFIX + 'notConfigured'));
    assert.ok(!text().includes(PREFIX + 'deviceCodeNote'), 'no Azure instructions for the shared app');
    assert.equal(deviceButton().disabled, false);
    await click(deviceButton());
    assert.equal(deviceStarts, 1);
    assert.ok(text().includes('ABCD-EFGH'), 'the device code is shown');
    // Work accounts still need the instance's own app.
    assert.equal(button(PREFIX + 'connect').disabled, true);
  });

  test('a build with the placeholder ID behaves as before: nothing to connect until an admin configures it', async () => {
    await openIntegrations({ isAdmin: false, status: PLACEHOLDER });
    assert.ok(text().includes(PREFIX + 'notConfigured'));
    assert.ok(text().includes(PREFIX + 'userNoteNotConfigured'));
    assert.ok(text().includes(PREFIX + 'deviceCodeTitle'));
    assert.ok(!text().includes(PREFIX + 'builtinNote'));
    assert.equal(deviceButton().disabled, true);
  });

  test('when the admin opted out, the shared app is not offered', async () => {
    await openIntegrations({ isAdmin: false, status: OPTED_OUT });
    assert.ok(text().includes(PREFIX + 'userNoteNotConfigured'));
    assert.ok(!text().includes(PREFIX + 'builtinNote'));
    assert.equal(deviceButton().disabled, true);
  });

  test('with the instance\'s own app, the device-code flow uses it as before', async () => {
    await openIntegrations({ isAdmin: false, status: OWN_APP });
    assert.ok(text().includes(PREFIX + 'userNoteConfigured'));
    assert.ok(text().includes(PREFIX + 'deviceCodeNote'));
    assert.ok(!text().includes(PREFIX + 'builtinNote'));
    assert.equal(deviceButton().disabled, false);
    assert.equal(button(PREFIX + 'connect').disabled, false);
  });
});

describe('Integrations > Microsoft 365: the admin\'s switch for the shared app', () => {
  const builtinSwitch = () => document.querySelector(`[role="switch"][aria-label="${PREFIX}builtinToggle"]`);

  test('the admin sees the switch and the work-account setup, and turning it off saves and withdraws the offer', async () => {
    await openIntegrations({ isAdmin: true, status: BUILTIN });
    assert.ok(text().includes(PREFIX + 'setupTitle'), 'own-app setup stays available');
    assert.equal(builtinSwitch().getAttribute('aria-checked'), 'true');
    assert.equal(deviceButton().disabled, false);

    await click(builtinSwitch());
    // A setting of its own: the app config is not rewritten.
    assert.deepEqual(switched, [false]);
    assert.deepEqual(saved, []);
    assert.equal(builtinSwitch().getAttribute('aria-checked'), 'false');
    assert.equal(deviceButton().disabled, true);
    assert.ok(text().includes(PREFIX + 'notConfigured'));
  });

  test('with an own app saved, the switch still changes only its own setting', async () => {
    api.getIntegrations = async () => ({ microsoft: { clientId: 'own-app-id', tenantId: 'common', clientSecret: '••••••••' } });
    await openIntegrations({ isAdmin: true, status: OWN_APP });
    await click(builtinSwitch());
    assert.deepEqual(switched, [false]);
    assert.deepEqual(saved, []);
    // The own app still serves the device-code flow.
    assert.equal(deviceButton().disabled, false);
  });

  test('saving the app form sends only the app config', async () => {
    api.getIntegrations = async () => ({ microsoft: { clientId: 'own-app-id', tenantId: 'common' } });
    await openIntegrations({ isAdmin: true, status: { ...OWN_APP, builtinApp: false } });
    await click(button(PREFIX + 'save'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0][1].clientId, 'own-app-id');
    assert.equal('builtinApp' in saved[0][1], false);
  });

  test('no switch while the build has no built-in app', async () => {
    await openIntegrations({ isAdmin: true, status: PLACEHOLDER });
    assert.equal(builtinSwitch(), null);
  });
});

describe('account form: Outlook.com address (#674)', () => {
  const OUTLOOK = {
    id: 'acct', name: 'Home', email_address: 'me@outlook.com', color: '#6366f1',
    imap_host: 'outlook.office365.com', imap_port: 993, auth_user: 'me@outlook.com',
    smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  };
  async function openEdit(status) {
    api.admin.getSettings = async () => ({ settings: {} });
    api.getUnreadCounts = async () => ({});
    api.getIntegrationsStatus = async () => ({ microsoft: status, google: { configured: false } });
    useStore.setState({ user: { id: 'u1' }, accounts: [OUTLOOK], adminTab: 'accounts' });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(AdminPanel)); });
    await click(document.querySelector('button[title="common.edit"]'));
    await React.act(async () => {});
  }

  test('says it can be connected through Integrations with no setup', async () => {
    await openEdit(BUILTIN);
    assert.ok(text().includes('admin.accounts.microsoftImapNoteReady'));
  });

  test('keeps the configure-it note when no Microsoft sign-in is available', async () => {
    await openEdit(PLACEHOLDER);
    assert.ok(!text().includes('admin.accounts.microsoftImapNoteReady'));
    assert.ok(text().includes('admin.accounts.microsoftImapNote'));
  });

  // Without the built-in app in the build, the note stays as it was before #674 even when the
  // instance's own app can sign personal accounts in.
  test('keeps the configure-it note in a placeholder build with an own app', async () => {
    await openEdit({ ...PLACEHOLDER, configured: true, personalAccounts: true });
    assert.ok(!text().includes('admin.accounts.microsoftImapNoteReady'));
    assert.ok(text().includes('admin.accounts.microsoftImapNote'));
  });
});
