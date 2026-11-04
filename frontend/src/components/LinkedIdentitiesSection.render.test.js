// Render test for linking a single sign-on identity from Settings → Security (#714).
//
// The server says what a link has to be confirmed with (GET /auth/oidc/identities answers
// `reauth`), and the section asks for it before the browser goes to the provider: the password,
// the two-factor code, or a fresh sign-in through a provider already linked. What only a render
// shows is that nothing goes to the provider until POST /auth/oidc/link-confirm has accepted the
// answer, and that each kind of account is asked for the right thing.
//
// Same loader hooks as AdminPanel.render.test.js: node --test cannot parse JSX, and react-i18next
// is stubbed so t() returns its key.

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
const { api } = await import('../utils/api.js');
const { LinkedIdentitiesSection } = await import('./AdminPanel.jsx');

// Corp is linked already; Other is the one to link.
const PROVIDERS = [{ id: 'p-corp', name: 'Corp SSO', slug: 'corp' }, { id: 'p-other', name: 'Other IdP', slug: 'other' }];
const CORP_IDENTITY = { id: 'i1', provider_name: 'Corp SSO', provider_slug: 'corp', email: 'me@corp.example.invalid', issuer: 'https://corp.example.invalid' };
const SIGN_IN_WITH_CORP = 'a[href="/auth/oidc/corp/start?action=reauth"]';
const corp = { providers: [{ slug: 'corp', name: 'Corp SSO' }] };

describe('linking an SSO identity asks for a confirmation first (#714)', () => {
  const posted = [];    // bodies sent to POST /auth/oidc/link-confirm
  const navigated = []; // where the browser was sent afterwards
  let answer;           // what the server says to a confirmation: resolves, or throws its refusal
  let root;

  before(() => {
    api.oidc.getProviders = async () => ({ providers: PROVIDERS });
    api.oidc.confirmLink = async (body) => { posted.push(body); return answer(body); };
  });
  afterEach(() => React.act(async () => root.unmount()));

  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  async function type(input, text) {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  const buttons = (text) => [...document.querySelectorAll('button')].filter(b => b.textContent === text);
  const linkButton = () => {
    const [button] = buttons('admin.security.ssoLink');
    assert.ok(button, 'the section offers to link the provider not yet linked');
    return button;
  };
  const continueButton = () => buttons('admin.security.ssoLinkContinue')[0];
  const passwordField = () => document.querySelector('input[type="password"]');
  const codeField = () => document.querySelector('input[inputmode="numeric"]');
  const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? '';

  // The section as the server answers for this account: `reauth`, and for an account without
  // password sign-in the providers it can confirm with and until when the last sign-in counts.
  async function render(identitiesReply) {
    posted.length = 0;
    navigated.length = 0;
    answer = async () => ({ ok: true });
    api.oidc.getIdentities = async () => ({ identities: [CORP_IDENTITY], ...identitiesReply });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => {
      root.render(React.createElement(LinkedIdentitiesSection, { navigate: (url) => navigated.push(url) }));
    });
  }

  test('a password account: the password is checked before the browser goes to the provider', async () => {
    await render({ reauth: 'password' });
    await click(linkButton());
    assert.deepEqual(navigated, [], 'the click alone sends nothing to the provider');
    assert.deepEqual(posted, []);
    assert.ok(passwordField(), 'the section asks for the password');
    assert.equal(continueButton().disabled, true, 'nothing to check yet');

    await type(passwordField(), 'hunter2');
    assert.equal(continueButton().disabled, false);
    await click(continueButton());

    assert.deepEqual(posted, [{ password: 'hunter2' }]);
    assert.deepEqual(navigated, ['/auth/oidc/other/start?action=link']);
  });

  test('a refused password is shown, cleared and asked for again; the browser stays', async () => {
    await render({ reauth: 'password' });
    answer = async () => { throw Object.assign(new Error('Incorrect password'), { status: 400 }); };
    await click(linkButton());
    await type(passwordField(), 'wrong');
    await click(continueButton());

    assert.equal(alertText(), 'Incorrect password');
    assert.equal(passwordField().value, '');
    assert.equal(continueButton().disabled, true, 'the password is typed again, not re-sent');
    assert.deepEqual(navigated, []);
  });

  test('a two-factor account: its current code, six digits', async () => {
    await render({ reauth: 'totp' });
    await click(linkButton());
    assert.equal(passwordField(), null, 'not the password');
    assert.ok(codeField(), 'the section asks for the code');

    await type(codeField(), '12345');
    assert.equal(continueButton().disabled, true, 'a code has six digits');
    await type(codeField(), '123456');
    await click(continueButton());

    assert.deepEqual(posted, [{ totpCode: '123456' }]);
    assert.deepEqual(navigated, ['/auth/oidc/other/start?action=link']);
  });

  test('an account without password sign-in: a fresh sign-in through a provider it has', async () => {
    await render({ reauth: 'oidc', oidc: { ...corp, confirmedUntil: null } });
    await click(linkButton());

    assert.deepEqual(posted, [], 'nothing to check without a sign-in');
    assert.deepEqual(navigated, []);
    assert.equal(continueButton(), undefined, 'nothing to type');
    const signIn = document.querySelector(SIGN_IN_WITH_CORP);
    assert.ok(signIn, 'the section sends the user to sign in again at the provider they have');
    assert.equal(signIn.textContent, 'admin.security.ssoLinkConfirmOidcButton');
  });

  test('back from that sign-in, the link goes straight on with it', async () => {
    await render({ reauth: 'oidc', oidc: { ...corp, confirmedUntil: new Date(Date.now() + 9 * 60_000).toISOString() } });
    await click(linkButton());

    assert.deepEqual(posted, [{}]);
    assert.deepEqual(navigated, ['/auth/oidc/other/start?action=link']);
  });

  test('a sign-in that lapsed since the page loaded: the refusal is shown with the way to sign in again', async () => {
    await render({ reauth: 'oidc', oidc: { ...corp, confirmedUntil: new Date(Date.now() + 60_000).toISOString() } });
    answer = async () => { throw Object.assign(new Error('Confirm through single sign-on first'), { status: 400 }); };
    await click(linkButton());

    assert.equal(alertText(), 'Confirm through single sign-on first');
    assert.ok(document.querySelector(SIGN_IN_WITH_CORP));
    assert.deepEqual(navigated, []);
  });

  test('two-factor required and not set up yet: told to set it up, nothing sent', async () => {
    await render({ reauth: 'totpSetup' });
    await click(linkButton());

    assert.ok(document.body.textContent.includes('admin.security.ssoLinkConfirmTotpSetup'));
    assert.equal(continueButton(), undefined);
    assert.deepEqual(posted, []);
    assert.deepEqual(navigated, []);
  });
});
