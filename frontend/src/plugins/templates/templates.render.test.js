import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
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
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
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
  window: dom.window, document: dom.window.document,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { api } = await import('../../utils/api.js');
await import('./index.jsx');
const { PluginSlot, usePluginCollected } = await import('../PluginSlot.jsx');
const TemplateLibrary = (await import('./TemplateLibrary.jsx')).default;
const { default: ComposeModal, RichToolbar, createComposeExtensions } = await import('../../components/ComposeModal.jsx');
const { Editor } = await import('@tiptap/core');

const TEMPLATE = { id: 'template-1', name: 'Welcome', to: ['BOB@example.com', 'Alice <alice@example.com>'], cc: ['team@example.com'], bcc: ['private@example.com'], subject: 'Welcome {{ contact.givenName }}', body: '<p><strong>Template content {{ contact.givenName }} {{ date.month }}</strong></p><script>alert(1)</script>' };
let root;
let templates;
async function render(component) {
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(component));
  await React.act(async () => {});
}
async function click(button) {
  assert.ok(button, 'button exists');
  await React.act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}
async function input(element, value) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
function textButton(text) { return [...document.querySelectorAll('button')].find(button => button.textContent === text); }

before(() => {
  api.get = async path => {
    if (path === '/templates') return templates.map(({ body: _body, ...template }) => { void _body; return template; });
    if (path.startsWith('/templates/')) return templates.find(template => path.endsWith(template.id));
    return [];
  };
  api.post = async (_path, value) => { const saved = { ...value, id: 'new-template' }; templates.push(saved); return saved; };
  api.put = async (path, value) => { const saved = { ...value, id: path.split('/').pop() }; templates = templates.map(template => path.endsWith(template.id) ? saved : template); return saved; };
  api.delete = async path => { templates = templates.filter(template => !path.endsWith(template.id)); };
  api.getContacts = async () => ({ contacts: [{ primary_email: 'bob@example.com', first_name: 'Bob', last_name: 'Jones', display_name: 'Bob Jones' }] });
  api.saveDraft = async () => ({ uid: 8, folder: 'Drafts' });
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0 });
  HTMLElement.prototype.scrollIntoView = () => {};
});
beforeEach(() => { window.innerWidth = 1024; });
afterEach(async () => { if (root) { await React.act(async () => root.unmount()); root = null; } });
after(() => dom.window.close());

