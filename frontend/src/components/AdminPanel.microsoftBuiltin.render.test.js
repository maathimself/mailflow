// Render test for Microsoft sign-in settings and MailFlow's built-in app (#674): what
// Settings > Email providers shows administrators in each state the server reports, the
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
const BUILTIN = { configured: false, builtinApp: true, builtinAppShipped: true, personalAccounts: true, personalVia: 'shared', workAccounts: false, workRedirect: false };
const PLACEHOLDER = { configured: false, builtinApp: false, builtinAppShipped: false, personalAccounts: false, personalVia: null, workAccounts: false, workRedirect: false };
const OWN_COMMON = { configured: true, builtinApp: true, builtinAppShipped: true, personalAccounts: true, personalVia: 'own', workAccounts: true, workRedirect: true };
// An own app limited to work accounts: personal accounts fall back to the shared app.
const OWN_ORGANIZATIONS = { configured: true, builtinApp: true, builtinAppShipped: true, personalAccounts: true, personalVia: 'shared', workAccounts: true, workRedirect: false };

const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const text = () => document.getElementById('root').textContent;
const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
const section = (name) => document.querySelector(`[data-section="${name}"]`);
let root;
let saved;
let switched;
let status;
afterEach(() => React.act(async () => root.unmount()));

beforeEach(() => {
  saved = [];
  switched = [];
  api.setMsBuiltinApp = async (enabled) => { switched.push(enabled); status = { ...status, builtinApp: enabled, personalVia: enabled ? status.personalVia || 'shared' : (status.personalVia === 'own' ? 'own' : null) }; return { ok: true }; };
  api.todoist.status = async () => ({ connected: false });
  api.getIntegrations = async () => ({});
  api.saveIntegration = async (provider, config) => { saved.push([provider, config]); return { ok: true }; };
  api.getIntegrationsStatus = async () => ({ microsoft: status, google: { configured: false } });
});

async function openTab(tab, { isAdmin, microsoft = BUILTIN }) {
  status = microsoft;
  useStore.setState({ user: { id: 'u1', isAdmin }, accounts: [], adminTab: tab });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(AdminPanel)); });
  await React.act(async () => {});
}

