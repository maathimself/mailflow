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
const AdminPanel = (await import('./AdminPanel.jsx')).default;
const MessageList = (await import('./MessageList.jsx')).default;

// Add account (#674): the chooser, address detection, and "Sign in with Microsoft" inline,
// reporting "connected" only once the server says the mailbox accepted the login.
const doc = dom.window.document;
const text = () => doc.getElementById('root').textContent;
const act = (fn) => React.act(fn);
const click = (el) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const byText = (sel, s) => [...doc.querySelectorAll(sel)].find(el => el.textContent.trim() === s);
const wait = (ms) => act(() => new Promise(r => setTimeout(r, ms)));
// Wait until a condition holds (bounded), rather than a fixed time a busy machine may overrun.
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
};
const setValue = (input, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
const submit = (form) => act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
const tile = (id) => doc.querySelector(`[data-tile="${id}"] button`);
const isOff = (id) => tile(id).getAttribute('aria-disabled') === 'true';
const state = () => doc.querySelector('[data-sign-in-state]')?.dataset.signInState;

const CONFIGS = {
  builtin: { configured: false, builtinApp: true, builtinAppShipped: true, personalAccounts: true, personalVia: 'shared', workAccounts: false, workRedirect: false },
  ownCommon: { configured: true, builtinApp: true, builtinAppShipped: true, personalAccounts: true, personalVia: 'own', workAccounts: true, workRedirect: true, personalRedirect: true },
  // An own app on common without a secret: personal accounts use its device code.
  ownCommonNoSecret: { configured: true, builtinApp: true, builtinAppShipped: true, personalAccounts: true, personalVia: 'own', workAccounts: true, workRedirect: false, personalRedirect: false },
  // An own app limited to work accounts, with the shared app on: personal accounts fall back to it.
  ownOrganizations: { configured: true, builtinApp: true, builtinAppShipped: true, personalAccounts: true, personalVia: 'shared', workAccounts: true, workRedirect: false },
  ownOrganizationsSharedOff: { configured: true, builtinApp: false, builtinAppShipped: true, personalAccounts: false, personalVia: null, workAccounts: true, workRedirect: false },
  off: { configured: false, builtinApp: false, builtinAppShipped: true, personalAccounts: false, personalVia: null, workAccounts: false, workRedirect: false },
};

let root;
let polls;
let deviceStarts;
let reconnects;
let reloaded;
async function openAdd(config, { isAdmin = false, accounts = [], intent = { action: 'add' }, google = { configured: false, signIn: false } } = {}) {
  if (root) await act(async () => root.unmount());
  polls = [];
  deviceStarts = 0;
  reconnects = [];
  reloaded = 0;
  api.getIntegrationsStatus = async () => ({ microsoft: CONFIGS[config], google });
  api.admin.getSettings = async () => ({ settings: {} });
  api.getUnreadCounts = async () => ({});
  api.getAccounts = async () => { reloaded++; return accounts; };
  api.startMsDeviceFlow = async () => { deviceStarts++; return { userCode: 'K7QWZP2M', verificationUri: 'https://microsoft.com/devicelogin', interval: 0.01 }; };
  api.pollMsDeviceFlow = async () => polls.shift() || { status: 'pending' };
  api.reconnectAccount = async (id, opts) => { reconnects.push([id, opts]); return { ok: true, connection: 'connected' }; };
  useStore.setState({ user: { id: 'u1', isAdmin }, accounts, adminTab: 'accounts', accountsIntent: intent, showAdmin: true });
  await act(async () => {
    root = createRoot(doc.getElementById('root'));
    root.render(React.createElement(AdminPanel));
  });
  await act(async () => {});
}
const typeAndContinue = async (email) => {
  await setValue(doc.getElementById('add-account-email'), email);
  await submit(doc.getElementById('add-account-email').closest('form'));
  await act(async () => {});
};

describe('the chooser, per instance configuration', () => {
  for (const [config, personal, work] of [
    ['builtin', true, false], ['ownCommon', true, true], ['ownOrganizations', true, true],
    ['ownOrganizationsSharedOff', false, true], ['off', false, false],
  ]) {
    test(`${config}: Outlook.com ${personal ? 'on' : 'off'}, Microsoft 365 ${work ? 'on' : 'off'}`, async () => {
      await openAdd(config);
      assert.ok(text().includes('addAccount.title'));
      assert.equal(isOff('microsoftPersonal'), !personal);
      assert.equal(isOff('microsoftWork'), !work);
      assert.equal(text().includes('addAccount.personalOff'), !personal);
      assert.equal(text().includes('addAccount.workOff'), !work);
      for (const id of ['gmail', 'yahoo', 'icloud', 'other']) assert.equal(isOff(id), false, id);
      // A tile that is off still takes focus, and says why to assistive technology.
      assert.equal(tile('microsoftWork').disabled, false);
      assert.equal(doc.getElementById(tile('microsoftWork').getAttribute('aria-describedby'))?.textContent, work ? 'addAccount.tile.workSub' : 'addAccount.workOff');
      // No settings link for someone who cannot change them.
      assert.ok(!text().includes('addAccount.openSettings'));
    });
  }

  test('an admin gets a link to the setting from a tile that is off', async () => {
    await openAdd('off', { isAdmin: true });
    await click(byText('button', 'addAccount.openSettings'));
    assert.equal(useStore.getState().adminTab, 'mail-signin');
  });
});

describe('address detection on Continue', () => {
  test('an @outlook.com address goes straight to Sign in with Microsoft', async () => {
    await openAdd('builtin');
    await typeAndContinue('maria.lopez@outlook.com');
    assert.ok(text().includes('msSignIn.titlePersonal'));
    assert.ok(text().includes('msSignIn.beforeTitle'));
    for (const key of ['step1', 'step2', 'step3']) assert.ok(text().includes(`accountErrors.imapOffPersonal.${key}`));
    assert.ok(text().includes('msSignIn.finePrintShared'), 'the shared app notice');
    assert.equal(deviceStarts, 1);
  });

  test('with an own app, the fine print does not mention the shared app', async () => {
    await openAdd('ownCommon');
    await click(tile('microsoftPersonal'));
    assert.ok(text().includes('msSignIn.finePrintOwn'));
  });

  test('an @outlook.com address with Outlook.com sign-in off says so and stays', async () => {
    await openAdd('off');
    await typeAndContinue('maria@hotmail.com');
    assert.ok(doc.querySelector('[role="alert"]').textContent.includes('addAccount.personalOff'));
    assert.equal(deviceStarts, 0);
  });

  test('a Gmail address opens the form with the Gmail preset and the address filled in', async () => {
    await openAdd('builtin');
    await typeAndContinue('maria@gmail.com');
    assert.equal(doc.querySelector('input[placeholder="admin.accounts.emailPh"]').value, 'maria@gmail.com');
    assert.equal(doc.querySelector('input[placeholder="admin.accounts.imapHostPh"]').value, 'imap.gmail.com');
  });

  test('any other address opens the IMAP form with the address and no server', async () => {
    await openAdd('builtin');
    await typeAndContinue('maria@contoso.example');
    assert.equal(doc.querySelector('input[placeholder="admin.accounts.emailPh"]').value, 'maria@contoso.example');
    assert.equal(doc.querySelector('input[placeholder="admin.accounts.imapHostPh"]').value, '');
  });

  test('the login follows a corrected address until it is edited itself', async () => {
    await openAdd('builtin');
    await typeAndContinue('maria@contoso.example');
    const email = doc.querySelector('input[placeholder="admin.accounts.emailPh"]');
    const login = doc.querySelector('input[placeholder="admin.accounts.authUserPh"]');
    assert.equal(login.value, 'maria@contoso.example');
    await setValue(email, 'maria.lopez@contoso.example');
    assert.equal(login.value, 'maria.lopez@contoso.example');
    await setValue(login, 'mlopez');
    await setValue(email, 'm.lopez@contoso.example');
    assert.equal(login.value, 'mlopez');
  });

  test('something that is not an address is pointed out', async () => {
    await openAdd('builtin');
    await typeAndContinue('maria');
    assert.ok(text().includes('addAccount.invalidEmail'));
  });

  test('typing an Outlook host in the form offers Sign in with Microsoft instead of a dead end', async () => {
    await openAdd('builtin');
    await click(tile('other'));
    await setValue(doc.querySelector('input[placeholder="admin.accounts.imapHostPh"]'), 'outlook.office365.com');
    await act(async () => {});
    assert.ok(text().includes('admin.accounts.microsoftImapNoteSignIn'));
    await click(byText('button', 'msSignIn.titlePersonal'));
    assert.ok(text().includes('msSignIn.beforeTitle'));
    assert.equal(deviceStarts, 1);
  });
});

describe('Sign in with Microsoft, inline', () => {
  const start = async (answers) => {
    await openAdd('builtin');
    polls.push(...answers);
    await click(tile('microsoftPersonal'));
  };

  test('waiting: the two steps, the code, Copy code and Cancel', async () => {
    await start([]);
    await wait(20);
    assert.equal(state(), 'pending');
    assert.equal(doc.querySelector('[data-device-code]').textContent, 'K7QWZP2M');
    assert.equal(byText('a', 'msSignIn.step1Button').getAttribute('href'), 'https://microsoft.com/devicelogin');
    assert.ok(byText('button', 'msSignIn.copy'));
    await click(byText('button', 'common.cancel'));
    assert.ok(text().includes('addAccount.title'), 'back to the chooser');
  });

  test('checking, then connected; Done returns to the account list', async () => {
    let releaseCheck;
    const checked = new Promise(r => { releaseCheck = r; });
    api.pollMsDeviceFlow = async () => polls.shift() || { status: 'pending' };
    await start([{ status: 'checking', accountId: 'n1', email: 'maria.lopez@outlook.com' }]);
    // The second poll is held by the server while it waits for the mailbox.
    api.pollMsDeviceFlow = async () => {
      if (polls.length) return polls.shift();
      await checked;
      return { status: 'success', accountId: 'n1', email: 'maria.lopez@outlook.com', connection: 'connected' };
    };
    await wait(30);
    assert.equal(state(), 'checking');
    assert.ok(text().includes('msSignIn.checking'));
    releaseCheck();
    await wait(30);
    assert.ok(text().includes('msSignIn.connected {"email":"maria.lopez@outlook.com"}'));
    await click(byText('button', 'msSignIn.done'));
    assert.ok(text().includes('admin.accounts.empty') || text().includes('admin.accounts.title'), 'the list');
    assert.ok(reloaded >= 1);
  });

  test('IMAP off: the account error with the Outlook.com steps, and Try again waits for the result', async () => {
    await start([{ status: 'checking', accountId: 'n1', email: 'maria.lopez@outlook.com' },
      { status: 'success', accountId: 'n1', email: 'maria.lopez@outlook.com', connection: 'failed', code: 'ms_imap_disabled_personal', error: 'User is authenticated but not connected.' }]);
    await wait(40);
    const callout = doc.querySelector('[data-error-kind]');
    assert.equal(callout.dataset.errorKind, 'imapOffPersonal');
    assert.ok(callout.textContent.includes('User is authenticated but not connected.'));
    await click(byText('button', 'accountErrors.action.retry'));
    await act(async () => {});
    assert.deepEqual(reconnects, [['n1', { wait: true }]]);
    assert.ok(text().includes('msSignIn.connected'));
  });

  test('still connecting is said as such, not as success', async () => {
    await start([{ status: 'checking', accountId: 'n1', email: 'a@outlook.com' },
      { status: 'success', accountId: 'n1', email: 'a@outlook.com', connection: 'connecting' }]);
    await wait(40);
    assert.ok(text().includes('msSignIn.stillConnecting'));
    assert.ok(!text().includes('msSignIn.connected'));
  });

  for (const [answer, key, restart] of [
    [{ status: 'expired' }, 'msSignIn.expired', 'msSignIn.newCode'],
    [{ status: 'declined' }, 'msSignIn.declined', 'msSignIn.startOver'],
    [{ status: 'error', error: 'AADSTS70016: something' }, 'msSignIn.error', 'msSignIn.startOver'],
  ]) {
    test(`${answer.status}: ${key}, with a way to start again`, async () => {
      await start([answer]);
      await wait(30);
      assert.ok(text().includes(key));
      if (answer.error) assert.ok(doc.querySelector('details').textContent.includes(answer.error));
      await click(byText('button', restart));
      await act(async () => {});
      assert.equal(deviceStarts, 2);
    });
  }
});

describe('review follow-ups', () => {
  test('the Outlook.com note goes away once there is an outcome', async () => {
    await openAdd('builtin');
    polls.push({ status: 'checking', accountId: 'n1', email: 'a@outlook.com' }, { status: 'success', accountId: 'n1', email: 'a@outlook.com', connection: 'connected' });
    // (That it shows before an outcome is covered by the detection tests; with a 10 ms poll
    // the outcome can already be here by the first check.)
    await click(tile('microsoftPersonal'));
    await until(() => text().includes('msSignIn.connected'));
    assert.ok(text().includes('msSignIn.connected'));
    assert.ok(!text().includes('msSignIn.beforeTitle'));
  });

  test('a sign-in the server lost track of says so and points at the accounts', async () => {
    await openAdd('builtin');
    polls.push({ status: 'lost' });
    await click(tile('microsoftPersonal'));
    await wait(30);
    assert.ok(text().includes('msSignIn.lost'));
    assert.ok(!text().includes('msSignIn.error'));
    await click(byText('button', 'msSignIn.checkAccounts'));
    assert.ok(!text().includes('addAccount.title'), 'back to the account list');
  });

  test('an Outlook host typed for a work address offers the work sign-in, without the Outlook.com note', async () => {
    await openAdd('ownCommon');
    await typeAndContinue('maria@contoso.example');
    await setValue(doc.querySelector('input[placeholder="admin.accounts.imapHostPh"]'), 'outlook.office365.com');
    await act(async () => {});
    await click(byText('button', 'msSignIn.titlePersonal'));
    assert.ok(text().includes('msSignIn.titleWork'));
    assert.ok(!text().includes('msSignIn.beforeTitle'));
  });
});

describe('personal accounts on an own app', () => {
  test('with its secret set up, Microsoft\'s page is the main path and the code the alternative', async () => {
    await openAdd('ownCommon');
    await click(tile('microsoftPersonal'));
    assert.ok(text().includes('msSignIn.beforeTitle'), 'the Outlook.com note still applies');
    assert.ok(byText('button', 'msSignIn.continueMicrosoft'));
    assert.equal(deviceStarts, 0);
    await click(byText('button', 'msSignIn.useCode'));
    assert.equal(deviceStarts, 1);
  });

  test('without one, the code', async () => {
    await openAdd('ownCommonNoSecret');
    await click(tile('microsoftPersonal'));
    assert.equal(deviceStarts, 1);
    assert.ok(!byText('button', 'msSignIn.continueMicrosoft'));
  });
});

describe('work and school accounts', () => {
  test('with a secret configured, Microsoft\'s page is the main path and the code the alternative', async () => {
    await openAdd('ownCommon');
    await click(tile('microsoftWork'));
    assert.ok(text().includes('msSignIn.titleWork'));
    assert.ok(byText('button', 'msSignIn.continueMicrosoft'));
    assert.equal(deviceStarts, 0);
    assert.ok(!text().includes('msSignIn.beforeTitle'), 'the Outlook.com note is for personal accounts');
    await click(byText('button', 'msSignIn.useCode'));
    assert.equal(deviceStarts, 1);
  });

  test('the redirect sign-in reports the connection from the page it opened', async () => {
    await openAdd('ownCommon');
    await click(tile('microsoftWork'));
    await click(byText('button', 'msSignIn.continueMicrosoft'));
    assert.ok(text().includes('msSignIn.redirectWaiting'));
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        origin: dom.window.location.origin,
        data: { type: 'oauth_success', provider: 'microsoft', accountId: 'w1', email: 'maria@contoso.example', connection: 'failed', code: 'ms_imap_disabled_work', detail: 'User is authenticated but not connected.' },
      }));
    });
    assert.equal(doc.querySelector('[data-error-kind]').dataset.errorKind, 'imapOffWork');
  });

  test('without a secret, the code is the way', async () => {
    await openAdd('ownOrganizations');
    await click(tile('microsoftWork'));
    assert.equal(deviceStarts, 1);
    assert.ok(!text().includes('msSignIn.useCode'));
  });
});

