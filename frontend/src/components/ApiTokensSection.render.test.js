// Render test for Settings → Security → API tokens (#617). The card is the only place a token's
// secret is ever shown, so these pin that it appears once, stays out of the store, storage, the URL
// and the console, outlasts the settings panel rebuilding the card, and is gone after Done. They
// also pin what the server decides: which confirmation a new token needs, which expiries are
// offered, whether tokens are on. And that a failed load is said, not shown as an empty list, that
// revoking asks first, and where keyboard focus goes when the control holding it disappears.
//
// Same loader hooks as BackupSettings.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed with the interpolation values appended, so messages can be checked.

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
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
// The (max-width: 767px) query useMobile listens to, so a test can turn a phone sideways.
const MOBILE_QUERY = '(max-width: 767px)';
const viewport = { mobile: false };
const mediaListeners = new Set();
const matchMedia = (query) => ({
  get matches() { return query === MOBILE_QUERY && viewport.mobile; },
  media: query,
  addEventListener: (_, handler) => { if (query === MOBILE_QUERY) mediaListeners.add(handler); },
  removeEventListener: (_, handler) => { mediaListeners.delete(handler); },
  addListener: (handler) => { if (query === MOBILE_QUERY) mediaListeners.add(handler); },
  removeListener: (handler) => { mediaListeners.delete(handler); },
});
Object.defineProperty(dom.window, 'innerWidth', { configurable: true, get: () => (viewport.mobile ? 390 : 1024) });
dom.window.matchMedia = matchMedia;
Object.assign(globalThis, {
  // Both storages, as the app's own code reaches them by their bare names.
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// The fake server. Each test changes what it needs; the token routes keep their own state, so a
// reload shows what the requests before it did.
const SECRET = 'mfat_q7Vf3kLmN0pR2sT4uW6yZ8aC1eG3iK5mO7qS9uX_w2Y';
const CREATED = '2026-10-01T08:00:00Z';
const CALLS = [];
const UNEXPECTED = [];
let server;
let ids = 0;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const token = (fields) => ({
  id: `11111111-1111-4111-8111-${String(++ids).padStart(12, '0')}`, name: 'Token', scopes: ['read'],
  createdAt: CREATED, expiresAt: '2026-12-30T08:00:00Z', lastUsedAt: null, lastUsedIp: null, expired: false,
  ...fields,
});
function freshServer() {
  return {
    enabled: true, reauth: 'password', oidc: null, maxTokens: 20, expiryChoices: [7, 30, 90, 365], tokens: [],
    listError: null, events: [],
    create: (body) => {
      const apiToken = token({ name: body.name, scopes: body.scopes, createdAt: '2026-10-14T12:00:00Z', expiresAt: '2027-01-12T12:00:00Z' });
      server.tokens = [apiToken, ...server.tokens];
      return json({ token: SECRET, apiToken }, 201);
    },
    revoke: (id) => {
      const before = server.tokens.length;
      server.tokens = server.tokens.filter(tok => tok.id !== id);
      return server.tokens.length < before ? json({ ok: true }) : json({ error: 'API token not found' }, 404);
    },
    patchSettings: (body) => {
      if ('api_tokens_enabled' in body) server.enabled = body.api_tokens_enabled;
      return json({ ok: true });
    },
  };
}
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  CALLS.push({ path, method, body });
  if (path === '/api/api-tokens' && method === 'GET') {
    if (server.listError) return json({ error: server.listError }, 500);
    const { enabled, reauth, oidc, maxTokens, expiryChoices, tokens } = server;
    return json({ enabled, reauth, ...(oidc ? { oidc } : {}), maxTokens, expiryChoices, tokens });
  }
  if (path === '/api/api-tokens' && method === 'POST') return server.create(body);
  const one = path.match(/^\/api\/api-tokens\/([^/?]+)$/);
  if (one && method === 'DELETE') return server.revoke(decodeURIComponent(one[1]));
  if (path === '/api/admin/settings') return method === 'PATCH' ? server.patchSettings(body) : json({ settings: {} });
  // What the Security tab's other cards read.
  if (path.startsWith('/api/admin/auth-events?')) return json({ events: server.events, total: server.events.length });
  if (path === '/api/auth/profile/recovery-email') return json({ email: null });
  if (path === '/api/auth/oidc/identities') return json({ identities: [] });
  if (path === '/api/auth/oidc/providers') return json({ providers: [] });
  UNEXPECTED.push(`${method} ${path}`);
  return json({ error: 'unexpected request' }, 500);
};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { formatDateTime, formatDay, formatTime } = await import('../utils/formatDate.js');
const { default: ApiTokensSection } = await import('./ApiTokensSection.jsx');
const { default: AdminPanel } = await import('./AdminPanel.jsx');

const host = document.getElementById('root');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let root;

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const until = async (check, what) => {
  for (let i = 0; i < 60; i++) { if (check()) return; await flush(); }
  assert.fail(`timed out waiting for ${what}; page shows: ${host.textContent}`);
};
const text = () => host.textContent;
const buttonIn = (el, label) => [...el.querySelectorAll('button')].find(b => b.textContent === label);
const button = (label) => buttonIn(host, label);
const click = (el) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
async function type(input, value) {
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function choose(select, value) {
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(select, value);
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}
const scopeBox = (id) => host.querySelector(`input[type="checkbox"][value="${id}"]`);
const nameInput = () => host.querySelector('input[placeholder="admin.apiTokens.namePh"]');
const codeInput = () => host.querySelector('input[autocomplete="one-time-code"]');
const passwordInput = () => host.querySelector('input[autocomplete="current-password"]');
const expirySelect = () => host.querySelector('select');
const createButton = () => button('admin.apiTokens.createButton');
const links = () => [...host.querySelectorAll('a')];
const row = (name) => [...host.querySelectorAll('li')].find(li => li.textContent.includes(name));
const posts = () => CALLS.filter(c => c.method === 'POST');
const deletes = () => CALLS.filter(c => c.method === 'DELETE');
const tokenListLoads = () => CALLS.filter(c => c.method === 'GET' && c.path === '/api/api-tokens').length;
const toggle = () => host.querySelector('[role="switch"]');
// The element whose whole text is this key: 'admin.apiTokens.disabledNotice' is a prefix of the
// administrator's notice, so a text search cannot tell them apart.
const textBlock = (key) => [...host.querySelectorAll('div')].find(el => el.textContent === key);
const focused = () => document.activeElement;
// Rendered nodes are checked as booleans: a failing assert.equal prints each operand in full,
// and for a node React renders that means React's whole tree, which can exhaust memory.
const nameOf = (el) => (!el ? 'nothing' : el === document.body ? 'the page'
  : `<${el.tagName.toLowerCase()}> ${JSON.stringify(el.textContent || el.getAttribute('autocomplete') || '')}`);
const assertNone = (el, what = 'nothing expected') => assert.ok(!el, `${what}: found ${nameOf(el)}`);
const assertFocus = (el, what) => assert.ok(el && focused() === el, `${what}: focus is on ${nameOf(focused())}, not ${nameOf(el)}`);
// What a screen reader adds to a control: the text of the elements its aria-describedby names.
const description = (el) => (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
  .map(id => document.getElementById(id)?.textContent ?? `(no element ${id})`);
// Clicking a button also focuses it in a browser; a dispatched click does not.
const press = async (el) => { el.focus(); await click(el); };
const setMobile = (mobile) => act(async () => {
  viewport.mobile = mobile;
  for (const handler of [...mediaListeners]) handler({ matches: mobile, media: MOBILE_QUERY });
});
const setNavigator = (fields) => {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', ...fields }, configurable: true, writable: true });
};

async function mount({ user = { id: 'u1' } } = {}) {
  useStore.setState({ user });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(ApiTokensSection)); });
  await until(() => !text().includes('common.loading'), 'the token list');
}
async function openForm(name = 'MCP server') {
  await click(button('admin.apiTokens.newToken'));
  if (name) await type(nameInput(), name);
}
// With the default server: password confirmation.
async function createOne(name = 'MCP server') {
  await openForm(name);
  await type(passwordInput(), 'correct horse');
  await click(createButton());
  await until(() => host.querySelector('code'), 'the new token');
}
function captureConsole() {
  const lines = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[level] = console[level];
    console[level] = (...args) => {
      lines.push(args.map(a => (typeof a === 'string' ? a : String(a?.stack || JSON.stringify(a)))).join(' '));
      saved[level](...args);
    };
  }
  return { text: () => lines.join('\n'), restore: () => Object.assign(console, saved) };
}