// Settings > Email providers (#674): app configuration for administrators only. Users add their
// accounts under Add account; Integrations keeps the apps (Todoist, CardDAV) for everyone.
describe('who sees what', () => {
  test('a non-admin has no Email providers section, and Integrations shows no mail sign-in', async () => {
    await openTab('integrations', { isAdmin: false });
    assert.ok(!text().includes('admin.tabs.mailSignIn'));
    assert.ok(!text().includes(PREFIX + 'setupTitle'));
    assert.ok(!text().includes('mailSignIn.'));
    assert.ok(text().includes('admin.integrations.todoist.title'));
  });

  test('even asked for directly, Email providers renders nothing for a non-admin', async () => {
    await openTab('mail-signin', { isAdmin: false });
    assert.ok(!text().includes('mailSignIn.title'));
  });

  test('an admin finds it in the Administration group and through search', async () => {
    await openTab('accounts', { isAdmin: true });
    assert.ok(button('admin.tabs.mailSignIn') || text().includes('admin.tabs.mailSignIn'));
    const search = document.querySelector('input[placeholder="admin.search.placeholder"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => { setter.call(search, 'entra'); search.dispatchEvent(new window.Event('input', { bubbles: true })); });
    assert.ok(text().includes('mailSignIn.ms.title'));
  });

  test('search does not offer it to a non-admin', async () => {
    await openTab('accounts', { isAdmin: false });
    const search = document.querySelector('input[placeholder="admin.search.placeholder"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => { setter.call(search, 'entra'); search.dispatchEvent(new window.Event('input', { bubbles: true })); });
    assert.ok(!text().includes('mailSignIn.ms.title'));
  });
});

describe('Email providers > Microsoft', () => {
  test('shared app only: personal accounts use it, work accounts are not set up, no connect buttons', async () => {
    await openTab('mail-signin', { isAdmin: true, microsoft: BUILTIN });
    assert.ok(section('personal').textContent.includes('mailSignIn.ms.statusShared'));
    assert.ok(section('work').textContent.includes('mailSignIn.ms.workOff'));
    assert.ok(!text().includes('admin.integrations.microsoft.connect'));
    assert.ok(!text().includes('deviceCode'));
    // The own-app setup is collapsed until asked for.
    assert.ok(!text().includes(PREFIX + 'setupTitle'));
  });

  test('turning the shared app off saves only that setting and shows personal sign-in as off', async () => {
    await openTab('mail-signin', { isAdmin: true, microsoft: BUILTIN });
    const toggle = document.querySelector('[role="switch"][aria-label="mailSignIn.ms.sharedSwitch"]');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    await click(toggle);
    assert.deepEqual(switched, [false]);
    assert.deepEqual(saved, []);
    assert.ok(section('personal').textContent.includes('mailSignIn.ms.statusOff'));
  });

  test('an own app on common handles personal accounts, and says the shared app is not used', async () => {
    await openTab('mail-signin', { isAdmin: true, microsoft: OWN_COMMON });
    assert.ok(section('personal').textContent.includes('mailSignIn.ms.statusOwn'));
    assert.ok(section('personal').textContent.includes('mailSignIn.ms.ownHandlesPersonal'));
    assert.ok(section('work').textContent.includes('mailSignIn.ms.statusOwn'));
  });

  test('an own app on organizations leaves personal accounts to the shared app', async () => {
    await openTab('mail-signin', { isAdmin: true, microsoft: OWN_ORGANIZATIONS });
    assert.ok(section('personal').textContent.includes('mailSignIn.ms.statusShared'));
    assert.ok(!section('personal').textContent.includes('mailSignIn.ms.ownHandlesPersonal'));
  });

  test('no switch while the build has no built-in app', async () => {
    await openTab('mail-signin', { isAdmin: true, microsoft: PLACEHOLDER });
    assert.equal(document.querySelector('[role="switch"][aria-label="mailSignIn.ms.sharedSwitch"]'), null);
  });

  test('the setup opens with plain labels, the suggested redirect URI as the example, and saves only the app config', async () => {
    api.getIntegrations = async () => ({ microsoft: { clientId: 'own-app-id', tenantId: 'organizations' } });
    await openTab('mail-signin', { isAdmin: true, microsoft: OWN_ORGANIZATIONS });
    await click(button('mailSignIn.ms.setupToggle'));
    assert.ok(text().includes(PREFIX + 'setupTitle'));
    const redirect = [...document.querySelectorAll('input')].find(i => i.placeholder.endsWith('/oauth/microsoft/callback'));
    assert.equal(redirect.placeholder, 'https://mail.example.invalid/oauth/microsoft/callback');
    assert.ok(text().includes(PREFIX + 'redirectUriNote'));
    await click(button(PREFIX + 'save'));
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], ['microsoft', { clientId: 'own-app-id', clientSecret: '', tenantId: 'organizations', redirectUri: '' }]);
  });
});