describe('empty states open the same chooser', () => {
  test('the empty Accounts list has an Add account button', async () => {
    await openAdd('builtin', { intent: null });
    const buttons = [...doc.querySelectorAll('button')].filter(b => b.textContent.trim() === 'admin.accounts.addButton');
    assert.equal(buttons.length, 2, 'the header button and the empty-state one');
    await click(buttons[1]);
    await act(async () => {});
    assert.ok(text().includes('addAccount.title'));
  });

  test('the empty inbox has an Add account button that opens Settings at the chooser', async () => {
    if (root) await act(async () => root.unmount());
    api.getMessages = async () => ({ messages: [], total: 0 });
    useStore.setState({ accounts: [], accountsReady: true, showAdmin: false, accountsIntent: null, adminTab: 'appearance' });
    await act(async () => {
      root = createRoot(doc.getElementById('root'));
      root.render(React.createElement(MessageList));
    });
    await act(async () => {});
    await click(byText('button', 'admin.accounts.addButton'));
    const s = useStore.getState();
    assert.deepEqual(s.accountsIntent, { action: 'add' });
    assert.equal(s.adminTab, 'accounts');
    assert.equal(s.showAdmin, true);
  });
});

// Gmail (#674): Google sign-in from the chooser when the instance's Google client is set up,
// otherwise the app-password form with where to make one.
describe('Gmail', () => {
  const GOOGLE_ON = { configured: true, signIn: true };
  const message = (data) => act(async () => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { origin: dom.window.location.origin, data }));
  });

  test('with Google sign-in set up, the tile and a gmail.com address go to Sign in with Google', async () => {
    await openAdd('builtin', { google: GOOGLE_ON });
    assert.ok(doc.querySelector('[data-tile="gmail"]').textContent.includes('addAccount.tile.gmailSignIn'));
    await typeAndContinue('maria@googlemail.com');
    assert.ok(text().includes('googleSignIn.title'));
    assert.ok(byText('button', 'accountErrors.signInDialog.continueGoogle'));
    assert.ok(text().includes('googleSignIn.finePrint'));
  });

  test('the outcome is the connection, not just the sign-in', async () => {
    await openAdd('builtin', { google: GOOGLE_ON });
    await click(tile('gmail'));
    await click(byText('button', 'accountErrors.signInDialog.continueGoogle'));
    await message({ type: 'oauth_success', provider: 'google', accountId: 'g1', email: 'maria@gmail.com', connection: 'connected' });
    assert.ok(text().includes('msSignIn.connected {"email":"maria@gmail.com"}'));
    assert.ok(reloaded >= 1);
  });

  test('a refused first connection shows the Google account error', async () => {
    await openAdd('builtin', { google: GOOGLE_ON });
    await click(tile('gmail'));
    await message({ type: 'oauth_success', provider: 'google', accountId: 'g1', email: 'maria@gmail.com', connection: 'failed', code: 'oauth_reauth', detail: 'Invalid credentials' });
    const callout = doc.querySelector('[data-error-kind]');
    assert.equal(callout.dataset.errorKind, 'signIn');
    assert.ok(callout.textContent.includes('accountErrors.signIn.titleGoogle'));
  });

  test('without it, the app-password form with a link to make one', async () => {
    await openAdd('builtin');
    assert.ok(doc.querySelector('[data-tile="gmail"]').textContent.includes('addAccount.tile.gmailSub'));
    await click(tile('gmail'));
    assert.equal(doc.querySelector('input[placeholder="admin.accounts.imapHostPh"]').value, 'imap.gmail.com');
    await act(async () => {});
    const note = doc.querySelector('[data-gmail-note]');
    assert.ok(note.textContent.includes('googleSignIn.appPasswordNote'));
    assert.equal(note.querySelector('a').getAttribute('href'), 'https://myaccount.google.com/apppasswords');
  });

  test('a Workspace address on imap.gmail.com is offered Sign in with Google from the form', async () => {
    await openAdd('builtin', { google: GOOGLE_ON });
    await typeAndContinue('maria@company.example');
    await setValue(doc.querySelector('input[placeholder="admin.accounts.imapHostPh"]'), 'imap.gmail.com');
    await act(async () => {});
    assert.ok(doc.querySelector('[data-gmail-note]').textContent.includes('googleSignIn.formNote'));
    await click(byText('button', 'googleSignIn.title'));
    assert.ok(byText('button', 'accountErrors.signInDialog.continueGoogle'));
  });
});

