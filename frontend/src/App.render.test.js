// Render test for the screen lock across a page load (#235).
//
// Locking shows the lock screen at once and tells the server without waiting for the answer
// (store lockScreen). When that request never gets there, the session stays unlocked on the
// server, and the next page load has to choose between the browser's lock flag and what
// /api/auth/me says. That choice is made in App's boot effect, so this boots the real App with
// the flag set and a scripted /me, and checks which screen it lands on. The lock screen's Sign
// out can drop the flag as well, so it is clicked here too.
//
// Same loader hooks as the other render tests. MailApp and LoginPage are stubbed: the question
// is only which screen App picks, and the real mailbox would pull in the whole UI.

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
    if (url.endsWith('/components/MailApp.jsx')) {
      return { format: 'module', shortCircuit: true, source: 'export default function MailApp() { return "MAIL_APP"; }' };
    }
    if (url.endsWith('/components/LoginPage.jsx')) {
      return { format: 'module', shortCircuit: true, source: 'export default function LoginPage() { return "LOGIN_PAGE"; }' };
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

// The page sits at /login, where Sign out sends the browser. jsdom cannot load another page and
// reports any navigation to one, but a navigation to the page it is on does nothing.
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/login', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  // applyTheme rasterises the favicon during boot.
  Image: dom.window.Image,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// Every request, as "METHOD /path". /api/auth/me answers as the test scripts it; anything else
// succeeds, unless the network is down.
const calls = [];
let meResponse;
let offline = false;
globalThis.fetch = async (url, opts = {}) => {
  calls.push(`${opts.method || 'GET'} ${url}`);
  if (offline) throw new TypeError('Failed to fetch');
  if (url === '/api/auth/me') return meResponse();
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const { useStore } = await import('./store/index.js');
const App = (await import('./App.jsx')).default;

const user = { id: 7, username: 'matt', hasLockPin: true };
const meOk = (locked) => () => ({ ok: true, status: 200, json: async () => ({ user: { ...user, locked } }) });
const meExpired = () => ({ ok: false, status: 401, json: async () => ({ error: 'Not authenticated' }) });
// While the backend restarts, the proxy in front of it answers with an HTML error page.
const meBadGateway = () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } });
const meOffline = () => { throw new TypeError('Failed to fetch'); };

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 30)); });

// A page load. A fresh store takes the lock from localStorage, then App boots and asks /me.
let root = null;
async function mount(me) {
  meResponse = me;
  calls.length = 0;
  useStore.setState({ user: null, isLocked: localStorage.getItem('mailflow_locked') === '1' });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(MemoryRouter, null, React.createElement(App))); });
  await settle();
}

async function unmount() {
  const mounted = root;
  root = null;
  if (mounted) await React.act(async () => mounted.unmount());
}
// A test that fails part-way must not leave its page mounted, or the network down, for the next.
afterEach(async () => { offline = false; await unmount(); });

function screen() {
  const text = document.getElementById('root').textContent;
  if (text.includes('lockScreen.unlockButton')) return 'lock screen';
  if (text.includes('MAIL_APP')) return 'mailbox';
  if (text.includes('LOGIN_PAGE')) return 'login page';
  return text;
}

// One page load. Returns the screen it settles on.
async function load(me) {
  await mount(me);
  const shown = screen();
  await unmount();
  return shown;
}

async function click(label) {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === label);
  assert.ok(button, `a ${label} button is shown`);
  await React.act(async () => { button.click(); });
  await settle();
}

test('an ordinary load opens the mailbox and sends no lock', async () => {
  localStorage.removeItem('mailflow_locked');
  assert.equal(await load(meOk(false)), 'mailbox');
  assert.ok(!calls.includes('POST /api/auth/lock'), 'nothing was locked');
  assert.ok(calls.includes('GET /api/auth/preferences'), 'preferences load as usual');
  assert.equal(localStorage.getItem('mailflow_locked'), null);
});

describe('screen lock across a page load (#235)', () => {
  beforeEach(() => { localStorage.setItem('mailflow_locked', '1'); });

  test('keeps a lock the server never got, and sends it again', async () => {
    assert.equal(await load(meOk(false)), 'lock screen');
    assert.equal(localStorage.getItem('mailflow_locked'), '1');
    assert.ok(calls.includes('POST /api/auth/lock'), 'the lock is sent to the server again');
    assert.ok(!calls.includes('GET /api/auth/preferences'), 'preferences wait for the unlock, as on any locked load');
  });

  for (const [what, me] of [['a 502 while the backend restarts', meBadGateway], ['a network error', meOffline]]) {
    test(`keeps the lock through ${what} on /me, for the next load`, async () => {
      assert.equal(await load(me), 'login page');
      assert.equal(localStorage.getItem('mailflow_locked'), '1', 'a failed /me says nothing about the lock');
      // The next load, once the server answers again.
      assert.equal(await load(meOk(false)), 'lock screen');
      assert.ok(calls.includes('POST /api/auth/lock'), 'the lock is sent to the server again');
    });
  }

  test('still clears the lock of a session that has expired', async () => {
    assert.equal(await load(meExpired), 'login page');
    assert.equal(localStorage.getItem('mailflow_locked'), null, 'no stale lock is left for the next sign-in');
  });
});

describe('Sign out on the lock screen (#235)', () => {
  beforeEach(() => { localStorage.removeItem('mailflow_locked'); });

  test('keeps the lock when the sign-out cannot reach the server', async () => {
    await mount(meOk(false));
    assert.equal(screen(), 'mailbox');
    // Auto-lock fires while the network is still down, so the lock never reaches the server,
    // and neither does Sign out.
    offline = true;
    await React.act(async () => { useStore.getState().lockScreen(); });
    assert.equal(screen(), 'lock screen');
    await click('lockScreen.signOut');
    assert.equal(screen(), 'login page');
    assert.equal(localStorage.getItem('mailflow_locked'), '1', 'the session was neither signed out nor locked');
    await unmount();
    // The next load, once the network is back.
    offline = false;
    assert.equal(await load(meOk(false)), 'lock screen');
    assert.ok(calls.includes('POST /api/auth/lock'), 'the lock is sent to the server again');
  });

  test('clears the lock once the server has signed the session out', async () => {
    await mount(meOk(false));
    await React.act(async () => { useStore.getState().lockScreen(); });
    await click('lockScreen.signOut');
    assert.equal(screen(), 'login page');
    assert.ok(calls.includes('POST /api/auth/logout'));
    assert.equal(localStorage.getItem('mailflow_locked'), null, 'no stale lock is left for the next sign-in');
  });
});
