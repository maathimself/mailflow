// Render test for the sidebar's folder unread badges (#536).
//
// A collapsed folder showed only its own count, so new mail in its subfolders was invisible
// until it was expanded. The harness mirrors MessageList.render.test.js: node --test cannot
// parse JSX, so the loader hook transforms .jsx with sucrase, and react-i18next is stubbed.

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
        // t() returns the key, with any interpolation values after it so a test can see them.
        'export const useTranslation = () => ({ t: (k, o) => (o && typeof o === "object" && (o.signedInAs || o.email) ? `${k} ${JSON.stringify(o)}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
const { api } = await import('../utils/api.js');
const Sidebar = (await import('./Sidebar.jsx')).default;
const AdminPanel = (await import('./AdminPanel.jsx')).default;

// Connection errors the user can act on (#674): each kind the server records gets its own short
// label in the sidebar, a callout on the account's row, and the right action.
const doc = dom.window.document;
const text = () => doc.getElementById('root').textContent;
const click = (el) => React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const byText = (sel, s) => [...doc.querySelectorAll(sel)].find(el => el.textContent.trim() === s);
const wait = (ms) => React.act(() => new Promise(r => setTimeout(r, ms)));

const account = (code, extra = {}) => ({
  id: 'acct-1', name: 'Maria', email_address: 'maria.lopez@outlook.com', color: '#0078d4', enabled: true,
  include_in_unified_inbox: true, oauth_provider: 'microsoft', imap_host: 'outlook.office365.com', imap_port: 993,
  smtp_host: 'smtp.office365.com', smtp_port: 587,
  sync_error: code ? `raw server text for ${code}` : null, sync_error_code: code, aliases: [], ...extra,
});

let root;
async function render(component, state) {
  if (root) await React.act(async () => root.unmount());
  useStore.setState({ accountsReady: true, folders: {}, expandedAccounts: {}, accountsIntent: null, showAdmin: false, ...state });
  await React.act(async () => {
    root = createRoot(doc.getElementById('root'));
    root.render(React.createElement(component));
  });
  await React.act(async () => {});
}

