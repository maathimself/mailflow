// Render test for the account form's automatic Cc and Bcc lists (#491).
//
// The parsing is unit-tested in utils/autoRecipients.test.js. What only a render shows is the
// wiring: the fields show the saved lists, and Save sends both of them. A list the user did not
// touch has to go back as saved, or every unrelated edit, such as a new colour, would clear it.
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

const ACCOUNT = {
  id: 'acct', name: 'Work', email_address: 'me@example.invalid', color: '#6366f1',
  imap_host: 'imap.example.invalid', imap_port: 993, auth_user: 'me@example.invalid',
  smtp_host: 'smtp.example.invalid', smtp_port: 587, smtp_tls: 'STARTTLS',
  auto_cc_addresses: ['boss@example.invalid'], auto_bcc_addresses: ['me@example.invalid'],
};

describe('account form: automatic Cc and Bcc (#491)', () => {
  const sent = [];
  let reply; // what the stubbed PUT /accounts/:id does with each request
  let root;

  before(() => {
    api.admin.getSettings = async () => ({ settings: {} });
    api.getUnreadCounts = async () => ({});
    api.updateAccount = async (id, updates) => { sent.push({ id, updates }); return reply(updates); };
  });
  afterEach(() => React.act(async () => root.unmount()));

  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  const field = (placeholder) => {
    const input = document.querySelector(`input[placeholder="${placeholder}"]`);
    assert.ok(input, `the form has a ${placeholder} field`);
    return input;
  };
  async function type(input, text) {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  const save = () => click([...document.querySelectorAll('button')].find(b => b.textContent === 'admin.accounts.saveChanges'));

  // Settings > Accounts > Edit, for an account that already has both lists saved.
  async function openEdit() {
    sent.length = 0;
    useStore.setState({ user: { id: 'u1' }, accounts: [ACCOUNT], adminTab: 'accounts' });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(AdminPanel)); });
    await click(document.querySelector('button[title="common.edit"]'));
  }

  test('Save sends the edited list parsed and the untouched list as saved', async () => {
    reply = (updates) => ({ ...ACCOUNT, ...updates });
    await openEdit();
    assert.equal(field('compose.ccPh').value, 'boss@example.invalid', 'the saved Cc list is shown');
    assert.equal(field('compose.bccPh').value, 'me@example.invalid', 'the saved Bcc list is shown');

    await type(field('compose.bccPh'), 'me@example.invalid; archive@example.invalid,');
    await save();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'acct');
    assert.deepEqual(sent[0].updates.auto_cc_addresses, ['boss@example.invalid']);
    assert.deepEqual(sent[0].updates.auto_bcc_addresses, ['me@example.invalid', 'archive@example.invalid']);
  });

  test('an emptied field stays empty and Save clears that list', async () => {
    reply = (updates) => ({ ...ACCOUNT, ...updates });
    await openEdit();
    await type(field('compose.ccPh'), '');
    assert.equal(field('compose.ccPh').value, '', 'the field does not fall back to the saved list');

    await save();

    assert.deepEqual(sent[0].updates.auto_cc_addresses, []);
    assert.deepEqual(sent[0].updates.auto_bcc_addresses, ['me@example.invalid']);
  });

  test('a typed Cc list is saved parsed, and an emptied Bcc field stays empty and clears that list', async () => {
    reply = (updates) => ({ ...ACCOUNT, ...updates });
    await openEdit();
    await type(field('compose.ccPh'), 'boss@example.invalid, cfo@example.invalid');
    await type(field('compose.bccPh'), '');
    assert.equal(field('compose.bccPh').value, '', 'the field does not fall back to the saved list');

    await save();

    assert.deepEqual(sent[0].updates.auto_cc_addresses, ['boss@example.invalid', 'cfo@example.invalid']);
    assert.deepEqual(sent[0].updates.auto_bcc_addresses, []);
  });

  test('a list the server rejects shows its error, and the typed text stays', async () => {
    const error = 'Automatic Bcc: "me" is not a single email address (use name@example.com)';
    reply = () => { throw new Error(error); };
    await openEdit();
    await type(field('compose.bccPh'), 'me');
    await save();

    assert.equal(sent.length, 1);
    assert.ok(document.body.textContent.includes(error), 'the server error is shown in the form');
    assert.equal(field('compose.bccPh').value, 'me');
  });
});