describe('Email providers > Google', () => {
  test('configuration only, collapsed until asked for', async () => {
    await openTab('mail-signin', { isAdmin: true });
    assert.ok(text().includes('admin.integrations.google.title'));
    assert.ok(!text().includes('admin.integrations.google.setupTitle'));
    await click(button('mailSignIn.google.setupToggle'));
    assert.ok(text().includes('admin.integrations.google.setupTitle'));
    assert.ok(!text().includes('admin.integrations.google.connect'));
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

// An account connected through a sign-in (#674): the Edit form shows who it is signed in as and
// "Sign in again", never the server, login and password fields or the OAuth2 banner, and
// saving it sends none of those.
describe('Edit form for an account connected through a sign-in', () => {
  const ACCOUNT = (provider) => ({
    id: 'acct', name: 'Maria', email_address: provider === 'google' ? 'maria@gmail.com' : 'maria.lopez@outlook.com', color: '#0078d4',
    imap_host: provider === 'google' ? 'imap.gmail.com' : 'outlook.office365.com', imap_port: 993, auth_user: 'maria',
    smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS', oauth_provider: provider, oauth_public_client: true,
  });
  let updates;
  let deviceStarts;
  async function openEdit(account) {
    updates = null;
    deviceStarts = 0;
    api.admin.getSettings = async () => ({ settings: {} });
    api.getUnreadCounts = async () => ({});
    api.getIntegrationsStatus = async () => ({ microsoft: BUILTIN, google: { configured: false } });
    api.updateAccount = async (_id, body) => { updates = body; return { ...account, ...body }; };
    api.startMsDeviceFlow = async () => { deviceStarts++; return { userCode: 'K7QWZP2M', verificationUri: 'https://microsoft.com/devicelogin', interval: 3600 }; };
    api.pollMsDeviceFlow = async () => ({ status: 'pending' });
    useStore.setState({ user: { id: 'u1' }, accounts: [account], adminTab: 'accounts' });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(AdminPanel)); });
    await click(document.querySelector('button[title="common.edit"]'));
    await React.act(async () => {});
  }

  for (const provider of ['microsoft', 'google']) {
    test(`${provider}: signed-in block, no server or credential fields, no banner`, async () => {
      await openEdit(ACCOUNT(provider));
      const block = document.querySelector('[data-signed-in-with]');
      assert.equal(block.dataset.signedInWith, provider);
      assert.ok(block.textContent.includes(provider === 'google' ? 'accountForm.signedInGoogle' : 'accountForm.signedInMicrosoft'));
      for (const label of ['admin.accounts.imapHost', 'admin.accounts.authUser', 'admin.accounts.smtpHost', 'admin.accounts.smtpAuthUser']) {
        assert.ok(!text().includes(label), label);
      }
      assert.equal(document.querySelector('input[type="password"]'), null);
      assert.ok(!text().includes('admin.accounts.microsoftImapUnsupported'));
      // Non-credential settings stay.
      assert.ok(text().includes('admin.accounts.displayName'));
      assert.ok(text().includes('admin.accounts.signatureSection'));
    });
  }

  test('saving sends no server, login or password fields', async () => {
    await openEdit(ACCOUNT('microsoft'));
    await click(button('admin.accounts.saveChanges'));
    assert.ok(updates, 'saved');
    for (const field of ['imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls', 'auth_pass', 'smtp_auth_user', 'smtp_auth_pass']) {
      assert.equal(field in updates, false, field);
    }
    assert.equal(updates.name, 'Maria');
    // Unchanged, the mailbox to open is not sent: a cosmetic save must not reconnect.
    assert.equal('auth_user' in updates, false);
  });

  test('a Google account has no mailbox to open', async () => {
    await openEdit(ACCOUNT('google'));
    assert.ok(!text().includes('accountForm.mailboxLabel'));
    await click(button('admin.accounts.saveChanges'));
    assert.equal('auth_user' in updates, false);
  });

  test('emptying a mailbox that is already the own address sends nothing', async () => {
    await openEdit({ ...ACCOUNT('microsoft'), auth_user: 'maria.lopez@outlook.com' });
    const input = [...document.querySelectorAll('input')].find(i => i.value === 'maria.lopez@outlook.com' && i.placeholder);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => { setter.call(input, ''); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await click(button('admin.accounts.saveChanges'));
    assert.equal('auth_user' in updates, false);
  });

  test('the mailbox to open can be changed, for a shared or delegated mailbox', async () => {
    await openEdit(ACCOUNT('microsoft'));
    assert.ok(text().includes('accountForm.mailboxLabel'));
    assert.ok(text().includes('accountForm.mailboxHelp'));
    const input = [...document.querySelectorAll('input')].find(i => i.value === 'maria');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => { setter.call(input, 'shared@contoso.example'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await click(button('admin.accounts.saveChanges'));
    assert.equal(updates.auth_user, 'shared@contoso.example');
    await React.act(async () => root.unmount());
    // Emptied, it goes back to the account's own address.
    await openEdit(ACCOUNT('microsoft'));
    const again = [...document.querySelectorAll('input')].find(i => i.value === 'maria');
    await React.act(async () => { setter.call(again, ''); again.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await click(button('admin.accounts.saveChanges'));
    assert.equal(updates.auth_user, 'maria.lopez@outlook.com');
  });

  test('saves even when the hidden login and server are empty on the stored account', async () => {
    await openEdit({ ...ACCOUNT('google'), auth_user: '', imap_host: '' });
    await click(button('admin.accounts.saveChanges'));
    assert.ok(updates, 'saved, not stopped by a required field the form does not show');
    assert.ok(!text().includes('admin.accounts.errorRequired'));
  });

  test('Sign in again opens the sign-in for this account', async () => {
    await openEdit(ACCOUNT('microsoft'));
    await click(button('accountErrors.action.signIn'));
    await React.act(async () => {});
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(deviceStarts, 1);
  });

  test('a password account keeps its server and login fields', async () => {
    await openEdit({ ...ACCOUNT('microsoft'), oauth_provider: null, imap_host: 'imap.example.com', email_address: 'maria@example.com' });
    assert.equal(document.querySelector('[data-signed-in-with]'), null);
    assert.ok(text().includes('admin.accounts.imapHost'));
    assert.ok(text().includes('admin.accounts.authUser'));
  });
});