beforeEach(() => {
  CALLS.length = 0;
  UNEXPECTED.length = 0;
  server = freshServer();
  dom.window.getSelection().removeAllRanges();
  viewport.mobile = false;
  // Closed panel, unlocked: this also drops a token an earlier test did not put away.
  useStore.setState({ showAdmin: false, isLocked: false, adminTab: 'accounts' });
});
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  root = null;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  assert.deepEqual(UNEXPECTED, [], 'no request outside the fake server');
});

describe('API tokens card', () => {
  test('a failed load is shown with a retry, not as an empty list', async () => {
    server.listError = 'The database is not answering';
    await mount();
    assert.ok(text().includes('admin.apiTokens.loadFailed {"message":"The database is not answering"}'), text());
    assert.ok(!text().includes('admin.apiTokens.listEmpty'), 'no empty list in place of the error');
    assertNone(button('admin.apiTokens.newToken'));

    server.listError = null;
    server.tokens = [token({ name: 'Nightly script' })];
    await click(button('common.retry'));
    await until(() => row('Nightly script'), 'the list after a retry');
    assert.ok(!text().includes('admin.apiTokens.loadFailed'));
  });

  test('turned off: a user is told an administrator has to turn tokens on, and can still revoke', async () => {
    server.enabled = false;
    server.tokens = [token({ name: 'Old script' })];
    await mount();
    assert.ok(textBlock('admin.apiTokens.disabledNotice'));
    assertNone(textBlock('admin.apiTokens.disabledNoticeAdmin'), 'there is no switch to point at');
    assertNone(button('admin.apiTokens.newToken'), 'nothing to create with tokens off');
    assertNone(toggle(), 'only an administrator has the switch');
    assert.ok(buttonIn(row('Old script'), 'admin.apiTokens.revokeButton'), 'a token made before can still be revoked');
  });

  test('an administrator turns tokens on and off with the switch, and the card follows the server', async () => {
    server.enabled = false;
    await mount({ user: { id: 'u1', isAdmin: true } });
    assert.equal(toggle().getAttribute('aria-checked'), 'false');
    assert.equal(toggle().getAttribute('aria-label'), 'admin.apiTokens.serverSwitchLabel');
    assertNone(button('admin.apiTokens.newToken'));
    assert.ok(textBlock('admin.apiTokens.disabledNoticeAdmin'), 'told why there is no New token');
    assertNone(textBlock('admin.apiTokens.disabledNotice'));

    await click(toggle());
    await until(() => toggle().getAttribute('aria-checked') === 'true', 'the switch to turn on');
    assert.ok(button('admin.apiTokens.newToken'), 'New token appears once tokens are on');
    assertNone(textBlock('admin.apiTokens.disabledNoticeAdmin'));

    await click(toggle());
    await until(() => toggle().getAttribute('aria-checked') === 'false', 'the switch to turn off');
    assertNone(button('admin.apiTokens.newToken'), 'New token goes once tokens are off');
    await click(toggle());
    await until(() => toggle().getAttribute('aria-checked') === 'true', 'the switch to turn back on');
    assert.deepEqual(CALLS.filter(c => c.method === 'PATCH').map(c => [c.path, c.body]), [
      ['/api/admin/settings', { api_tokens_enabled: true }],
      ['/api/admin/settings', { api_tokens_enabled: false }],
      ['/api/admin/settings', { api_tokens_enabled: true }],
    ]);

    server.patchSettings = () => json({ error: 'Admin access required' }, 403);
    await click(toggle());
    await until(() => host.querySelector('[role="alert"]'), 'the refusal');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'Admin access required');
    assert.equal(toggle().getAttribute('aria-checked'), 'true', 'the switch stays as the server has it');
  });

  test('an administrator refused because tokens were turned off elsewhere is told why, and starts clean once they are on', async () => {
    await mount({ user: { id: 'u1', isAdmin: true } });
    await openForm('MCP server');
    await type(passwordInput(), 'correct horse');
    // Another administrator, or this one in another tab, turns tokens off meanwhile.
    server.enabled = false;
    server.create = () => json({ error: 'API tokens are turned off on this server' }, 403);
    await press(createButton());
    await until(() => toggle().getAttribute('aria-checked') === 'false', 'the card to follow the server');
    assertNone(nameInput(), 'no form while tokens are off');
    const notice = textBlock('admin.apiTokens.disabledNoticeAdmin');
    assert.ok(notice, 'the administrator is told why the form went');
    assertFocus(notice, 'and the reason is where focus goes');

    server.create = freshServer().create;
    await click(toggle());
    await until(() => toggle().getAttribute('aria-checked') === 'true', 'the switch to turn on');
    assertNone(nameInput(), 'the old form does not come back by itself');
    assertNone(host.querySelector('[role="alert"]'), 'nor a refusal that is no longer true');
    await click(button('admin.apiTokens.newToken'));
    assert.equal(nameInput().value, '');
    assert.equal(passwordInput().value, '');
  });

  test('the new token is shown once, kept out of the store, storage, the URL and the console, and Done clears it', async () => {
    server.reauth = 'totp';
    const logged = captureConsole();
    try {
      await mount();
      await openForm('MCP server');
      await click(scopeBox('organize'));
      await type(codeInput(), '123456');
      await press(createButton());
      await until(() => host.querySelector('code'), 'the new token');

      assert.deepEqual(posts().map(c => [c.path, c.body]), [['/api/api-tokens',
        { name: 'MCP server', scopes: ['read', 'organize'], expiresInDays: 90, totpCode: '123456' }]]);
      assert.equal(host.querySelector('code').textContent, SECRET);
      assert.ok(text().includes('admin.apiTokens.createdTitle {"name":"MCP server"}'));
      assert.ok(text().includes('admin.apiTokens.secretWarning'));
      assert.ok(row('MCP server'), 'the new token is listed');
      assertNone(button('admin.apiTokens.newToken'), 'the next token waits until this one is put away');
      // The button that had focus is gone; focus lands on Copy, which carries what just happened.
      assertFocus(button('common.copy'), 'focus moves to Copy');
      assert.deepEqual(description(focused()),
        ['admin.apiTokens.createdTitle {"name":"MCP server"}', 'admin.apiTokens.secretWarning']);

      assert.ok(!JSON.stringify(useStore.getState()).includes(SECRET), 'not in the store');
      for (const storage of [dom.window.localStorage, dom.window.sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          assert.ok(!storage.getItem(storage.key(i)).includes(SECRET), `not in storage under ${storage.key(i)}`);
        }
      }
      assert.ok(!dom.window.location.href.includes(SECRET), 'not in the URL');

      await press(button('admin.apiTokens.done'));
      assert.ok(!host.innerHTML.includes(SECRET), 'Done takes the token off the page');
      assert.ok(!text().includes('admin.apiTokens.createdTitle'));
      assert.ok(button('admin.apiTokens.newToken'));
      assertFocus(button('admin.apiTokens.newToken'), 'focus moves on to New token');
      assert.ok(row('MCP server'), 'the token itself stays listed');

      await click(button('admin.apiTokens.newToken'));
      assert.equal(codeInput().value, '', 'the next token asks for a new code');
      assert.equal(nameInput().value, '');
      assert.equal(scopeBox('organize').checked, false);
    } finally {
      logged.restore();
    }
    assert.ok(!logged.text().includes(SECRET), 'never logged');
  });

  test('each scope is labelled and described; Read is ticked and locked while Organize or Draft is ticked', async () => {
    await mount();
    await openForm();
    // The descriptions are where a user learns the limits (nothing into Trash or Junk, drafts
    // only), so each one must sit with its own checkbox.
    for (const [id, key] of [['read', 'Read'], ['organize', 'Organize'], ['draft', 'Draft']]) {
      assert.equal(scopeBox(id).closest('label').textContent,
        `admin.apiTokens.scope${key}Label` + `admin.apiTokens.scope${key}Desc`, `the ${id} checkbox`);
    }
    assert.equal(scopeBox('read').checked, true, 'Read is the starting choice');
    assert.equal(scopeBox('read').disabled, false);
    // Every token has Read, so the warning is always there, and read out with the checkbox.
    assert.deepEqual(description(scopeBox('read')), ['admin.apiTokens.readWarning']);
    await click(scopeBox('read'));
    assert.equal(scopeBox('read').checked, false, 'Read on its own can be unticked');

    await click(scopeBox('draft'));
    assert.equal(scopeBox('read').checked, true, 'Draft ticks Read');
    assert.equal(scopeBox('read').disabled, true, 'and locks it');
    assert.ok(text().includes('admin.apiTokens.readLocked'), 'saying why');
    assert.deepEqual(description(scopeBox('read')), ['admin.apiTokens.readLocked', 'admin.apiTokens.readWarning']);
    await click(scopeBox('read'));
    assert.equal(scopeBox('read').checked, true, 'Read cannot be unticked while Draft is ticked');

    await click(scopeBox('organize'));
    await click(scopeBox('draft'));
    assert.equal(scopeBox('read').disabled, true, 'Organize locks it too');
    await click(scopeBox('organize'));
    assert.equal(scopeBox('read').disabled, false, 'free again once neither is ticked');
    assert.equal(scopeBox('read').checked, true, 'and still ticked, as the lock left it');
    assert.ok(!text().includes('admin.apiTokens.readLocked'));

    await click(scopeBox('read'));
    await click(scopeBox('draft'));
    await type(passwordInput(), 'correct horse');
    await click(createButton());
    await until(() => posts().length === 1, 'the create request');
    assert.deepEqual(posts()[0].body.scopes, ['read', 'draft'], 'Read is sent even after it was unticked first');
  });

  test('a TOTP user confirms with a six-digit code', async () => {
    server.reauth = 'totp';
    await mount();
    await openForm();
    assert.ok(codeInput(), 'the code field');
    assertNone(passwordInput(), 'no password field');
    assert.equal(codeInput().getAttribute('inputmode'), 'numeric');
    assert.equal(createButton().disabled, true, 'no code, no token');
    await type(codeInput(), '12a34 5');
    assert.equal(codeInput().value, '12345', 'only digits are kept');
    assert.equal(createButton().disabled, true, 'five digits are not a code');
    await type(codeInput(), '654321');
    assert.equal(createButton().disabled, false);
    await click(createButton());
    await until(() => posts().length === 1, 'the create request');
    assert.equal(posts()[0].body.totpCode, '654321');
    assert.equal('password' in posts()[0].body, false);
  });

  test('a password user confirms with the password', async () => {
    server.reauth = 'password';
    await mount();
    await openForm();
    assert.equal(passwordInput().type, 'password');
    assertNone(codeInput(), 'no code field');
    assert.equal(createButton().disabled, true, 'no password, no token');
    await type(passwordInput(), 'correct horse');
    await click(createButton());
    await until(() => posts().length === 1, 'the create request');
    assert.equal(posts()[0].body.password, 'correct horse');
    assert.equal('totpCode' in posts()[0].body, false);
  });

  test('an account that signs in through SSO confirms with its provider, then has nothing to type', async () => {
    server.reauth = 'oidc';
    server.expiryChoices = [7, 30];
    server.oidc = { providers: [{ slug: 'corp', name: 'Corp SSO' }, { slug: 'backup-idp', name: 'Backup' }], confirmedUntil: null };
    await mount();
    await openForm();
    assertNone(codeInput());
    assertNone(passwordInput());
    // One button per provider, through the provider and back to this card.
    assert.deepEqual(links().map(a => [a.textContent, a.getAttribute('href')]), [
      ['admin.apiTokens.reauthOidcButton {"provider":"Corp SSO"}', '/auth/oidc/corp/start?action=reauth'],
      ['admin.apiTokens.reauthOidcButton {"provider":"Backup"}', '/auth/oidc/backup-idp/start?action=reauth'],
    ]);
    assert.deepEqual(description(links()[0]), ['admin.apiTokens.reauthOidcHint']);
    assert.equal(createButton().disabled, true, 'nothing is created before the provider confirms');
    await act(async () => { root.unmount(); });

    // Back from the provider: the sign-in counts for a few minutes.
    const confirmedUntil = new Date(Date.now() + 9 * 60_000).toISOString();
    server.oidc = { ...server.oidc, confirmedUntil };
    await mount();
    await openForm();
    assert.deepEqual(links(), []);
    assert.ok(text().includes(`admin.apiTokens.reauthOidcDone {"time":"${formatTime(confirmedUntil)}"}`));
    assert.equal(expirySelect().value, '30');
    await click(createButton());
    await until(() => posts().length === 1, 'the create request');
    assert.deepEqual(posts()[0].body, { name: 'MCP server', scopes: ['read'], expiresInDays: 30 });
  });

  test('a single sign-on confirmation makes one token, and counts only until its time', async () => {
    server.reauth = 'oidc';
    server.expiryChoices = [7, 30];
    server.oidc = { providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: new Date(Date.now() + 9 * 60_000).toISOString() };
    // Creating a token spends the confirmation, as the server does.
    const create = server.create;
    server.create = (body) => { server.oidc = { ...server.oidc, confirmedUntil: null }; return create(body); };
    await mount();
    await openForm();
    await click(createButton());
    await until(() => host.querySelector('code'), 'the new token');
    await click(button('admin.apiTokens.done'));
    await openForm();
    assert.deepEqual(links().map(a => a.getAttribute('href')), ['/auth/oidc/corp/start?action=reauth'], 'the next token needs a sign-in of its own');
    assert.equal(createButton().disabled, true);
    await act(async () => { root.unmount(); });

    // A confirmation whose time has passed does not count, whatever the server last said.
    server.oidc = { ...server.oidc, confirmedUntil: new Date(Date.now() - 1000).toISOString() };
    await mount();
    await openForm();
    assert.equal(links().length, 1);
    assert.equal(createButton().disabled, true);
  });

  test('an SSO-path refusal takes focus itself, as there is nothing to type again', async () => {
    server.reauth = 'oidc';
    server.expiryChoices = [7, 30];
    server.oidc = { providers: [{ slug: 'corp', name: 'Corp SSO' }], confirmedUntil: new Date(Date.now() + 9 * 60_000).toISOString() };
    server.create = () => {
      server.oidc = { ...server.oidc, confirmedUntil: null };
      return json({ error: 'Confirm through single sign-on first; each confirmation makes one token and counts for 10 minutes', reauth: 'oidc' }, 400);
    };
    await mount();
    await openForm();
    await press(createButton());
    await until(() => host.querySelector('[role="alert"]'), 'the refusal');
    assertFocus(host.querySelector('[role="alert"]'), 'the refusal');
    await until(() => links().length === 1, 'the Confirm button to come back');
  });

  test('an account with no SSO identity to confirm with is told so, and cannot create', async () => {
    server.reauth = 'oidc';
    server.expiryChoices = [7, 30];
    server.oidc = { providers: [], confirmedUntil: null };
    await mount();
    await openForm();
    assert.ok(textBlock('admin.apiTokens.reauthOidcNoProvider'));
    assert.deepEqual(links(), []);
    assert.equal(createButton().disabled, true);
  });

  test('when two-factor is required and the user has no authenticator, they are sent to set one up', async () => {
    server.reauth = 'totpSetup';
    server.tokens = [token({ name: 'Old script' })];
    await mount({ user: { id: 'u1', totpEnabled: false } });
    assert.ok(textBlock('admin.apiTokens.totpSetupNotice'));
    assertNone(button('admin.apiTokens.newToken'), 'no form that could only be refused');
    assert.ok(buttonIn(row('Old script'), 'admin.apiTokens.revokeButton'), 'a token made before can still be revoked');

    server.reauth = 'totp';
    await act(async () => { useStore.setState({ user: { id: 'u1', totpEnabled: true } }); });
    await until(() => button('admin.apiTokens.newToken'), 'New token once two-factor is on');
    assertNone(textBlock('admin.apiTokens.totpSetupNotice'));
  });

  test('turning two-factor on in the card above switches the confirmation to a code', async () => {
    server.reauth = 'password';
    await mount({ user: { id: 'u1', totpEnabled: false } });
    await openForm();
    assert.ok(passwordInput());
    server.reauth = 'totp';
    await act(async () => { useStore.setState({ user: { id: 'u1', totpEnabled: true } }); });
    await until(() => codeInput(), 'the code field');
    assertNone(passwordInput());
  });

  test('the expiry choices are the server\'s, 90 days by default, sent as a number', async () => {
    await mount();
    await openForm();
    assert.deepEqual([...expirySelect().options].map(o => [o.value, o.textContent]), [
      ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '365 days'],
    ]);
    assert.equal(expirySelect().value, '90');
    await choose(expirySelect(), '365');
    await type(passwordInput(), 'correct horse');
    await click(createButton());
    await until(() => posts().length === 1, 'the create request');
    assert.equal(posts()[0].body.expiresInDays, 365);
  });

  test('fewer expiry choices are followed too: 30 days by default, else the first', async () => {
    server.expiryChoices = [7, 30];
    await mount();
    await openForm();
    assert.deepEqual([...expirySelect().options].map(o => o.value), ['7', '30']);
    assert.equal(expirySelect().value, '30');
    await act(async () => { root.unmount(); });

    server.expiryChoices = [14, 60];
    await mount();
    await openForm();
    assert.deepEqual([...expirySelect().options].map(o => [o.value, o.textContent]), [['14', '14 days'], ['60', '60 days']]);
    assert.equal(expirySelect().value, '14');
    await choose(expirySelect(), '60');
    await type(passwordInput(), 'correct horse');
    await click(createButton());
    await until(() => posts().length === 1, 'the create request');
    assert.equal(posts()[0].body.expiresInDays, 60);
  });

  test('Copy puts the token on the clipboard and says so', async () => {
    const written = [];
    setNavigator({ clipboard: { writeText: async (value) => { written.push(value); } } });
    await mount();
    await createOne();
    await click(button('common.copy'));
    await until(() => button('admin.apiTokens.copied'), 'the copied label');
    assert.deepEqual(written, [SECRET]);
    assertNone(host.querySelector('[role="alert"]'));
  });

  test('when copying fails it says so, and leaves the token selected to copy by hand', async () => {
    setNavigator({}); // no clipboard API, and jsdom has no execCommand
    await mount();
    await createOne();
    await click(button('common.copy'));
    await until(() => text().includes('common.copyFailed'), 'the failure message');
    assert.equal(dom.window.getSelection().toString(), SECRET);
  });

  test('a refused creation shows the server\'s reason, asks for the code again and keeps the rest', async () => {
    server.reauth = 'totp';
    server.create = () => json({ error: 'Confirm with your current two-factor code', reauth: 'totp' }, 400);
    await mount();
    await openForm('MCP server');
    await type(codeInput(), '000000');
    const loadsBefore = tokenListLoads();
    await press(createButton());
    await until(() => host.querySelector('[role="alert"]'), 'the refusal');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'Confirm with your current two-factor code');
    assert.equal(codeInput().value, '', 'a code is good once');
    assertFocus(codeInput(), 'focus is where the next code goes');
    assert.equal(nameInput().value, 'MCP server');
    assertNone(host.querySelector('code'), 'no token to show');
    await until(() => tokenListLoads() > loadsBefore, 'the card to ask the server again');
  });

  test('a refusal because what confirmed the token changed since: the reason, and the card asks the server again', async () => {
    server.create = () => json({ error: 'Your password, two-factor or single sign-on setup changed while this token was being created. Confirm again.' }, 409);
    await mount();
    await openForm('MCP server');
    await type(passwordInput(), 'correct horse');
    const loadsBefore = tokenListLoads();
    await press(createButton());
    await until(() => host.querySelector('[role="alert"]'), 'the refusal');
    assert.ok(host.querySelector('[role="alert"]').textContent.endsWith('Confirm again.'));
    assert.equal(passwordInput().value, '', 'the password is typed again');
    assert.equal(nameInput().value, 'MCP server', 'the rest of the form stays');
    await until(() => tokenListLoads() > loadsBefore, 'the card to ask the server again');
  });

  test('a refusal that leaves no room for the form closes it, so nothing stale comes back with it', async () => {
    server.tokens = [token({ name: 'Nightly script' })];
    server.create = () => {
      // Another browser filled the list meanwhile.
      server.tokens = Array.from({ length: 20 }, (_, i) => token({ name: `Token ${i}` }));
      return json({ error: 'You already have 20 API tokens. Revoke one to create another.' }, 400);
    };
    await mount();
    await openForm('MCP server');
    await type(passwordInput(), 'correct horse');
    await press(createButton());
    await until(() => textBlock('admin.apiTokens.maxReached {"max":20}'), 'the limit notice');
    assertNone(nameInput(), 'the form is gone');
    assertNone(host.querySelector('[role="alert"]'), 'and so is the refusal');
    assertFocus(textBlock('admin.apiTokens.maxReached {"max":20}'), 'focus moves to the notice');
    // Room again: the form starts clean.
    await press(buttonIn(row('Token 0'), 'admin.apiTokens.revokeButton'));
    await press(buttonIn(row('Token 0'), 'admin.apiTokens.revokeYes'));
    await until(() => button('admin.apiTokens.newToken'), 'New token');
    await openForm(null);
    assert.equal(nameInput().value, '');
    assertNone(host.querySelector('[role="alert"]'));
    await act(async () => { root.unmount(); });

    // The same when two-factor became required meanwhile and the user has no authenticator.
    server = freshServer();
    server.create = () => {
      server.reauth = 'totpSetup';
      return json({ error: 'This server requires two-factor authentication. Set up an authenticator app to create API tokens.', reauth: 'totpSetup' }, 403);
    };
    await mount();
    await openForm('MCP server');
    await type(passwordInput(), 'correct horse');
    await press(createButton());
    await until(() => textBlock('admin.apiTokens.totpSetupNotice'), 'the set-up notice');
    assertNone(nameInput());
    assertNone(host.querySelector('[role="alert"]'));
  });

  test('a typed password is never kept: not after a refusal, a new token, or Cancel', async () => {
    server.create = () => json({ error: 'Incorrect password', reauth: 'password' }, 400);
    await mount();
    await openForm('MCP server');
    await type(passwordInput(), 'wrong horse');
    await press(createButton());
    await until(() => host.querySelector('[role="alert"]'), 'the refusal');
    assert.equal(host.querySelector('[role="alert"]').textContent, 'Incorrect password');
    assert.equal(passwordInput().value, '', 'a refused password is typed again');
    assertFocus(passwordInput(), 'there');
    assert.equal(nameInput().value, 'MCP server');

    server.create = freshServer().create;
    await type(passwordInput(), 'correct horse');
    await press(createButton());
    await until(() => host.querySelector('code'), 'the new token');
    await click(button('admin.apiTokens.done'));
    await click(button('admin.apiTokens.newToken'));
    // Otherwise anyone at the unlocked browser could make a second token with one click.
    assert.equal(passwordInput().value, '', 'the password is not kept for the next token');
    assert.equal(nameInput().value, '');
    assert.equal(createButton().disabled, true);

    await type(nameInput(), 'Second');
    await type(passwordInput(), 'correct horse');
    await press(button('common.cancel'));
    assertNone(nameInput());
    assertFocus(button('admin.apiTokens.newToken'), 'Cancel hands focus back to New token');
    await click(button('admin.apiTokens.newToken'));
    assert.equal(passwordInput().value, '', 'nor after Cancel');
    assert.equal(nameInput().value, '');
    assert.equal(posts().length, 2);
  });

  test('Revoke asks first, then revokes that token only', async () => {
    server.tokens = [token({ name: 'Laptop script' }), token({ name: 'Dashboard' })];
    const id = server.tokens[0].id;
    await mount();
    const revokeOf = (name) => buttonIn(row(name), 'admin.apiTokens.revokeButton');
    assert.deepEqual(description(revokeOf('Dashboard')), ['Dashboard'], 'each Revoke says which token');

    await press(revokeOf('Laptop script'));
    assert.ok(row('Laptop script').textContent.includes('admin.apiTokens.revokeAsk'));
    assert.equal(deletes().length, 0, 'nothing is revoked before the confirmation');
    // Revoke itself is gone: focus starts on Cancel, the safe answer, with the question read out.
    assertFocus(buttonIn(row('Laptop script'), 'common.cancel'), 'the confirm step');
    assert.deepEqual(description(focused()), ['admin.apiTokens.revokeAsk']);
    await press(buttonIn(row('Laptop script'), 'common.cancel'));
    assert.ok(!row('Laptop script').textContent.includes('admin.apiTokens.revokeAsk'));
    assert.equal(deletes().length, 0, 'Cancel revokes nothing');
    assertFocus(revokeOf('Laptop script'), 'and gives focus back to Revoke');

    await press(revokeOf('Laptop script'));
    await press(buttonIn(row('Laptop script'), 'admin.apiTokens.revokeYes'));
    await until(() => !row('Laptop script'), 'the row to go');
    assert.deepEqual(deletes().map(c => c.path), [`/api/api-tokens/${id}`]);
    assert.ok(row('Dashboard'), 'the other token stays');
    assertFocus(revokeOf('Dashboard'), 'focus moves on to the next token');

    await press(revokeOf('Dashboard'));
    await press(buttonIn(row('Dashboard'), 'admin.apiTokens.revokeYes'));
    await until(() => !row('Dashboard'), 'the last row to go');
    assertFocus(button('admin.apiTokens.newToken'), 'and to New token after the last one');
  });

  test('a refused revoke says why and keeps the row; a token already gone is dropped', async () => {
    server.tokens = [token({ name: 'Dashboard' }), token({ name: 'Revoked elsewhere' })];
    const [kept] = server.tokens;
    server.revoke = (id) => (id === kept.id
      ? json({ error: 'The database is not answering' }, 500)
      : json({ error: 'API token not found' }, 404));
    await mount();
    await click(buttonIn(row('Dashboard'), 'admin.apiTokens.revokeButton'));
    await click(buttonIn(row('Dashboard'), 'admin.apiTokens.revokeYes'));
    await until(() => row('Dashboard').querySelector('[role="alert"]'), 'the refusal');
    assert.equal(row('Dashboard').querySelector('[role="alert"]').textContent, 'The database is not answering');

    await press(buttonIn(row('Revoked elsewhere'), 'admin.apiTokens.revokeButton'));
    await press(buttonIn(row('Revoked elsewhere'), 'admin.apiTokens.revokeYes'));
    await until(() => !row('Revoked elsewhere'), 'the row to go');
    assert.ok(row('Dashboard'));
    assertFocus(buttonIn(row('Dashboard'), 'admin.apiTokens.revokeButton'), 'the last row hands focus to the one before');
  });

  test('rows show scopes, dates and last use, and a full list says why there is no New token', async () => {
    server.maxTokens = 3;
    server.tokens = [
      token({ name: 'Reader bot', scopes: ['read', 'draft'], expiresAt: '2026-12-30T08:00:00Z' }),
      token({ name: 'Expired job', expired: true, expiresAt: '2026-10-08T08:00:00Z', lastUsedAt: '2026-10-07T21:15:00Z', lastUsedIp: '203.0.113.7' }),
      token({ name: 'Proxy job', expiresAt: '2027-01-14T08:00:00Z', lastUsedAt: '2026-10-14T09:30:00Z', lastUsedIp: null }),
    ];
    await mount();
    const reader = row('Reader bot').textContent;
    assert.ok(reader.includes('admin.apiTokens.scopeReadLabel') && reader.includes('admin.apiTokens.scopeDraftLabel'));
    assert.ok(!reader.includes('admin.apiTokens.scopeOrganizeLabel'));
    assert.ok(reader.includes(`admin.apiTokens.createdAt {"date":"${formatDay(CREATED)}"}`));
    assert.ok(reader.includes(`admin.apiTokens.expiresAt {"date":"${formatDay('2026-12-30T08:00:00Z')}"}`));
    assert.ok(reader.includes('admin.apiTokens.neverUsed'));
    const expired = row('Expired job').textContent;
    assert.ok(expired.includes('admin.apiTokens.expired'));
    assert.ok(expired.includes(`admin.apiTokens.lastUsedFrom ${JSON.stringify({ date: formatDateTime('2026-10-07T21:15:00Z'), ip: '203.0.113.7' })}`));
    // An IPv6 address is one word, wider than the column beside Revoke on a phone.
    const lastUse = [...row('Expired job').querySelectorAll('div')].find(el => el.textContent.startsWith('admin.apiTokens.lastUsedFrom'));
    assert.equal(lastUse.style.overflowWrap, 'anywhere', 'the last-use line may break inside an address');
    const proxy = row('Proxy job').textContent;
    assert.ok(proxy.includes(`admin.apiTokens.expiresAt {"date":"${formatDay('2027-01-14T08:00:00Z')}"}`));
    assert.ok(proxy.includes(`admin.apiTokens.lastUsedAt ${JSON.stringify({ date: formatDateTime('2026-10-14T09:30:00Z') })}`));

    assert.ok(text().includes('admin.apiTokens.maxReached {"max":3}'));
    assertNone(button('admin.apiTokens.newToken'));
  });

  // The card loads its list on mount and again when two-factor changes, after a refusal and after
  // the switch, so two loads can be out at once.
  for (const [what, staleAnswer] of [
    ['a slow answer', () => json({ enabled: true, reauth: 'password', maxTokens: 20, expiryChoices: [7, 30, 90, 365], tokens: [] })],
    ['a slow failure', () => json({ error: 'The database is not answering' }, 500)],
  ]) {
    test(`only the newest list load counts: ${what} that a newer load overtook is dropped`, async () => {
      const realFetch = globalThis.fetch;
      let release;
      let held = false;
      globalThis.fetch = async (url, init = {}) => {
        if (!held && url === '/api/api-tokens' && (init.method || 'GET') === 'GET') {
          held = true;
          await new Promise(r => { release = r; });
          return staleAnswer();
        }
        return realFetch(url, init);
      };
      try {
        server.reauth = 'totp';
        server.tokens = [token({ name: 'Fresh' })];
        useStore.setState({ user: { id: 'u1', totpEnabled: false } });
        root = createRoot(host);
        await act(async () => { root.render(React.createElement(ApiTokensSection)); });
        await act(async () => { useStore.setState({ user: { id: 'u1', totpEnabled: true } }); });
        await until(() => row('Fresh'), 'the newer list');

        release();
        for (let i = 0; i < 5; i++) await flush();
        assert.ok(row('Fresh'), 'the newer list stays');
        assert.ok(!text().includes('admin.apiTokens.loadFailed'), 'no failure from the overtaken load');
        await openForm();
        assert.ok(codeInput(), 'the newer answer\'s confirmation, a code');
        assertNone(passwordInput());
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }
});

describe('Settings › Security', () => {
  const leaf = (label) => [...host.querySelectorAll('*')].find(el => el.children.length === 0 && el.textContent === label);

  test('the API tokens card follows two-factor, the activity log names token events, and search finds the card', async () => {
    server.events = [
      { id: 1, event_type: 'api_token_created', username: 'marty', ip: '192.0.2.1', success: true, created_at: '2026-10-14T10:00:00Z' },
      { id: 2, event_type: 'api_token_revoked', username: 'marty', ip: '192.0.2.1', success: true, created_at: '2026-10-14T10:01:00Z' },
      { id: 3, event_type: 'api_token_auth_fail', username: null, ip: '192.0.2.9', success: false, created_at: '2026-10-14T10:02:00Z' },
    ];
    useStore.setState({ user: { id: 'u1', isAdmin: true }, adminTab: 'security' });
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(AdminPanel)); });
    await until(() => text().includes('admin.apiTokens.listEmpty') && text().includes('admin.security.eventApiTokenCreated'), 'the Security tab');

    const following = (a, b) => Boolean(a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    const twoFactor = leaf('admin.security.totpTitle');
    const tokens = leaf('admin.apiTokens.title');
    const mfa = leaf('admin.security.mfaEnforcementTitle');
    assert.ok(twoFactor && tokens && mfa);
    assert.ok(following(twoFactor, tokens), 'after the two-factor card');
    assert.ok(following(tokens, mfa), 'and before the next card');

    for (const key of ['eventApiTokenCreated', 'eventApiTokenRevoked', 'eventApiTokenAuthFail']) {
      assert.ok(text().includes(`admin.security.${key}`), key);
    }
    for (const raw of ['api_token_created', 'api_token_revoked', 'api_token_auth_fail']) {
      assert.ok(!text().includes(raw), `${raw} has a label`);
    }

    await type(host.querySelector('input[placeholder="admin.search.placeholder"]'), 'mcp');
    const found = [...host.querySelectorAll('button')].filter(b => b.textContent.includes('admin.apiTokens.title'));
    assert.equal(found.length, 1, 'Settings search finds the card');
  });

  // The panel as MailApp shows it: open, on the Security tab.
  async function openSecurity(user = { id: 'u1' }) {
    useStore.setState({ user, adminTab: 'security', showAdmin: true });
    root = createRoot(host);
    await act(async () => { root.render(React.createElement(AdminPanel)); });
    await until(() => button('admin.apiTokens.newToken'), 'the API tokens card');
  }
  const card = () => textBlock('admin.apiTokens.title')?.parentElement; // the title; search shows a span
  const loadedCard = (other) => { const c = card(); return c && c !== other && !c.textContent.includes('common.loading'); };
  const shownToken = () => host.querySelector('code')?.textContent;

  test('a new token stays on screen until Done while the panel rebuilds the card: phone and desktop layouts, search', async () => {
    await openSecurity();
    await createOne();
    let before = card();
    const loads = tokenListLoads();

    await setMobile(true); // a window snapped narrow, or a phone turned upright
    await until(() => loadedCard(before), 'the phone layout');
    assert.ok(tokenListLoads() > loads, 'the panel built a new card');
    assert.equal(shownToken(), SECRET, 'the token is still there to copy');
    assert.ok(button('admin.apiTokens.done'));

    before = card();
    await setMobile(false); // turned sideways again
    await until(() => loadedCard(before), 'the desktop layout');
    assert.equal(shownToken(), SECRET);

    const search = host.querySelector('input[placeholder="admin.search.placeholder"]');
    await type(search, 'mcp');
    assertNone(card(), 'search results replace the tab');
    await type(search, '');
    await until(() => loadedCard(null), 'the tab again');
    assert.equal(shownToken(), SECRET, 'and the token is back when the search is cleared');

    await click(button('admin.apiTokens.done'));
    assert.equal(shownToken(), undefined);
    await setMobile(true);
    await until(() => button('admin.apiTokens.newToken'), 'the phone layout');
    assert.equal(shownToken(), undefined, 'Done is final');
    assert.equal(server.tokens.length, 1, 'one token made, none left over');
  });

  for (const [what, away, back] of [
    ['the settings panel closes', { showAdmin: false }, { showAdmin: true }],
    ['the screen locks', { isLocked: true }, { isLocked: false }],
    ['the user signs out, even to sign straight back in', { user: null }, { user: { id: 'u1' } }],
  ]) {
    test(`a new token not put away is dropped when ${what}`, async () => {
      await openSecurity();
      await createOne();
      // The panel goes, or the whole app behind the lock screen or the sign-in page.
      await act(async () => { root.unmount(); });
      root = null;
      await act(async () => { useStore.setState(away); });
      await act(async () => { useStore.setState(back); });
      root = createRoot(host);
      await act(async () => { root.render(React.createElement(AdminPanel)); });
      await until(() => button('admin.apiTokens.newToken'), 'the API tokens card');
      assert.equal(shownToken(), undefined);
      assert.ok(!host.innerHTML.includes(SECRET));
    });
  }

  test('a new token is never shown to another user, even one whose session replaces this one in place', async () => {
    await openSecurity();
    await createOne();
    await act(async () => { useStore.setState({ user: { id: 'u2' } }); });
    assert.equal(shownToken(), undefined, 'gone at once');
    assert.ok(!host.innerHTML.includes(SECRET));
  });
});
