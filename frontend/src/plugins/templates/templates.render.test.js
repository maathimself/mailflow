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
const TemplatesSettings = (await import('./TemplatesSettings.jsx')).default;
const ComposeModal = (await import('../../components/ComposeModal.jsx')).default;

const TEMPLATE = { id: 'template-1', name: 'Welcome', to: ['BOB@example.com', 'Alice <alice@example.com>'], cc: ['team@example.com'], bcc: ['private@example.com'], subject: 'Welcome aboard', body: '<p><strong>Template content</strong></p><script>alert(1)</script>' };
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
  api.put = async (path, value) => { templates = templates.map(template => path.endsWith(template.id) ? value : template); return value; };
  api.delete = async path => { templates = templates.filter(template => !path.endsWith(template.id)); };
  api.saveDraft = async () => ({ uid: 8, folder: 'Drafts' });
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0 });
  HTMLElement.prototype.scrollIntoView = () => {};
});
beforeEach(() => { window.innerWidth = 1024; });
afterEach(async () => { if (root) { await React.act(async () => root.unmount()); root = null; } });
after(() => dom.window.close());

describe('Templates plugin', () => {
  async function editContent() {
    templates = [];
    await render(React.createElement(TemplatesSettings));
    await click(textButton('templates.new'));
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => {
      editor.commands.setContent('<p>Before After</p>');
      editor.commands.setTextSelection(8);
    });
    return editor;
  }

  test('variable modal lists every requested group and inserts the chosen token at the saved caret', async () => {
    const editor = await editContent();
    await click(document.querySelector('[aria-label="templates.variables.insert"]'));
    const modal = document.querySelector('[aria-label="templates.variables.insert"][role="dialog"]');
    assert.ok(modal, 'opens the variable modal');
    assert.deepEqual([...modal.querySelectorAll('h3')].map(heading => heading.textContent), [
      'templates.variables.groups.date', 'templates.variables.groups.contact', 'templates.variables.groups.address',
      'templates.variables.groups.email', 'templates.variables.groups.phone',
    ]);
    assert.equal(modal.querySelectorAll('input[type="radio"]').length, 22);
    const headers = [...modal.querySelectorAll('.template-variable-header')];
    assert.deepEqual(headers.map(header => header.getAttribute('aria-expanded')), ['true', 'false', 'false', 'false', 'false']);
    await click(headers[1]);
    assert.deepEqual(headers.map(header => header.getAttribute('aria-expanded')), ['false', 'true', 'false', 'false', 'false']);
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
    await click([...document.querySelectorAll('.template-variable-header')][2]);
    await click(document.querySelector('input[value="address.homeInline"]'));
    await click(document.querySelector('[data-action="insert-variable"]'));
    assert.equal(source.value, '<p>Before {{ address.homeInline }}After</p>');
    source.setSelectionRange(10, 10);
    await click(document.querySelector('[aria-label="templates.variables.placeholder"]'));
    assert.equal(source.value, '<p>Before {{ add placeholder }}{{ address.homeInline }}After</p>');
  });

  test('settings and composer contributions are gated by activation', async () => {
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
    assert.match(document.getElementById('root').textContent, /mail:templates/);
    assert.ok(document.querySelector('.insert-template-button'));
  });

  test('creates, edits and deletes templates with the real composer editor', async () => {
    templates = [];
    await render(React.createElement(TemplatesSettings));
    await click(textButton('templates.new'));
    const fields = [...document.querySelectorAll('.template-field input')];
    await input(fields[0], 'Welcome');
    await input(fields[1], 'Alice <alice@example.com>, bob@example.com');
    await input(fields[2], 'team@example.com');
    await input(fields[3], 'private@example.com');
    await input(fields[4], 'Hello');
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => editor.commands.setContent('<p><strong>Hello world</strong></p>'));
    await click(textButton('common.save'));
    assert.equal(templates.length, 1);
    assert.deepEqual(templates[0].to, ['Alice <alice@example.com>', 'bob@example.com']);
    assert.deepEqual(templates[0].cc, ['team@example.com']);
    assert.deepEqual(templates[0].bcc, ['private@example.com']);
    assert.match(templates[0].body, /<strong>Hello world<\/strong>/);
    await click(textButton('common.edit'));
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
        if (mode === 'mobile') {
          const more = document.querySelector('[title="compose.toolbar.moreFormatting"]');
          await React.act(async () => more.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
        }
        if (mode === 'HTML source') {
          const source = document.querySelector('[title="Edit HTML source"]');
          await React.act(async () => source.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
        } else {
          const editor = document.querySelector('.ProseMirror').editor;
          await React.act(async () => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
        }
      }
      const button = document.querySelector('.insert-template-button');
      assert.ok(button);
      await click(button);
      await click(document.querySelector('.template-choice'));
      assert.ok(!document.querySelector('.template-picker'), document.querySelector('.template-picker')?.textContent);
      if (plaintextEmail || mode === 'HTML source') {
        const text = [...document.querySelectorAll('textarea')].find(element => element.value.includes('Existing text'));
        assert.match(text.value, /Template content/);
        assert.doesNotMatch(text.value, /alert\(1\)/);
        if (plaintextEmail) assert.doesNotMatch(text.value, /<strong>/);
        else assert.match(text.value, /<strong>Template content<\/strong>/);
      } else {
        const html = document.querySelector('.ProseMirror').editor.getHTML();
        assert.match(html, /Existing text/); assert.match(html, /<strong>Template content<\/strong>/);
        assert.doesNotMatch(html, /script|alert\(1\)/);
        assert.ok(html.indexOf('Template content') > html.indexOf('Existing text'), 'inserts at the saved caret');
      }
      const subject = document.querySelector(mode === 'mobile' ? 'input[placeholder="compose.subjectPh"]' : 'input[placeholder="compose.subject"]');
      assert.equal(subject.value, plaintextEmail ? 'Welcome aboard' : 'Keep my subject');
      assert.match(document.getElementById('root').textContent, /alice@example.com/);
      assert.match(document.getElementById('root').textContent, /team@example.com/);
      assert.match(document.getElementById('root').textContent, /private@example.com/);
      assert.doesNotMatch(document.getElementById('root').textContent, /BOB@example.com/);
    });
  }
});