describe('sidebar: a short label by kind that opens the account row', () => {
  for (const [code, label] of [
    ['ms_imap_disabled_personal', 'accountErrors.label.turnOnImap'],
    // Only the organization's IT can turn it on.
    ['ms_imap_disabled_work', 'accountErrors.label.imapOff'],
    ['oauth_reauth', 'accountErrors.label.signInAgain'],
    ['oauth_app_config', 'accountErrors.label.cantConnect'],
    ['connection', 'accountErrors.label.cantConnect'],
    [null, null],
  ]) {
    test(`${code ?? 'no error'}: ${label ?? 'the address, no label'}`, async () => {
      await render(Sidebar, { accounts: [account(code)] });
      if (!label) {
        assert.ok(text().includes('maria.lopez@outlook.com'));
        assert.ok(!text().includes('accountErrors.label'));
        return;
      }
      const el = byText('button', label);
      assert.ok(el, `label ${label}`);
      await click(el);
      const s = useStore.getState();
      assert.deepEqual(s.accountsIntent, { accountId: 'acct-1', action: 'focus' });
      assert.equal(s.adminTab, 'accounts');
      assert.equal(s.showAdmin, true);
    });
  }

  const menuFor = async (code) => {
    await render(Sidebar, { accounts: [account(code)] });
    // The name inside the account row; the event bubbles to the row's handler.
    const row = byText('div', 'Maria');
    await React.act(async () => { row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
  };

  test('the account menu offers Sign in again for an expired sign-in', async () => {
    await menuFor('oauth_reauth');
    assert.ok(text().includes('sidebar.accountMenu.signInAgain'));
    assert.ok(!text().includes('sidebar.accountMenu.tryAgain'));
    await click(byText('button, div', 'sidebar.accountMenu.signInAgain'));
    assert.deepEqual(useStore.getState().accountsIntent, { accountId: 'acct-1', action: 'signIn' });
  });

  test('and Try again otherwise, which reconnects', async () => {
    let reconnected = null;
    api.reconnectAccount = async (id) => { reconnected = id; return { ok: true }; };
    await menuFor('ms_imap_disabled_personal');
    assert.ok(!text().includes('sidebar.accountMenu.signInAgain'));
    await click(byText('button, div', 'sidebar.accountMenu.tryAgain'));
    assert.equal(reconnected, 'acct-1');
  });
});

describe('Settings > Accounts: the callout on the account row', () => {
  let reconnected;
  let deviceStarts;
  let pollResult;
  const openAccounts = async (acct, { isAdmin = false, intent = null } = {}) => {
    reconnected = [];
    deviceStarts = [];
    api.reconnectAccount = async (id) => { reconnected.push(id); return { ok: true }; };
    api.admin.getSettings = async () => ({ settings: {} });
    api.getUnreadCounts = async () => ({});
    api.getAccounts = async () => [acct];
    api.getIntegrationsStatus = async () => ({ microsoft: {}, google: {} });
    api.startMsDeviceFlow = async (accountId) => { deviceStarts.push(accountId); return { userCode: 'K7QWZP2M', verificationUri: 'https://microsoft.com/devicelogin', interval: 0.02 }; };
    api.pollMsDeviceFlow = async () => pollResult;
    await render(AdminPanel, { user: { id: 'u1', isAdmin }, accounts: [acct], adminTab: 'accounts', accountsIntent: intent });
  };
  const callout = () => doc.querySelector('[data-error-kind]');
  const buttons = () => [...callout().querySelectorAll('button, a')].map(b => b.textContent.trim());

  test('Outlook.com with IMAP off: the steps, Open Outlook.com and Try again, and the raw text under Details', async () => {
    await openAccounts(account('ms_imap_disabled_personal'));
    assert.equal(callout().dataset.errorKind, 'imapOffPersonal');
    for (const key of ['title', 'body', 'step1', 'step2', 'step3', 'outro']) assert.ok(callout().textContent.includes(`accountErrors.imapOffPersonal.${key}`), key);
    assert.deepEqual(buttons(), ['accountErrors.action.openOutlook', 'accountErrors.action.retry']);
    assert.equal(callout().querySelector('a').getAttribute('href'), 'https://outlook.live.com/mail/');
    const details = callout().querySelector('details');
    assert.equal(details.querySelector('summary').textContent, 'accountErrors.details');
    assert.ok(details.textContent.includes('raw server text for ms_imap_disabled_personal'));
    // The row says what kind of problem it is rather than a truncated server sentence.
    assert.ok(text().includes('accountErrors.label.turnOnImap'));
    await click(byText('button', 'accountErrors.action.retry'));
    assert.deepEqual(reconnected, ['acct-1']);
    assert.equal(callout(), null, 'cleared while the retry runs');
  });

  test('a work mailbox with IMAP off names the mailbox and offers only Try again', async () => {
    await openAccounts(account('ms_imap_disabled_work', { email_address: 'maria@contoso.example' }));
    assert.ok(callout().textContent.includes('accountErrors.imapOffWork.body {"email":"maria@contoso.example"}'));
    assert.deepEqual(buttons(), ['accountErrors.action.retry']);
  });

  test('an expired sign-in signs in again for this account, and a different address is refused, not added', async () => {
    pollResult = { status: 'wrong_account', signedInAs: 'other@hotmail.com', expected: 'maria.lopez@outlook.com' };
    await openAccounts(account('oauth_reauth'));
    assert.deepEqual(buttons(), ['accountErrors.action.signIn']);
    await click(byText('button', 'accountErrors.action.signIn'));
    assert.deepEqual(deviceStarts, ['acct-1']);
    assert.ok(text().includes('K7QWZP2M'));
    await wait(80);
    assert.ok(text().includes('accountErrors.wrongAccount {"signedInAs":"other@hotmail.com","expected":"maria.lopez@outlook.com"}'));
  });

  test('a successful repair reloads the accounts', async () => {
    pollResult = { status: 'success', accountId: 'acct-1', email: 'maria.lopez@outlook.com', connection: 'connected' };
    let reloaded = 0;
    await openAccounts(account('oauth_reauth'));
    api.getAccounts = async () => { reloaded++; return [account(null)]; };
    await click(byText('button', 'accountErrors.action.signIn'));
    await wait(80);
    assert.ok(text().includes('msSignIn.connected {"email":"maria.lopez@outlook.com"}'));
    assert.equal(reloaded, 1);
  });

  test('the dialog takes focus, closes on Escape, and gives focus back', async () => {
    pollResult = { status: 'pending' };
    await openAccounts(account('oauth_reauth'));
    const opener = byText('button', 'accountErrors.action.signIn');
    opener.focus();
    await click(opener);
    const dialog = doc.querySelector('[role="dialog"]');
    assert.ok(dialog.contains(doc.activeElement), 'focus moved into the dialog');
    await React.act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(doc.querySelector('[role="dialog"]'), null);
    assert.equal(doc.activeElement, opener);
  });

  test('a Microsoft account connected on Microsoft\'s page signs in again there, not with a code', async () => {
    api.getIntegrationsStatus = async () => ({ microsoft: { workRedirect: true }, google: {} });
    await openAccounts(account('oauth_reauth', { oauth_public_client: false }));
    api.getIntegrationsStatus = async () => ({ microsoft: { workRedirect: true }, google: {} });
    await click(byText('button', 'accountErrors.action.signIn'));
    await React.act(async () => {});
    assert.ok(byText('button', 'msSignIn.continueMicrosoft'));
    assert.deepEqual(deviceStarts, []);
  });

  test('without Microsoft\'s page set up, such an account falls back to the code', async () => {
    pollResult = { status: 'pending' };
    await openAccounts(account('oauth_reauth', { oauth_public_client: false }));
    api.getIntegrationsStatus = async () => ({ microsoft: { workRedirect: false }, google: {} });
    await click(byText('button', 'accountErrors.action.signIn'));
    await React.act(async () => {});
    assert.deepEqual(deviceStarts, ['acct-1']);
  });

  test('the sidebar\'s Sign in again opens the dialog straight away', async () => {
    pollResult = { status: 'pending' };
    await openAccounts(account('oauth_reauth'), { intent: { accountId: 'acct-1', action: 'signIn' } });
    assert.deepEqual(deviceStarts, ['acct-1']);
    assert.equal(useStore.getState().accountsIntent, null, 'the intent is consumed');
  });

  test('an app problem: admins get Open Integrations, everyone else is told to ask', async () => {
    await openAccounts(account('oauth_app_config'));
    assert.ok(callout().textContent.includes('accountErrors.appConfig.bodyUser'));
    // Everyone can retry once the app is fixed; only admins get the settings link.
    assert.deepEqual(buttons(), ['accountErrors.action.retry']);
    await openAccounts(account('oauth_app_config'), { isAdmin: true });
    assert.ok(callout().textContent.includes('accountErrors.appConfig.bodyAdmin'));
    assert.deepEqual(buttons(), ['accountErrors.action.retry', 'addAccount.openSettings']);
    await click(byText('button', 'addAccount.openSettings'));
    assert.equal(useStore.getState().adminTab, 'mail-signin');
  });

  test('a rejected password offers Edit account and Try again; an uncoded error reads as a connection problem', async () => {
    await openAccounts(account('auth_failed', { oauth_provider: null }));
    assert.deepEqual(buttons(), ['accountErrors.action.edit', 'accountErrors.action.retry']);
    await openAccounts(account(null, { sync_error: 'read ETIMEDOUT' }));
    assert.equal(callout().dataset.errorKind, 'connection');
    assert.deepEqual(buttons(), ['accountErrors.action.retry']);
  });

  test('no callout on a healthy account', async () => {
    await openAccounts(account(null));
    assert.equal(callout(), null);
  });
});