describe('Templates plugin', () => {
  for (const isMobile of [false, true]) {
    test(`extraControls alone are reachable once through More on ${isMobile ? 'mobile' : 'desktop'}`, async () => {
      const editor = new Editor({ extensions: createComposeExtensions(''), content: '<p>Text</p>' });
      let clicked = 0;
      try {
        await render(React.createElement(RichToolbar, { editor, isMobile,
          extraControls: React.createElement('button', { 'data-extra-control': true, onClick: () => clicked++ }, 'Extra') }));
        assert.equal(document.querySelectorAll('[data-extra-control]').length, 0, 'extra controls stay out of the main row');
        const more = document.querySelector(isMobile ? '[title="compose.toolbar.moreFormatting"]' : '[title="message.more"]');
        assert.ok(more, 'More is available even without HTML or AI controls');
        await React.act(async () => more.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
        assert.equal(document.querySelectorAll('[data-extra-control]').length, 1);
        await click(document.querySelector('[data-extra-control]'));
        assert.equal(clicked, 1);
        await React.act(async () => more.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
        assert.equal(document.querySelectorAll('[data-extra-control]').length, 0);
      } finally {
        await React.act(async () => root.unmount()); root = null;
        editor.destroy();
      }
    });
  }

  async function editContent() {
    templates = [];
    await render(React.createElement(TemplateLibrary));
    await click(textButton('templates.new'));
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => {
      editor.commands.setContent('<p>Before After</p>');
      editor.commands.setTextSelection(8);
    });
    const more = document.querySelector('[title="message.more"]');
    await React.act(async () => more.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
    return editor;
  }

  test('variable modal lists every requested group and inserts the chosen token at the saved caret', async () => {
    const editor = await editContent();
    await click(document.querySelector('[aria-label="templates.variables.insert"]'));
    const modal = document.querySelector('[aria-label="templates.variables.insert"][role="dialog"]');
    assert.ok(modal, 'opens the variable modal');
    assert.deepEqual([...modal.querySelectorAll('h3')].map(heading => heading.textContent), [
      'templates.variables.groups.date', 'templates.variables.groups.contact',
    ]);
    assert.equal(modal.querySelectorAll('input[type="radio"]').length, 7);
    const headers = [...modal.querySelectorAll('.template-variable-header')];
    assert.deepEqual(headers.map(header => header.getAttribute('aria-expanded')), ['true', 'false']);
    await click(headers[1]);
    assert.deepEqual(headers.map(header => header.getAttribute('aria-expanded')), ['false', 'true']);
    assert.ok(modal.querySelector('input[value="date.date"]').closest('[hidden]'));
    await click(headers[1]);
    assert.ok(headers.every(header => header.getAttribute('aria-expanded') === 'false'));
    await click(headers[1]);
    await click(modal.querySelector('input[value="contact.fullName"]'));
    assert.match(modal.querySelector('output').textContent, /\{\{ contact.fullName \}\}/);
    await click(modal.querySelector('[data-action="insert-variable"]'));
    assert.ok(!document.querySelector('[role="dialog"]'));
    assert.equal(editor.getText(), 'Before {{ contact.fullName }}After');
    await input(document.querySelector('.template-field input'), 'With variables');
    await click(textButton('common.save'));
    assert.match(templates[0].body, /\{\{ contact.fullName \}\}/);
  });

  test('placeholder inserts the exact text over the selection as one undoable edit', async () => {
    const editor = await editContent();
    await React.act(async () => editor.commands.setTextSelection({ from: 8, to: 13 }));
    await click(document.querySelector('[aria-label="templates.variables.placeholder"]'));
    assert.equal(editor.getText(), 'Before {{ add placeholder }}');
    await React.act(async () => editor.commands.undo());
    assert.equal(editor.getText(), 'Before After');
  });

  test('variable modal cancels with Escape and keeps focus inside while open', async () => {
    const editor = await editContent();
    const button = document.querySelector('[aria-label="templates.variables.insert"]');
    await click(button);
    const modal = document.querySelector('[role="dialog"]');
    assert.ok(modal.contains(document.activeElement));
    const cancel = [...modal.querySelectorAll('button')].find(element => element.textContent === 'common.cancel');
    cancel.focus();
    await React.act(async () => cancel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    assert.equal(document.activeElement, modal.querySelector('.template-variable-header'));
    await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    assert.equal(document.activeElement, cancel);
    await React.act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.ok(!document.querySelector('[role="dialog"]'));
    assert.equal(editor.getText(), 'Before After');
    assert.equal(document.activeElement, button);
  });

  test('variables and placeholders also insert at the cursor in HTML source mode', async () => {
    await editContent();
    const sourceButton = document.querySelector('[title="Edit HTML source"]');
    await React.act(async () => sourceButton.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
    const source = document.querySelector('textarea[aria-label="signatureEditor.sourceMode"]');
    source.focus(); source.setSelectionRange(10, 10);
    await click(document.querySelector('[aria-label="templates.variables.insert"]'));
    await click([...document.querySelectorAll('.template-variable-header')][1]);
    await click(document.querySelector('input[value="contact.givenName"]'));
    await click(document.querySelector('[data-action="insert-variable"]'));
    assert.equal(source.value, '<p>Before {{ contact.givenName }}After</p>');
    source.setSelectionRange(10, 10);
    await click(document.querySelector('[aria-label="templates.variables.placeholder"]'));
    assert.equal(source.value, '<p>Before {{ add placeholder }}{{ contact.givenName }}After</p>');
  });

  test('composer contributions are gated by activation and add no Settings page', async () => {
    function Contributions() {
      const tabs = usePluginCollected('settings-tabs', {});
      return React.createElement('div', null, tabs.map(tab => React.createElement('span', { key: tab.id }, `${tab.group}:${tab.id}`)),
        React.createElement(PluginSlot, { name: 'compose-actions', ctx: {} }));
    }
    useStore.setState({ enabledPlugins: [] });
    await render(React.createElement(Contributions));
    assert.equal(document.querySelector('.insert-template-button'), null);
    assert.equal(document.getElementById('root').textContent, '');
    await React.act(async () => useStore.setState({ enabledPlugins: ['templates'] }));
    assert.doesNotMatch(document.getElementById('root').textContent, /mail:templates/);
    assert.ok(document.querySelector('.insert-template-button'));
  });

  test('saves and edits a selected greeting from the composer without changing the message', async () => {
    templates = [];
    useStore.setState({ user: { id: 'u1' }, enabledPlugins: ['templates'], plaintextEmail: false,
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.com', name: 'Me' }],
      composing: false, composeData: null, prepareComposeSwitch: null });
    useStore.getState().openCompose({ accountId: 'acct', to: ['Bob <bob@example.com>'], subject: 'Keep subject', body: '<p>Hello Bob</p><p>Message body</p>', bodyIsHtml: true });
    await render(React.createElement(ComposeModal));
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => editor.commands.setTextSelection({ from: 1, to: 10 }));
    await React.act(async () => document.querySelector('[title="message.more"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
    await click(document.querySelector('.insert-template-button'));
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await click(textButton('templates.saveContent'));
    await input(document.querySelector('.template-field input'), 'Greeting');
    await click(textButton('common.save'));
    assert.match(templates[0].body, /Hello Bob/);
    assert.doesNotMatch(templates[0].body, /Message body/);
    assert.equal(templates[0].subject, 'Keep subject');
    await click(textButton('common.edit'));
    await input(document.querySelector('.template-field input'), 'Personal greeting');
    await click(textButton('common.save'));
    assert.equal(templates[0].name, 'Personal greeting');
    assert.equal(editor.getText(), 'Hello Bob\n\nMessage body');
    assert.equal(document.querySelector('input[placeholder="compose.subject"]').value, 'Keep subject');
  });

  for (const pending of ['template', 'contact']) {
    test(`closing the library during a pending ${pending} lookup never inserts later`, async () => {
      templates = [TEMPLATE];
      useStore.setState({ enabledPlugins: ['templates'] });
      const originalGet = api.get, originalContacts = api.getContacts;
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      const inserted = [];
      const context = { sessionId: 'session-1', disabled: false, captureSelection: () => ({}), getContent: () => '',
        getRecipients: () => ['bob@example.com'], insertContent: html => inserted.push(html) };
      if (pending === 'template') api.get = path => path.endsWith('/template-1') ? blocked : originalGet(path);
      else api.getContacts = () => blocked;
      try {
        await render(React.createElement(PluginSlot, { name: 'compose-actions', ctx: context }));
        await click(document.querySelector('.insert-template-button'));
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        await click(document.querySelector('.template-choice'));
        await React.act(async () => document.querySelector('.template-variable-backdrop').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
        await React.act(async () => release(pending === 'template' ? TEMPLATE : { contacts: [] }));
        assert.deepEqual(inserted, []);
      } finally { api.get = originalGet; api.getContacts = originalContacts; }
    });
  }

  test('deferred lookup preserves edits made to the body and subject while it is pending', async () => {
    const original = api.getContacts;
    let release;
    api.getContacts = () => new Promise(resolve => { release = resolve; });
    try {
      useStore.setState({ user: { id: 'u1' }, enabledPlugins: ['templates'], plaintextEmail: false,
        accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.com', name: 'Me' }],
        composing: false, composeData: null, prepareComposeSwitch: null });
      useStore.getState().openCompose({ accountId: 'acct', to: [], subject: '{{ contact.givenName }}', body: '<p>{{ contact.givenName }} {{ contact.surname }}</p>', bodyIsHtml: true });
      await render(React.createElement(ComposeModal));
      const editor = document.querySelector('.ProseMirror').editor;
      const to = document.querySelector('input[placeholder="compose.toPh"]');
      await input(to, 'bob@example.com');
      await React.act(async () => to.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      assert.ok(release, 'starts a lookup after the address is committed');
      await React.act(async () => editor.commands.setContent('<p><strong>My greeting</strong> {{ contact.surname }}</p>'));
      const subject = document.querySelector('input[placeholder="compose.subject"]');
      await input(subject, 'My subject');
      await React.act(async () => subject.focus());
      await React.act(async () => release({ contacts: [{ primary_email: 'bob@example.com', first_name: 'Bob', last_name: 'Jones' }] }));
      assert.equal(subject.value, 'My subject');
      assert.match(editor.getHTML(), /<strong>My greeting<\/strong> Jones/);
      assert.equal(document.activeElement, subject, 'does not steal focus');
    } finally { api.getContacts = original; }
  });

  test('deferred results are ignored for a changed recipient and a disabled plugin', async () => {
    const original = api.getContacts;
    const pending = new Map();
    api.getContacts = ({ q }) => new Promise(resolve => pending.set(q, resolve));
    const applied = [];
    const context = address => ({ sessionId: 'test-session', disabled: false, editor: null,
      getRecipients: () => [address], getBody: () => '{{ contact.givenName }}', getSubject: () => '',
      transformContent: transforms => applied.push(transforms.text('{{ contact.givenName }}')) });
    try {
      useStore.setState({ enabledPlugins: ['templates'] });
      await render(React.createElement(PluginSlot, { name: 'compose-observers', ctx: context('bob@example.com') }));
      await React.act(async () => root.render(React.createElement(PluginSlot, { name: 'compose-observers', ctx: context('alice@example.com') })));
      await React.act(async () => pending.get('bob@example.com')({ contacts: [{ primary_email: 'bob@example.com', first_name: 'Bob' }] }));
      assert.deepEqual(applied, []);
      await React.act(async () => pending.get('alice@example.com')({ contacts: [{ primary_email: 'alice@example.com', first_name: 'Alice' }] }));
      assert.deepEqual(applied, ['Alice']);
      await React.act(async () => root.render(React.createElement(PluginSlot, { name: 'compose-observers', ctx: context('bob@example.com') })));
      await React.act(async () => useStore.setState({ enabledPlugins: [] }));
      await React.act(async () => pending.get('bob@example.com')({ contacts: [{ primary_email: 'bob@example.com', first_name: 'Bob' }] }));
      assert.deepEqual(applied, ['Alice']);
    } finally { api.getContacts = original; }
  });

  test('creates, edits and deletes templates with the real composer editor', async () => {
    templates = [];
    await render(React.createElement(TemplateLibrary));
    await click(textButton('templates.new'));
    const fields = [...document.querySelectorAll('.template-field input')];
    await input(fields[0], 'Welcome');
    assert.equal(fields.length, 2, 'snippets have a name, optional subject, and content');
    await input(fields[1], 'Welcome {{ contact.givenName }}');
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => editor.commands.setContent('<p><strong>Hello world</strong></p>'));
    await click(textButton('common.save'));
    assert.equal(templates.length, 1);
    assert.deepEqual(Object.keys(templates[0]).sort(), ['body', 'id', 'name', 'subject']);
    assert.equal(templates[0].subject, 'Welcome {{ contact.givenName }}');
    assert.match(templates[0].body, /<strong>Hello world<\/strong>/);
    await click(textButton('common.edit'));
    assert.equal(document.querySelectorAll('.template-field input')[1].value, 'Welcome {{ contact.givenName }}');
    assert.match(document.querySelector('.ProseMirror').editor.getHTML(), /Hello world/);
    await input(document.querySelector('.template-field input'), 'Updated');
    await click(textButton('common.save'));
    assert.equal(templates[0].name, 'Updated');
    await click(textButton('common.delete'));
    assert.equal(templates.length, 1, 'delete first asks for confirmation');
    await click(textButton('common.delete'));
    assert.equal(templates.length, 0);
  });

  for (const mode of ['rich text', 'plain text', 'HTML source', 'mobile']) {
    test(`fills remaining name tokens when To is entered last in ${mode}`, async () => {
      const plaintextEmail = mode === 'plain text';
      window.innerWidth = mode === 'mobile' ? 540 : 1024;
      templates = [TEMPLATE];
      useStore.setState({ user: { id: 'u1' }, enabledPlugins: ['templates'], plaintextEmail,
        accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.com', name: 'Me' }],
        composing: false, composeData: null, prepareComposeSwitch: null });
      useStore.getState().openCompose({ accountId: 'acct', to: [], subject: '', body: '', bodyIsHtml: !plaintextEmail });
      await render(React.createElement(ComposeModal));
      const richEditor = document.querySelector('.ProseMirror')?.editor;
      const moreSelector = mode === 'mobile' ? '[title="compose.toolbar.moreFormatting"]' : '[title="message.more"]';
      if (!plaintextEmail) {
        await React.act(async () => document.querySelector(moreSelector).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
        if (mode === 'HTML source') await React.act(async () => document.querySelector('[title="Edit HTML source"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
      }
      await click(document.querySelector('.insert-template-button'));
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      await click(document.querySelector('.template-choice'));
      const subject = document.querySelector(mode === 'mobile' ? 'input[placeholder="compose.subjectPh"]' : 'input[placeholder="compose.subject"]');
      assert.match(subject.value, /\{\{ contact.givenName \}\}/);
      // The observer must keep working after More is collapsed.
      if (!plaintextEmail) await React.act(async () => document.querySelector(moreSelector).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
      if (!plaintextEmail && mode !== 'HTML source') await React.act(async () => richEditor.commands.insertContent(' Manual edit'));
      const to = document.querySelector('input[placeholder="compose.toPh"]');
      await input(to, 'bob@example.com');
      assert.match(subject.value, /\{\{ contact.givenName \}\}/, 'typing an incomplete recipient must not fill names');
      await React.act(async () => to.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      await React.act(async () => {});
      assert.equal(subject.value, 'Welcome Bob');
      const content = plaintextEmail || mode === 'HTML source' ? document.querySelector('textarea').value : richEditor.getHTML();
      assert.match(content, /Template content Bob /);
      assert.doesNotMatch(content, /\{\{ contact.givenName \}\}/);
      if (!plaintextEmail && mode !== 'HTML source') assert.match(content, /Manual edit/);
      if (mode === 'rich text') {
        await React.act(async () => richEditor.commands.undo());
        assert.match(richEditor.getHTML(), /\{\{ contact.givenName \}\}/, 'Undo is not immediately filled again');
        assert.match(richEditor.getHTML(), /Manual edit/);
      }
    });

    test(`inserts into ${mode} without overwriting existing content`, async () => {
      const plaintextEmail = mode === 'plain text';
      window.innerWidth = mode === 'mobile' ? 540 : 1024;
      templates = [TEMPLATE];
      useStore.setState({ user: { id: 'u1' }, enabledPlugins: ['templates'], plaintextEmail,
        accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.com', name: 'Me' }],
        composing: false, composeData: null, prepareComposeSwitch: null });
      useStore.getState().openCompose({ accountId: 'acct', to: ['Bob <bob@example.com>'], subject: plaintextEmail ? '' : 'Keep my subject', body: plaintextEmail ? 'Existing text' : '<p>Existing text</p>', bodyIsHtml: !plaintextEmail });
      await render(React.createElement(ComposeModal));
      if (!plaintextEmail) {
        const more = document.querySelector(mode === 'mobile' ? '[title="compose.toolbar.moreFormatting"]' : '[title="message.more"]');
        await React.act(async () => more.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
        if (mode === 'HTML source') {
          const source = document.querySelector('[title="Edit HTML source"]');
          await React.act(async () => source.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
          const textarea = [...document.querySelectorAll('textarea')].find(element => element.value.includes('Existing text'));
          textarea.setSelectionRange(0, 0);
        } else {
          const editor = document.querySelector('.ProseMirror').editor;
          await React.act(async () => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
        }
      }
      const button = document.querySelector('.insert-template-button');
      assert.ok(button);
      await click(button);
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      await click(document.querySelector('.template-choice'));
      assert.ok(!document.querySelector('.template-library-dialog'));
      if (plaintextEmail || mode === 'HTML source') {
        const text = [...document.querySelectorAll('textarea')].find(element => element.value.includes('Existing text'));
        assert.match(text.value, /Template content/);
        assert.doesNotMatch(text.value, /alert\(1\)/);
        if (plaintextEmail) assert.doesNotMatch(text.value, /<strong>/);
        else {
          assert.match(text.value, /<strong>Template content Bob /);
          assert.ok(text.value.indexOf('Template content') < text.value.indexOf('Existing text'), 'uses the source cursor');
        }
      } else {
        const html = document.querySelector('.ProseMirror').editor.getHTML();
        assert.match(html, /Existing text/); assert.match(html, /<strong>Template content Bob /);
        assert.doesNotMatch(html, /script|alert\(1\)/);
        assert.ok(html.indexOf('Template content') > html.indexOf('Existing text'), 'inserts at the saved caret');
      }
      const subject = document.querySelector(mode === 'mobile' ? 'input[placeholder="compose.subjectPh"]' : 'input[placeholder="compose.subject"]');
      assert.equal(subject.value, plaintextEmail ? 'Welcome Bob' : 'Keep my subject');
      assert.doesNotMatch(document.getElementById('root').textContent, /alice@example.com/);
      assert.doesNotMatch(document.getElementById('root').textContent, /team@example.com/);
      assert.doesNotMatch(document.getElementById('root').textContent, /private@example.com/);
      assert.doesNotMatch(document.getElementById('root').textContent, /BOB@example.com/);
    });
  }
});
