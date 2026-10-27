// Render test for ComposeModal's draft autosave (#413).
//
// The autosave rules are unit-tested in utils/draftAutosave.test.js, but whether a draft counts
// as dirty depends on the live TipTap editor, which rewrites the HTML it loads. That only shows
// up with the real component mounted, so this mounts it the same way the other render tests do.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

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
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  requestAnimationFrame: callback => setTimeout(callback, 0),
  cancelAnimationFrame: id => clearTimeout(id),
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// jsdom has no text layout; editor focus and table insertion ask for range geometry.
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

// A draft as Gmail saves it. TipTap loads this as <p> paragraphs, so its getHTML() never
// matches the stored string even when nobody has touched it.
const GMAIL_DRAFT = '<div dir="ltr">Hi Bob,<div><br></div><div>The contract is attached.</div></div>';

const saved = [];

describe('composer context menu', () => {
  const clickAction = id => React.act(async () => {
    const button = document.querySelector(`.composer-context-menu button[data-action="${id}"]`);
    assert.ok(button, `${id} is available`);
    button.click();
  });
  const openMenu = target => React.act(async () => {
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  });
  const richTarget = () => document.querySelector('.ProseMirror');
  const select = (editor, from, to) => React.act(async () => { editor.commands.setTextSelection({ from, to }); });
  const clipboard = value => Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value });
  const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  after(() => {
    if (originalClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', originalClipboard);
    else delete globalThis.navigator.clipboard;
  });

  test('formats the original selection and Normal clears its formatting', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Hello world</p>' });
    try {
      const editor = richTarget().editor;
      await select(editor, 1, 6);
      await openMenu(richTarget());
      assert.equal(document.querySelector('[data-action="ai"]'), null);
      assert.equal(document.querySelector('[data-action="cut"]').disabled, false);
      await clickAction('format');
      await clickAction('bold');
      assert.match(editor.getHTML(), /<strong>Hello<\/strong> world/);
      await openMenu(richTarget());
      await clickAction('format');
      await clickAction('normal');
      assert.doesNotMatch(editor.getHTML(), /<strong>/);
      assert.equal(editor.getText(), 'Hello world');
    } finally { await close(); }
  });

  test('superscript, subscript, font size and indentation survive HTML parsing', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Hello world</p>' });
    try {
      const editor = richTarget().editor;
      await select(editor, 1, 6);
      for (const action of ['superscript', 'subscript', 'fontIncrease', 'indentIncrease']) {
        await openMenu(richTarget()); await clickAction('format'); await clickAction(action);
      }
      let html = editor.getHTML();
      assert.match(html, /<sub>/);
      assert.doesNotMatch(html, /<sup>/);
      assert.match(html, /font-size: 16px/);
      assert.match(html, /margin-left: 40px/);
      await React.act(async () => { editor.commands.setContent(html); });
      html = editor.getHTML();
      assert.match(html, /<sub>/);
      assert.match(html, /margin-left: 40px/);
      await select(editor, 1, 6);
      await openMenu(richTarget()); await clickAction('format'); await clickAction('indentDecrease');
      assert.doesNotMatch(editor.getHTML(), /margin-left: 40px/);
    } finally { await close(); }
  });

  test('list, justification and history actions execute editor commands', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Hello</p>' });
    try {
      const editor = richTarget().editor;
      await select(editor, 1, 6);
      await openMenu(richTarget()); await clickAction('format'); await clickAction('numbering');
      assert.match(editor.getHTML(), /<ol>/);
      await openMenu(richTarget()); await clickAction('justify'); await clickAction('align-center');
      assert.match(editor.getHTML(), /text-align: center/);
      await openMenu(richTarget()); await clickAction('undo');
      assert.doesNotMatch(editor.getHTML(), /text-align: center/);
      await openMenu(richTarget()); await clickAction('redo');
      assert.match(editor.getHTML(), /text-align: center/);
    } finally { await close(); }
  });

  test('Cut deletes only after copying succeeds', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Hello world</p>' });
    try {
      const editor = richTarget().editor;
      await select(editor, 1, 6);
      clipboard({ writeText: async () => { throw new Error('denied'); } });
      await openMenu(richTarget()); await clickAction('cut');
      assert.equal(editor.getText(), 'Hello world');
      const copied = [];
      clipboard({ writeText: async value => copied.push(value) });
      await openMenu(richTarget()); await clickAction('cut');
      assert.deepEqual(copied, ['Hello']);
      assert.equal(editor.getText(), ' world');
    } finally { await close(); }
  });

  test('Paste as Text and Paste as Quote keep markup literal', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
    try {
      const editor = richTarget().editor;
      clipboard({ readText: async () => '<b>Literal</b>\nSecond line' });
      await select(editor, 1, 9);
      await openMenu(richTarget()); await clickAction('pasteText');
      assert.equal(editor.getText({ blockSeparator: '\n' }), '<b>Literal</b>\nSecond line');
      assert.doesNotMatch(editor.getHTML(), /<b>|<strong>/);
      await React.act(async () => { editor.commands.selectAll(); });
      await openMenu(richTarget()); await clickAction('pasteQuote');
      assert.match(editor.getHTML(), /<blockquote>/);
      assert.match(editor.getHTML(), /&lt;b&gt;Literal&lt;\/b&gt;/);
    } finally { await close(); }
  });

  test('Copy preserves rich formatting when the clipboard supports HTML', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p><strong>Hello</strong> world</p>' });
    const originalItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
    try {
      Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: class {
        constructor(data) { this.data = data; }
      } });
      const copied = [];
      clipboard({ write: async values => copied.push(...values) });
      await select(richTarget().editor, 1, 6);
      await openMenu(richTarget()); await clickAction('copy');
      assert.equal(await copied[0].data['text/plain'].text(), 'Hello');
      assert.match(await copied[0].data['text/html'].text(), /<strong>Hello<\/strong>/);
      assert.equal(richTarget().editor.getText(), 'Hello world');
    } finally {
      if (originalItem) Object.defineProperty(globalThis, 'ClipboardItem', originalItem);
      else delete globalThis.ClipboardItem;
      await close();
    }
  });

  test('Insert uses the existing file, image and per-message signature controls', async () => {
    const accounts = useStore.getState().accounts;
    useStore.setState({ accounts: accounts.map(account => ({ ...account, signature: '<p>My signature</p>', signature_enabled: true })) });
    const close = await openDraft({ plaintextEmail: false, body: '<p>Hello</p>' });
    try {
      const opened = [];
      document.querySelector('input[type="file"][multiple]').click = () => opened.push('file');
      document.querySelector('input[type="file"][accept="image/*"]').click = () => opened.push('image');
      await openMenu(richTarget()); await clickAction('insert'); await clickAction('file');
      await openMenu(richTarget()); await clickAction('insert'); await clickAction('image');
      assert.deepEqual(opened, ['file', 'image']);
      await openMenu(richTarget()); await clickAction('insert'); await clickAction('signature');
      assert.equal(document.querySelector('button[aria-label="compose.insertSignature"]').getAttribute('aria-pressed'), 'false');
    } finally { await close(); useStore.setState({ accounts }); }
  });

  test('AI appears only when enabled and invokes the existing writing assistant', async () => {
    const realStatus = api.ai.status;
    const realChat = api.ai.chat;
    const requests = [];
    api.ai.status = async () => ({ enabled: true, features: { compose: true } });
    api.ai.chat = async messages => { requests.push(messages); return 'Improved'; };
    const close = await openDraft({ plaintextEmail: false, body: '<p>Hello</p>' });
    try {
      await openMenu(richTarget()); await clickAction('ai'); await clickAction('improve');
      assert.equal(requests.length, 1);
      assert.equal(requests[0][1].content, 'Hello');
      assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'compose.toolbar.aiApply'));
    } finally { await close(); api.ai.status = realStatus; api.ai.chat = realChat; }
  });

  test('rich paste is sanitized and an outstanding read cannot overwrite later edits', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
    try {
      const editor = richTarget().editor;
      clipboard({ read: async () => [{ types: ['text/html'], getType: async () => new Blob(['<p><strong>Safe</strong><script>alert(1)</script></p>']) }] });
      await select(editor, 1, 9);
      await openMenu(richTarget()); await clickAction('paste');
      assert.match(editor.getHTML(), /<strong>Safe<\/strong>/);
      assert.doesNotMatch(editor.getHTML(), /script|alert/);
      let finish;
      clipboard({ readText: () => new Promise(resolve => { finish = resolve; }) });
      await openMenu(richTarget()); await clickAction('pasteText');
      await React.act(async () => { editor.commands.insertContent('later'); });
      const later = editor.getHTML();
      await React.act(async () => { finish('stale clipboard'); });
      assert.equal(editor.getHTML(), later);
    } finally { await close(); }
  });

  test('Insert opens the existing table, link and typography pickers', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Hello</p>' });
    try {
      const editor = richTarget().editor;
      await select(editor, 1, 6);
      await openMenu(richTarget()); await clickAction('insert'); await clickAction('table');
      assert.equal(document.querySelectorAll('.table-insert-grid button').length, 64);
      await React.act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      await openMenu(richTarget()); await clickAction('insert'); await clickAction('link');
      assert.ok(document.querySelector('input[placeholder="https://..."]'));
      await openMenu(richTarget()); await clickAction('format'); await clickAction('font');
      assert.ok([...document.querySelectorAll('select')].some(select => [...select.options].some(option => option.textContent === 'compose.toolbar.fontDefault')));
      assert.deepEqual({ from: editor.state.selection.from, to: editor.state.selection.to }, { from: 1, to: 6 });
    } finally { await close(); }
  });

  test('plain-text paste, quote, undo and redo update the actual composer body', async () => {
    const close = await openDraft({ plaintextEmail: true, body: 'Hello world' });
    try {
      const target = document.querySelector('textarea[placeholder="compose.bodyPh"]');
      target.setSelectionRange(6, 11);
      clipboard({ readText: async () => 'quoted\ntext' });
      await openMenu(target);
      assert.equal(document.querySelector('[data-action="format"]').disabled, true);
      assert.equal(document.querySelector('[data-action="source"]').disabled, true);
      await clickAction('pasteQuote');
      assert.equal(target.value, 'Hello > quoted\n> text');
      await openMenu(target); await clickAction('undo');
      assert.equal(target.value, 'Hello world');
      await openMenu(target); await clickAction('redo');
      assert.equal(target.value, 'Hello > quoted\n> text');
      await hideTab();
      assert.equal(saved.at(-1).body, target.value);
    } finally { await close(); }
  });

  test('Source toggles HTML mode and offers text editing without rich formatting', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Original</p>' });
    try {
      await openMenu(richTarget()); await clickAction('source');
      const target = [...document.querySelectorAll('textarea')].find(el => el.value.includes('<p>Original</p>'));
      assert.ok(target);
      await openMenu(target);
      assert.equal(document.querySelector('[data-action="format"]').disabled, true);
      assert.equal(document.querySelector('[data-action="source"]').getAttribute('aria-checked'), 'true');
      await clickAction('selectAll');
      assert.equal(target.selectionEnd, target.value.length);
      clipboard({ readText: async () => '<p>Updated</p>' });
      await openMenu(target); await clickAction('pasteText');
      assert.equal(target.value, '<p>Updated</p>');
      await openMenu(target); await clickAction('source');
      assert.equal(richTarget().editor.getText(), 'Updated');
    } finally { await close(); }
  });

  test('keyboard submenus, Escape and outside dismissal preserve the draft', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Unchanged</p>' });
    try {
      await openMenu(richTarget());
      const format = document.querySelector('[data-action="format"]');
      await React.act(async () => { format.focus(); format.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
      assert.equal(document.activeElement.dataset.action, 'font');
      await React.act(async () => { document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
      assert.equal(document.activeElement, format);
      await React.act(async () => { format.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      assert.equal(document.querySelector('.composer-context-menu'), null);
      await openMenu(richTarget());
      await React.act(async () => { document.querySelector('.composer-context-scrim').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
      assert.equal(document.querySelector('.composer-context-menu'), null);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });
});

describe('table context menu', () => {
  const BODY = '<p>Before</p><table border="1" cellpadding="2" cellspacing="0"><tr><td>A</td><td>B</td><td>C</td></tr><tr><td>D</td><td>E</td><td>F</td></tr><tr><td>G</td><td>H</td><td>I</td></tr></table><p>After</p>';
  const info = editor => {
    let result;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'table' && !result) result = { node, pos, map: TableMap.get(node) };
    });
    return result;
  };
  const cell = (editor, row, col) => {
    const table = info(editor);
    const offset = table.map.map[row * table.map.width + col];
    return { node: table.node.nodeAt(offset), pos: table.pos + 1 + offset };
  };
  const selectCells = (editor, top, left, bottom = top, right = left) => React.act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cell(editor, top, left).pos, cell(editor, bottom, right).pos)));
  });
  const open = (editor, row = 0, col = 0) => React.act(async () => {
    const target = editor.view.nodeDOM(cell(editor, row, col).pos);
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  });
  const click = id => React.act(async () => {
    const button = document.querySelector(`.composer-context-menu [data-action="${id}"]`);
    assert.ok(button, `${id} exists`);
    assert.equal(button.disabled, false, `${id} is enabled`);
    button.click();
  });
  const action = async (editor, group, id, row = 0, col = 0) => {
    await open(editor, row, col); await click('table-menu');
    if (group) await click(group);
    await click(id);
  };
  const style = node => {
    const element = document.createElement('td'); element.style.cssText = node.attrs.style || ''; return element.style;
  };
  const valid = editor => editor.state.doc.descendants(node => {
    if (node.type.name === 'table') assert.equal(TableMap.get(node).problems, null, 'the table stays rectangular, including spans');
  });
  const field = (label, value) => React.act(async () => {
    const input = [...document.querySelectorAll('.table-insert-field')].find(el => el.querySelector('span').textContent === label).querySelector('input, select');
    const prototype = input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });

  test('Table appears immediately below Emoji only when the click is in a table', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await React.act(async () => {
        editor.commands.setTextSelection(1);
        editor.view.dom.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      assert.equal(document.querySelector('[data-action="table-menu"]'), null);
      await open(editor, 1, 1);
      const root = document.querySelector('.composer-context-menu');
      assert.deepEqual([...root.querySelectorAll('button')].slice(0, 2).map(button => button.dataset.action), ['emoji', 'table-menu']);
      assert.equal(editor.isActive('table'), true);
    } finally { await close(); }
  });

  test('re-entering a parent keeps its nested submenu mounted and preserves focus', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 0, 0);
      await open(editor); await click('table-menu'); await click('table-border');
      const panels = [...document.querySelectorAll('.composer-context-menu')];
      assert.equal(panels.length, 3);
      const leaf = document.querySelector('[data-action="border-inside"]');
      await React.act(async () => { leaf.focus(); });
      for (const id of ['table-menu', 'table-border', 'border-inside']) {
        await React.act(async () => {
          document.querySelector(`[data-action="${id}"]`).dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
        });
        assert.deepEqual([...document.querySelectorAll('.composer-context-menu')], panels, 'hovering the same branch must not remove its child panels');
        assert.equal(document.activeElement, leaf, 'hover updates must not move keyboard focus');
      }
    } finally { await close(); }
  });

  test('submenus are measured while hidden and open outside the parent panel border', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    const originalObserver = globalThis.ResizeObserver;
    const initialVisibility = [];
    globalThis.ResizeObserver = class {
      observe(element) { if (element.classList.contains('composer-context-menu')) initialVisibility.push(element.style.visibility); }
      disconnect() {}
    };
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 0, 0);
      await open(editor);
      const panel = document.querySelector('.composer-context-menu');
      panel.getBoundingClientRect = () => ({ left: 100, right: 332, top: 10, bottom: 400, width: 232, height: 390 });
      const trigger = document.querySelector('[data-action="table-menu"]');
      trigger.getBoundingClientRect = () => ({ left: 101, right: 331, top: 50, bottom: 75, width: 230, height: 25 });
      await React.act(async () => { trigger.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); });
      const child = document.querySelectorAll('.composer-context-menu')[1];
      assert.equal(child.style.left, '332px', 'the submenu clears the parent panel border');
      assert.equal(child.style.top, '50px');
      assert.equal(child.style.visibility, 'visible');
      assert.deepEqual(initialVisibility, ['hidden', 'hidden'], 'unpositioned panels must not cover the trigger and generate hover events');
    } finally { await close(); globalThis.ResizeObserver = originalObserver; }
  });

  test('shading uses the highlight palette and alignment affects only selected cells', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 0, 0, 1, 1);
      await open(editor); await click('table-menu'); await click('table-shading');
      await React.act(async () => { document.querySelector('.composer-context-menu button[title="#ffd43b"]').click(); });
      assert.equal(editor.state.selection instanceof CellSelection, true);
      assert.equal(style(cell(editor, 1, 1).node).backgroundColor, 'rgb(255, 212, 59)');
      assert.equal(style(cell(editor, 2, 2).node).backgroundColor, '');
      await action(editor, 'table-align', 'cell-align-bottom-right');
      assert.equal(style(cell(editor, 1, 1).node).verticalAlign, 'bottom');
      assert.equal(style(cell(editor, 1, 1).node).textAlign, 'right');
      assert.equal(cell(editor, 1, 1).node.firstChild.attrs.textAlign, 'right');
      assert.equal(style(cell(editor, 2, 2).node).textAlign, '');
      const html = editor.getHTML();
      await React.act(async () => { editor.commands.setContent(html); });
      assert.equal(style(cell(editor, 1, 1).node).backgroundColor, 'rgb(255, 212, 59)');
      assert.equal(style(cell(editor, 1, 1).node).verticalAlign, 'bottom');
      await selectCells(editor, 0, 0, 1, 1);
      await open(editor); await click('table-menu'); await click('table-shading');
      assert.notEqual(document.querySelector('.composer-context-menu button[title="#ffd43b"]').style.outline, 'none');
      await React.act(async () => { document.querySelector('.composer-context-menu button[title="compose.toolbar.removeHighlight"]').click(); });
      assert.equal(style(cell(editor, 1, 1).node).backgroundColor, '');
      // Reapply for the draft-serialization assertion below.
      await open(editor); await click('table-menu'); await click('table-shading');
      await React.act(async () => { document.querySelector('.composer-context-menu button[title="#ffd43b"]').click(); });
      await hideTab();
      assert.match(saved.at(-1).body, /background-color: rgb\(255, 212, 59\)/);
    } finally { await close(); }
  });

  test('border presets distinguish perimeter and internal edges and mirror shared borders', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 0, 0, 2, 2);
      await action(editor, 'table-border', 'border-none');
      assert.equal(style(cell(editor, 1, 1).node).borderTopWidth, '0px');
      assert.equal(style(info(editor).node).borderWidth, '0px');
      await action(editor, 'table-border', 'border-outside');
      assert.equal(style(cell(editor, 0, 0).node).borderTopWidth, '1px');
      assert.equal(style(cell(editor, 0, 0).node).borderRightWidth, '0px');
      await action(editor, 'table-border', 'border-inside');
      assert.equal(style(cell(editor, 0, 0).node).borderTopWidth, '0px');
      assert.equal(style(cell(editor, 0, 0).node).borderRightWidth, '1px');
      await action(editor, 'table-border', 'border-all');
      for (const side of ['Top', 'Bottom', 'Left', 'Right']) assert.equal(style(cell(editor, 1, 1).node)[`border${side}Width`], '1px');
      await selectCells(editor, 0, 0);
      await action(editor, 'table-border', 'border-bottom');
      assert.equal(style(cell(editor, 0, 0).node).borderBottomWidth, '0px');
      assert.equal(style(cell(editor, 1, 0).node).borderTopWidth, '0px');
      valid(editor);
    } finally { await close(); }
  });

  test('row and column insertion and deletion retain a valid table', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      for (const [id, width, height] of [['column-left', 4, 3], ['column-right', 5, 3], ['row-above', 5, 4], ['row-below', 5, 5]]) {
        await selectCells(editor, 1, 1);
        await action(editor, 'table-insert', id, 1, 1);
        assert.equal(info(editor).map.width, width); assert.equal(info(editor).map.height, height);
        valid(editor);
      }
      assert.equal(info(editor).node.textContent, 'ABCDEFGHI');
      await selectCells(editor, 1, 1);
      await action(editor, 'table-delete', 'delete-rows', 1, 1);
      assert.equal(info(editor).map.height, 4);
      await selectCells(editor, 1, 1);
      await action(editor, 'table-delete', 'delete-columns', 1, 1);
      assert.equal(info(editor).map.width, 4); valid(editor);
      await action(editor, 'table-delete', 'delete-table', 1, 1);
      assert.equal(info(editor), undefined);
      assert.equal(editor.state.doc.textContent, 'BeforeAfter');
    } finally { await close(); }
  });

  test('single-cell horizontal and vertical splits add local divisions without losing text', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 1, 1);
      await action(editor, 'table-split-cells', 'split-vertical', 1, 1);
      assert.equal(info(editor).map.width, 4); assert.equal(info(editor).map.height, 3);
      assert.equal(cell(editor, 0, 1).node.attrs.colspan, 2); valid(editor);
      await selectCells(editor, 1, 1);
      await action(editor, 'table-split-cells', 'split-horizontal', 1, 1);
      assert.equal(info(editor).map.width, 4); assert.equal(info(editor).map.height, 4);
      assert.equal(cell(editor, 1, 0).node.attrs.rowspan, 2);
      assert.equal(info(editor).node.textContent, 'ABCDEFGHI'); valid(editor);
    } finally { await close(); }
  });

  test('merged cell splits divide existing spans and retain their contents', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 0, 0, 1, 1);
      await action(editor, null, 'table-merge');
      assert.equal(cell(editor, 0, 0).node.attrs.colspan, 2);
      assert.equal(cell(editor, 0, 0).node.attrs.rowspan, 2);
      const text = info(editor).node.textContent;
      await action(editor, 'table-split-cells', 'split-horizontal');
      assert.equal(info(editor).map.height, 3);
      assert.equal(cell(editor, 0, 0).node.attrs.rowspan, 1);
      await action(editor, 'table-split-cells', 'split-vertical');
      assert.equal(info(editor).map.width, 3);
      assert.equal(cell(editor, 0, 0).node.attrs.colspan, 1);
      assert.equal(info(editor).node.textContent, text); valid(editor);
    } finally { await close(); }
  });

  test('Split Table preserves spanning cells and all text across the two tables', async () => {
    const body = '<table><tr><td rowspan="3">A</td><td>B</td></tr><tr><td>C</td></tr><tr><td>D</td></tr></table>';
    const close = await openDraft({ plaintextEmail: false, body });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 0, 1);
      await open(editor, 0, 1); await click('table-menu');
      assert.equal(document.querySelector('[data-action="table-split"]').disabled, true);
      await selectCells(editor, 1, 1);
      await action(editor, null, 'table-split', 1, 1);
      const tables = [];
      editor.state.doc.forEach(node => { if (node.type.name === 'table') tables.push(node); });
      assert.equal(tables.length, 2);
      assert.equal(TableMap.get(tables[0]).height, 1);
      assert.equal(TableMap.get(tables[1]).height, 2);
      assert.equal(editor.state.doc.textContent, 'ABCD'); valid(editor);
    } finally { await close(); }
  });

  test('Properties opens the existing modal, edits the table and preserves retained contents', async () => {
    const close = await openDraft({ plaintextEmail: false, body: BODY });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await selectCells(editor, 1, 1);
      await action(editor, null, 'table-properties', 1, 1);
      assert.ok(document.querySelector('.table-insert-dialog'));
      assert.equal(document.querySelector('.table-insert-dialog h3').textContent, 'compose.tableMenu.properties');
      await field('compose.table.rows', '4'); await field('compose.table.columns', '4');
      await field('compose.table.cellPadding', '6'); await field('compose.table.border', '2');
      await field('compose.table.alignment', 'center'); await field('compose.table.widthUnit', 'px');
      await field('compose.table.width', '480');
      await React.act(async () => { document.querySelector('.table-insert-submit').click(); });
      assert.equal(info(editor).map.width, 4); assert.equal(info(editor).map.height, 4);
      assert.equal(info(editor).node.textContent, 'ABCDEFGHI');
      assert.equal(style(info(editor).node).width, '480px');
      assert.equal(style(cell(editor, 1, 1).node).padding, '6px');
      assert.equal(style(cell(editor, 1, 1).node).borderWidth, '2px');
      assert.equal(info(editor).node.attrs.align, 'center'); valid(editor);
      await selectCells(editor, 1, 1);
      await action(editor, null, 'table-properties', 1, 1);
      await field('compose.table.rows', '2'); await field('compose.table.columns', '2');
      await React.act(async () => {
        document.querySelector('.table-insert-check input').click();
        document.querySelector('.table-insert-submit').click();
      });
      assert.equal(info(editor).map.width, 2); assert.equal(info(editor).map.height, 2);
      assert.equal(info(editor).node.textContent, 'ABDE');
      assert.equal(cell(editor, 0, 0).node.type.name, 'tableHeader'); valid(editor);
      await hideTab();
      assert.match(saved.at(-1).body, /width: 480px/);
    } finally { await close(); }
  });
});

describe('table insertion', () => {
  const press = element => React.act(async () => {
    element.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  const click = element => React.act(async () => { element.click(); });
  const openPicker = () => press(document.querySelector('button[title="compose.toolbar.insertTable"]'));
  const setField = (label, value) => React.act(async () => {
    const field = [...document.querySelectorAll('.table-insert-field')]
      .find(el => el.querySelector('span').textContent === label).querySelector('input, select');
    const prototype = field.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
    field.dispatchEvent(new window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  const tableFrom = html => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    return wrapper.querySelector('table');
  };

  test('the quick grid highlights the rectangle and inserts at the saved caret', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Before after</p>' });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await React.act(async () => { editor.commands.setTextSelection(8); });
      await openPicker();
      const cells = document.querySelectorAll('.table-insert-grid button');
      assert.equal(cells.length, 64);
      await React.act(async () => { cells[19].focus(); }); // Four columns by three rows.
      assert.equal(document.querySelectorAll('.table-insert-grid .is-selected').length, 12);
      await React.act(async () => { cells[19].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
      assert.equal(document.activeElement, cells[20]);
      await React.act(async () => { cells[19].focus(); });
      await click(cells[19]);
      const table = tableFrom(editor.getHTML());
      assert.equal(table.rows.length, 3);
      assert.equal(table.rows[0].cells.length, 4);
      assert.equal(table.rows[0].cells[0].tagName, 'TH');
      assert.equal(editor.state.doc.firstChild.textContent, 'Before ');
      assert.equal(editor.state.doc.lastChild.textContent, 'after');
      assert.equal(document.querySelector('.table-insert-picker'), null);
    } finally { await close(); }
  });

  test('custom presentation survives HTML round trips and draft saves', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Draft</p>' });
    try {
      await openPicker();
      await click(document.querySelector('.table-insert-action'));
      assert.ok(document.querySelector('[role="dialog"]'));
      assert.equal(document.activeElement, document.querySelector('.table-insert-dialog input'));
      await React.act(async () => {
        document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      });
      assert.equal(document.activeElement, document.querySelector('.table-insert-submit'));
      await setField('compose.table.rows', '4');
      await setField('compose.table.columns', '2');
      await setField('compose.table.cellPadding', '6');
      await setField('compose.table.cellSpacing', '4');
      await setField('compose.table.border', '0');
      await setField('compose.table.alignment', 'right');
      await setField('compose.table.widthUnit', 'px');
      await setField('compose.table.width', '498');
      await click(document.querySelector('.table-insert-check input'));
      await React.act(async () => {
        document.querySelector('.table-insert-dialog').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      const editor = document.querySelector('.ProseMirror').editor;
      const assertTable = html => {
        const table = tableFrom(html);
        assert.equal(table.rows.length, 4);
        assert.equal(table.rows[0].cells.length, 2);
        assert.equal(table.querySelector('th'), null);
        assert.equal(table.getAttribute('width'), '498');
        assert.equal(table.style.width, '498px');
        assert.equal(table.style.borderCollapse, 'separate');
        assert.equal(table.style.borderSpacing, '4px');
        assert.equal(table.getAttribute('align'), 'right');
        assert.equal(table.style.marginLeft, 'auto');
        assert.equal(table.getAttribute('cellpadding'), '6');
        assert.equal(table.getAttribute('cellspacing'), '4');
        assert.equal(table.getAttribute('border'), '0');
        assert.equal(table.rows[0].cells[0].style.borderWidth, '0px');
        assert.equal(table.rows[0].cells[0].style.padding, '6px');
      };
      assertTable(editor.getHTML());
      await React.act(async () => { editor.commands.setContent(editor.getHTML()); });
      assertTable(editor.getHTML());
      await hideTab();
      assertTable(saved.at(-1).body);
    } finally { await close(); }
  });

  test('cancel and Escape leave the message unchanged', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<p>Unchanged</p>' });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      const original = editor.getHTML();
      await openPicker();
      await click(document.querySelector('.table-insert-action'));
      await click(document.querySelector('.table-insert-footer button'));
      assert.equal(editor.getHTML(), original);
      await openPicker();
      await React.act(async () => {
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      assert.equal(document.querySelector('.table-insert-picker'), null);
      assert.equal(editor.getHTML(), original);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });

  test('the picker still offers removal from inside an existing table', async () => {
    const close = await openDraft({ plaintextEmail: false, body: '<table><tr><td>Existing cell</td></tr></table>' });
    try {
      const editor = document.querySelector('.ProseMirror').editor;
      await React.act(async () => { editor.commands.setTextSelection(4); });
      await openPicker();
      await click(document.querySelector('.table-insert-remove'));
      assert.equal(tableFrom(editor.getHTML()), null);
    } finally { await close(); }
  });
});

// Autosave also runs when the tab is hidden, without waiting for the idle timer, which makes
// it the deterministic way to ask the composer "would you save now?".
async function hideTab() {
  visibility = 'hidden';
  await React.act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
  await React.act(async () => {});
  visibility = 'visible';
}

// Opens a draft the way MessageList does for a click in the Drafts folder. Returns an unmount.
async function openDraft({ plaintextEmail, body }) {
  saved.length = 0;
  useStore.setState({ plaintextEmail, composing: false, composeData: null, prepareComposeSwitch: null });
  useStore.getState().openCompose({
    accountId: 'acct',
    draftUid: 7,
    draftFolder: 'Drafts',
    to: ['Bob <bob@example.invalid>'],
    cc: [],
    subject: 'Contract',
    body,
    bodyIsHtml: !plaintextEmail,
  });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  // immediatelyRender: false creates the editor in an effect after the first commit.
  await React.act(async () => {});
  return () => React.act(async () => root.unmount());
}

before(() => {
  api.saveDraft = async (payload) => { saved.push(payload); return { uid: 8, folder: 'Drafts' }; };
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
});

describe('reopening a draft saved by another client', () => {
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT }); });
  after(() => close());

  test('mounts the draft into the editor', () => {
    const editor = document.querySelector('.ProseMirror')?.editor;
    assert.ok(editor, 'the rich-text editor mounted');
    assert.match(editor.getHTML(), /The contract is attached\./);
    assert.notEqual(editor.getHTML(), GMAIL_DRAFT, 'precondition: TipTap rewrote the stored HTML');
  });

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });

  test('still autosaves once the body is edited, replacing the same draft', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'a real edit is saved');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.match(saved[0].body, /Thanks\./);
  });
});

describe('reopening a draft in plain-text mode', () => {
  // The editor still mounts in plain-text mode, but the dirty check compares the textarea, so
  // its baseline has to stay the raw body.
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: true, body: 'Hi Bob,\n\nThe contract is attached.' }); });
  after(() => close());

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });
});

describe('switching From on a reopened draft', () => {
  // The old copy stays in the account it was saved to. The backend used to delete its uid in
  // whichever account From named, which expunged an unrelated message there when both
  // accounts have a Drafts folder.
  let close;
  before(async () => {
    useStore.setState({
      accounts: [
        { id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' },
        { id: 'other', enabled: true, email_address: 'other@example.invalid', name: 'Other', color: '#000' },
      ],
    });
    close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT });
  });
  after(() => close());

  test('names the account that holds the copy being replaced', async () => {
    const from = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'account:other'));
    await React.act(async () => {
      from.value = 'account:other';
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'the edit is saved');
    assert.equal(saved[0].accountId, 'other', 'the new copy goes to the account From names');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.equal(saved[0].existingAccountId, 'acct', 'the old copy is deleted from its own account');
  });

  test('the next save replaces the new copy in the account it was saved to', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Bye.'); });
    await hideTab();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].existingUid, 8);
    assert.equal(saved[0].existingAccountId, 'other');
  });
});

describe('automatic Cc and Bcc (#491)', () => {
  // Several tests assert that nothing happens (no chip, no save). Each first shows the automatic
  // address appearing where it should, so none of them can pass with the feature missing.
  const ME = 'me@example.invalid';
  const SENDER = { name: 'Sender', email: 'sender@example.invalid' };
  const posted = [];
  let realPost;

  const account = (id, { cc = [], bcc = [], aliases } = {}) => ({
    id, enabled: true, email_address: `${id}@example.invalid`, name: id, color: '#fff',
    auto_cc_addresses: cc, auto_bcc_addresses: bcc, ...(aliases ? { aliases } : {}),
  });
  // What composeFromMessage hands over for Reply All, and for Reply.
  const replyAll = (thread) => ({
    accountId: 'A', isReply: true, isReplyAll: true, subject: 'Re: Plan', body: '',
    to: [SENDER], originalFrom: [SENDER], cc: thread, allRecipients: thread,
  });
  const reply = (thread) => ({ ...replyAll(thread), isReplyAll: false, cc: [] });
  // A thread that already Cc's the address account A sends an automatic Bcc to.
  const PERSONAL = 'me@personal.example.invalid';
  const THREAD = [{ name: '', email: 'thread@example.invalid' }, { name: '', email: PERSONAL }];
  const BOTH_LISTS = { cc: ['boss@example.invalid'], bcc: [PERSONAL] };

  // Opens the composer through the store, as every entry point does. Returns an unmount.
  async function mountCompose(composeData, { accounts, strict = false }) {
    saved.length = 0;
    posted.length = 0;
    useStore.setState({ plaintextEmail: false, accounts, selectedAccountId: accounts[0]?.id ?? null, defaultSender: '', composing: false, composeData: null, prepareComposeSwitch: null });
    useStore.getState().openCompose(composeData);
    const root = createRoot(document.getElementById('root'));
    const modal = React.createElement(ComposeModal);
    await React.act(async () => { root.render(strict ? React.createElement(React.StrictMode, null, modal) : modal); });
    await React.act(async () => {});
    return () => React.act(async () => root.unmount());
  }

  const rowOf = (label) => [...document.querySelectorAll('span')].find(s => s.textContent === label)?.parentElement ?? null;
  // The chips in the row labelled `label`, or null when that row is not rendered at all.
  const chips = (label) => {
    const row = rowOf(label);
    return row ? [...row.querySelectorAll('span[title]')].map(s => s.title) : null;
  };
  const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });

  async function chooseFrom(value) {
    const from = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === value));
    await React.act(async () => {
      from.value = value;
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  }
  async function typeInto(input, text) {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  const typeSubject = (text) => typeInto(document.querySelector('input[placeholder="compose.subject"]'), text);
  // Types a recipient into the row labelled `label` and commits it with Enter.
  async function addChip(label, text) {
    const input = rowOf(label).querySelector('input');
    await typeInto(input, text);
    await React.act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  }
  async function send() {
    await click([...document.querySelectorAll('button')].find(b => b.textContent === 'compose.send'));
    await React.act(async () => {});
    return posted.find(p => p.path === '/mail/send')?.body;
  }
  // Renders at phone width, where the composer has its own layout with Reply and Reply All tabs.
  async function onMobile(run) {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    try {
      await run((label) => [...document.querySelectorAll('button')].find(b => b.textContent === label));
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    }
  }
  async function editBody(text) {
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(text); });
  }
  async function removeChip(label, address) {
    const chip = [...rowOf(label).querySelectorAll('span[title]')].find(s => s.title === address);
    await click(chip.querySelector('button'));
  }
  async function switchReplyType(label) {
    await click([...document.querySelectorAll('button')].find(b => /^compose\.reply(All)?$/.test(b.textContent)));
    await click([...document.querySelectorAll('div')].find(d => d.textContent === label));
  }

  before(() => {
    // A reply autofocuses the editor, and TipTap focuses through requestAnimationFrame.
    globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
    realPost = api.post;
    api.post = async (path, body) => { posted.push({ path, body }); return { sentFolder: 'Sent' }; };
  });
  after(() => { api.post = realPost; });

  test('a new message shows the account\'s automatic Bcc in a visible Bcc row', async () => {
    const close = await mountCompose({}, { accounts: [account('A', { bcc: [ME] })] });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME]);
    } finally { await close(); }
  });

  test('an untouched composer with automatic recipients is not autosaved and closes without a prompt', async () => {
    const close = await mountCompose({}, { accounts: [account('A', { cc: ['boss@example.invalid'], bcc: [ME] })] });
    try {
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await hideTab();
      assert.equal(saved.length, 0, 'nothing the user did needs saving');
      const unload = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      assert.equal(unload.defaultPrevented, false, 'no leave-page prompt');
      await click(document.querySelector('button[title="compose.toolbar.close"]'));
      assert.equal(useStore.getState().composing, false, 'closed straight away, without the save-or-discard dialog');
    } finally { await close(); }
  });

  test('the automatic Bcc is saved and sent like any other recipient', async () => {
    const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts: [account('A', { bcc: [ME] })] });
    try {
      await typeSubject('Plan');
      await hideTab();
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0].bcc, [ME]);
      const sent = await send();
      assert.ok(sent, 'the message was sent');
      assert.deepEqual(sent.bcc, [ME]);
      assert.deepEqual(sent.to, ['x@example.invalid']);
    } finally { await close(); }
  });

  test('a message forwarded as an attachment is sent by id, its own attachments by part (#466)', async () => {
    const close = await mountCompose({
      to: ['submit.x@spam.spamcop.net'], subject: 'Fwd: You won', isForward: true,
      forwardedAttachments: [
        { messageId: 'spam-1', asMessage: true, filename: 'You won.eml', type: 'message/rfc822', size: null },
        { messageId: 'other-1', part: '2', filename: 'invoice.pdf', type: 'application/pdf', size: 2048 },
      ],
    }, { accounts: [account('A')] });
    try {
      const chipText = [...document.querySelectorAll('span')].map(sp => sp.textContent).join(' | ');
      assert.ok(chipText.includes('You won.eml'));
      assert.ok(!/NaN|undefined|nullB/.test(chipText), 'a message attachment shows no made-up size');
      const sent = await send();
      assert.ok(sent, 'the message was sent');
      assert.deepEqual(sent.forwardedMessages, ['spam-1']);
      assert.deepEqual(sent.forwardedAttachments, [{ messageId: 'other-1', part: '2' }]);
    } finally { await close(); }
  });

  test('a mailto Bcc is kept alongside the automatic Bcc, and the composer stays clean', async () => {
    const close = await mountCompose(
      { to: ['x@example.invalid'], bcc: ['u@example.invalid'] },
      { accounts: [account('A', { bcc: [ME] })] },
    );
    try {
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', ME]);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });

  test('reply-all keeps an automatic Cc that is not on the thread', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'thread@example.invalid' }]),
      { accounts: [account('A', { cc: ['boss@example.invalid'] })] },
    );
    try {
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid', 'boss@example.invalid']);
    } finally { await close(); }
  });

  test('reply-all lists an automatic Cc that is already on the thread only once', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'ARCHIVE@example.invalid' }]),
      { accounts: [account('A', { cc: ['archive@example.invalid', 'boss@example.invalid'] })] },
    );
    try {
      assert.deepEqual(chips('compose.cc'), ['ARCHIVE@example.invalid', 'boss@example.invalid']);
    } finally { await close(); }
  });

  test('a reopened draft is not given the automatic recipients, on opening or on a From switch', async () => {
    const accounts = [account('acct', { bcc: [ME] }), account('other', { bcc: ['other-auto@example.invalid'] })];
    const fresh = await mountCompose({}, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME], 'a new message from the same account gets it');
    } finally { await fresh(); }

    const close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT });
    try {
      assert.equal(chips('compose.bcc'), null, 'no Bcc row: the draft saved none');
      await hideTab();
      assert.equal(saved.length, 0, 'opening the draft is still not an edit');
      await chooseFrom('account:other');
      assert.equal(chips('compose.bcc'), null, 'nor from the account From switches to');
      await hideTab();
      assert.equal(saved.length, 1, 'a saved sender change is persisted');
    } finally { await close(); }
  });

  test('a message reopened by undo send keeps the Cc and Bcc it was sent with', async () => {
    const accounts = [account('acct', { bcc: [ME] })];
    const fresh = await mountCompose({}, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME], 'a new message from the account gets it');
    } finally { await fresh(); }

    // Sent without the automatic Bcc (the user removed it), then undone. No draft was saved.
    const close = await mountCompose({ accountId: 'acct', to: ['x@example.invalid'], cc: [], bcc: [], subject: 'Plan', body: '<p>Plan</p>', restored: true }, { accounts });
    try {
      assert.equal(chips('compose.bcc'), null, 'the removed automatic Bcc does not come back');
    } finally { await close(); }
  });

  test('switching From before any save swaps only the automatic addresses', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({ to: ['x@example.invalid'], bcc: ['u@example.invalid'] }, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', 'a@example.invalid']);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', 'b@example.invalid']);
      await typeSubject('Plan');
      await hideTab();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].accountId, 'B');
      assert.deepEqual(saved[0].bcc, ['u@example.invalid', 'b@example.invalid']);
    } finally { await close(); }
  });

  test('switching From on an untouched composer is not an edit', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({}, { accounts });
    try {
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['b@example.invalid']);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });

  test('switching From to another account and back gives the first account\'s automatic Bcc back', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts });
    try {
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['b@example.invalid']);
      await chooseFrom('account:A');
      assert.deepEqual(chips('compose.bcc'), ['a@example.invalid']);
    } finally { await close(); }
  });

  test('a Cc or Bcc the user typed before a From switch is still an unsaved edit', async () => {
    const accounts = [
      account('A', { cc: ['a-cc@example.invalid'], bcc: ['a@example.invalid'] }),
      account('B', { cc: ['b-cc@example.invalid'], bcc: ['b@example.invalid'] }),
    ];
    for (const [field, fromB] of [['cc', 'b-cc@example.invalid'], ['bcc', 'b@example.invalid']]) {
      const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts });
      try {
        await addChip(`compose.${field}`, 'typed@example.invalid');
        await chooseFrom('account:B');
        await hideTab();
        assert.equal(saved.length, 1, `the typed ${field} is the only edit, and it is saved`);
        assert.deepEqual(saved[0][field], ['typed@example.invalid', fromB]);
      } finally { await close(); }
    }
  });

  test('a tab hidden right after a From switch does not save the old account\'s chips under the new From', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({}, { accounts });
    const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    try {
      // Outside act(), so React schedules as it does in a browser: the From change renders in a
      // microtask, and the tab is hidden straight after it, before any later task can run.
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
      const from = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'account:B'));
      from.value = 'account:B';
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
      await Promise.resolve();
      visibility = 'hidden';
      document.dispatchEvent(new window.Event('visibilitychange'));
      visibility = 'visible';
      await new Promise(resolve => setTimeout(resolve, 0));
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
      await React.act(async () => {});
      assert.deepEqual(chips('compose.bcc'), ['b@example.invalid']);
      assert.deepEqual(saved.map(s => ({ accountId: s.accountId, bcc: s.bcc })), [], 'an untouched composer is not saved');
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
      await close();
    }
  });

  test('switching From after an autosave saves the new From together with its lists', async () => {
    const accounts = [account('A', { bcc: ['a@example.invalid'] }), account('B', { bcc: ['b@example.invalid'] })];
    const close = await mountCompose({ to: ['x@example.invalid'] }, { accounts });
    try {
      await editBody('Hi');
      await hideTab();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].accountId, 'A');
      assert.deepEqual(saved[0].bcc, ['a@example.invalid']);

      await chooseFrom('account:B');
      await hideTab();
      assert.equal(saved.length, 2, 'the switch alone is saved');
      assert.equal(saved[1].accountId, 'B');
      assert.deepEqual(saved[1].bcc, ['b@example.invalid']);
      assert.equal(saved[1].existingUid, 8);
      assert.equal(saved[1].existingAccountId, 'A');
    } finally { await close(); }
  });

  test('an automatic address the user removed is not added back by a From switch', async () => {
    const accounts = [account('A', { cc: ['crm@example.invalid'] }), account('B', { cc: ['crm@example.invalid'] })];
    const close = await mountCompose({}, { accounts });
    try {
      assert.deepEqual(chips('compose.cc'), ['crm@example.invalid']);
      await removeChip('compose.cc', 'crm@example.invalid');
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.cc'), []);
      await chooseFrom('account:A');
      assert.deepEqual(chips('compose.cc'), [], 'nor by switching back');
    } finally { await close(); }
  });

  // Writes a message in a composer keyed the way MailApp keys it, sends it with an undo window and
  // undoes it, so the undone message mounts a composer of its own. `beforeSend` runs first;
  // `whileSending` runs after Send is clicked and before the server has answered. Returns an
  // unmount.
  async function sendAndUndo(composeData, { accounts, beforeSend, whileSending }) {
    const Host = () => {
      const composing = useStore(s => s.composing);
      const session = useStore(s => s.composeSession);
      return composing ? React.createElement(ComposeModal, { key: session }) : null;
    };
    const plainPost = api.post;
    let answer;
    api.post = (path, body) => {
      posted.push({ path, body });
      if (path !== '/mail/send') return plainPost(path, body);
      return new Promise(resolve => {
        answer = () => resolve({ ok: true, pending: true, pendingId: 'p-auto', sendAt: new Date(Date.now() + 10_000).toISOString(), remainingMs: 10_000 });
      });
    };
    api.cancelSend = async () => ({ cancelled: true });
    saved.length = 0;
    posted.length = 0;
    useStore.setState({ plaintextEmail: false, accounts, selectedAccountId: accounts[0].id, defaultSender: '', notifications: [], composing: false, composeData: null });
    useStore.getState().openCompose(composeData);
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    const unmount = () => React.act(async () => root.unmount());
    try {
      await beforeSend?.();
      await send();
      await whileSending?.();
      await React.act(async () => { answer(); });
      await React.act(async () => {});
      const bar = useStore.getState().notifications.find(n => n.onUndo);
      await React.act(async () => { await bar.onUndo(); });
      await React.act(async () => {});
    } catch (err) {
      await unmount();
      throw err;
    } finally {
      api.post = plainPost;
    }
    return unmount;
  }

  test('after undo send, an automatic address removed before sending stays out across From switches', async () => {
    const accounts = [account('A', { cc: ['crm@example.invalid'] }), account('B', { cc: ['crm@example.invalid'] })];
    const cc = () => chips('compose.cc') ?? [];
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, {
      accounts,
      beforeSend: async () => {
        assert.deepEqual(cc(), ['crm@example.invalid']);
        await removeChip('compose.cc', 'crm@example.invalid');
      },
    });
    try {
      assert.deepEqual(cc(), [], 'reopened as it was sent');
      await chooseFrom('account:B');
      assert.deepEqual(cc(), [], 'a From switch does not bring it back');
      await chooseFrom('account:A');
      assert.deepEqual(cc(), [], 'nor does switching back');
    } finally { await close(); }
  });

  test('after undo send, a From switch replaces the first account\'s automatic Bcc with the second\'s', async () => {
    const accounts = [account('A', { bcc: ['a-arch@example.invalid'] }), account('B', { bcc: ['b-arch@example.invalid'] })];
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, { accounts });
    try {
      assert.deepEqual(chips('compose.bcc'), ['a-arch@example.invalid'], 'reopened as it was sent');
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), ['b-arch@example.invalid']);
    } finally { await close(); }
  });

  test('after undo send of a reply, Reply All and back to Reply keeps the automatic Bcc', async () => {
    const close = await sendAndUndo(reply([{ name: '', email: 'thread@example.invalid' }]), { accounts: [account('A', { bcc: [ME] })] });
    try {
      assert.deepEqual(chips('compose.bcc'), [ME], 'reopened as it was sent');
      await switchReplyType('compose.replyAll');
      await switchReplyType('compose.reply');
      assert.deepEqual(chips('compose.bcc'), [ME]);
    } finally { await close(); }
  });

  test('after undo send, a From switch made while the message was being sent does not change what it reopens with', async () => {
    const accounts = [account('A', { cc: ['crm-a@example.invalid'] }), account('B', { cc: ['crm-b@example.invalid'] })];
    const cc = () => chips('compose.cc') ?? [];
    // The server has not answered yet, and From stays usable while it is sending.
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, { accounts, whileSending: () => chooseFrom('account:B') });
    try {
      assert.deepEqual(cc(), ['crm-a@example.invalid'], 'reopened as it was sent, from A');
      await chooseFrom('account:B');
      assert.deepEqual(cc(), ['crm-b@example.invalid'], 'B\'s automatic Cc replaces A\'s');
    } finally { await close(); }
  });

  test('after undo send of a message autosaved before Send, a From switch still swaps the automatic Cc', async () => {
    // A composer open for a while has saved a draft by the time Send is clicked. The undone message
    // comes back with that draft, but it was never opened from one, so it behaves like its composer.
    const accounts = [account('A', { cc: ['crm-a@example.invalid'] }), account('B', { cc: ['crm-b@example.invalid'] })];
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, {
      accounts,
      beforeSend: async () => {
        await editBody('Hi');
        await hideTab();
        assert.equal(saved.length, 1, 'precondition: the message was autosaved before Send');
      },
    });
    try {
      assert.equal(useStore.getState().composeData.draftUid, 8, 'reopened with its draft');
      assert.deepEqual(chips('compose.cc'), ['crm-a@example.invalid']);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.cc'), ['crm-b@example.invalid']);
    } finally { await close(); }
  });

  test('a message undone after an autosave closes like its composer once saved again: without a discard prompt', async () => {
    const close = await sendAndUndo({ to: ['x@example.invalid'], subject: 'Plan' }, {
      accounts: [account('A')],
      beforeSend: async () => { await editBody('Hi'); await hideTab(); },
    });
    try {
      await hideTab(); // the reopened message is newer than its draft, so it is saved
      assert.equal(saved.length, 2, 'precondition: saved again after it was reopened');
      await click(document.querySelector('button[title="compose.toolbar.close"]'));
      assert.equal(useStore.getState().composing, false, 'closed, keeping the draft it saved');
    } finally { await close(); }
  });

  test('after undo send of a draft opened from the list, a From switch still adds no automatic Bcc', async () => {
    // The other side of the two tests above: this one was opened from a draft, so it stays one.
    const accounts = [account('A', { bcc: ['a-arch@example.invalid'] }), account('B', { bcc: ['b-arch@example.invalid'] })];
    const close = await sendAndUndo(
      { accountId: 'A', draftUid: 7, draftFolder: 'Drafts', to: ['x@example.invalid'], subject: 'Plan', body: '<p>Plan</p>' },
      { accounts },
    );
    try {
      assert.equal(useStore.getState().composeData.draftUid, 7, 'reopened with its draft');
      assert.equal(chips('compose.bcc'), null, 'no Bcc row: the draft saved none');
      await chooseFrom('account:B');
      assert.equal(chips('compose.bcc'), null, 'nor from the account From switches to');
    } finally { await close(); }
  });

  test('a From switch keeps a recipient the user added for an automatic address', async () => {
    const accounts = [account('A', { cc: ['boss@example.invalid'] }), account('B')];
    const close = await mountCompose({ to: ['x@example.invalid'], subject: 'Plan' }, { accounts });
    try {
      await addChip('compose.cc', 'Boss Person <boss@example.invalid>');
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid', 'Boss Person <boss@example.invalid>']);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.cc'), ['Boss Person <boss@example.invalid>'], 'only the automatic chip goes');
      const sent = await send();
      assert.equal(sent.accountId, 'B');
      assert.deepEqual(sent.cc, ['Boss Person <boss@example.invalid>']);
    } finally { await close(); }
  });

  test('Reply All to Reply keeps the automatic Bcc, and its row stays while the user edits it', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'thread@example.invalid' }]),
      { accounts: [account('A', { bcc: [ME] })] },
    );
    try {
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await switchReplyType('compose.reply');
      assert.equal(chips('compose.cc'), null, 'the thread\'s Cc goes, as before');
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await hideTab();
      assert.deepEqual(saved.at(-1).bcc, [ME]);

      const input = rowOf('compose.bcc').querySelector('input');
      await React.act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      });
      assert.deepEqual(chips('compose.bcc'), [], 'Backspace removes the chip but leaves the row');
    } finally { await close(); }
  });

  test('Reply to Reply All keeps the automatic Cc and leaves no address in both Cc and Bcc', async () => {
    const close = await mountCompose(reply(THREAD), { accounts: [account('A', BOTH_LISTS)] });
    try {
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [PERSONAL]);
      await switchReplyType('compose.replyAll');
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid', PERSONAL, 'boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc') ?? [], [], 'the thread has it in Cc, so it is not in Bcc as well');
    } finally { await close(); }
  });

  test('the mobile Reply and Reply All tabs keep the automatic Bcc as well', () => onMobile(async (tab) => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'thread@example.invalid' }]),
      { accounts: [account('A', { bcc: [ME] })] },
    );
    try {
      assert.ok(tab('compose.reply'), 'the mobile layout is rendered');
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await click(tab('compose.reply'));
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await click(tab('compose.replyAll'));
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [ME]);
    } finally { await close(); }
  }));

  test('the mobile Reply All tab keeps the automatic Cc and leaves no address in both Cc and Bcc', () => onMobile(async (tab) => {
    const close = await mountCompose(reply(THREAD), { accounts: [account('A', BOTH_LISTS)] });
    try {
      assert.ok(tab('compose.replyAll'), 'the mobile layout is rendered');
      assert.deepEqual(chips('compose.cc'), ['boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc'), [PERSONAL]);
      await click(tab('compose.replyAll'));
      assert.deepEqual(chips('compose.cc'), ['thread@example.invalid', PERSONAL, 'boss@example.invalid']);
      assert.deepEqual(chips('compose.bcc') ?? [], [], 'the thread has it in Cc, so it is not in Bcc as well');
    } finally { await close(); }
  }));

  test('Reply All to Reply keeps an automatic Cc that was on the thread', async () => {
    const close = await mountCompose(
      replyAll([{ name: '', email: 'archive@example.invalid' }]),
      { accounts: [account('A', { cc: ['archive@example.invalid'] })] },
    );
    try {
      assert.deepEqual(chips('compose.cc'), ['archive@example.invalid']);
      await switchReplyType('compose.reply');
      assert.deepEqual(chips('compose.cc'), ['archive@example.invalid']);
    } finally { await close(); }
  });

  test('a From switch after Reply All to Reply takes out the automatic Bcc that Reply placed', async () => {
    const close = await mountCompose(replyAll(THREAD), { accounts: [account('A', { bcc: [PERSONAL] }), account('B')] });
    try {
      assert.equal(chips('compose.bcc'), null, 'Reply All: the thread already has it in Cc');
      await switchReplyType('compose.reply');
      assert.deepEqual(chips('compose.bcc'), [PERSONAL]);
      await chooseFrom('account:B');
      assert.deepEqual(chips('compose.bcc'), [], 'B has no lists');
    } finally { await close(); }
  });

  test('an alias reply opened before accounts load gets the automatic Bcc when they arrive, and stays clean', async () => {
    const close = await mountCompose({
      accountId: 'late', aliasId: 'al1', isReply: true, subject: 'Re: Plan', body: '',
      to: [SENDER], originalFrom: [SENDER], cc: [], allRecipients: [],
    }, { accounts: [] });
    try {
      assert.equal(chips('compose.bcc'), null);
      await React.act(async () => {
        useStore.setState({ accounts: [account('late', { bcc: [ME], aliases: [{ id: 'al1', email: 'alias@example.invalid', name: 'Alias' }] })] });
      });
      assert.deepEqual(chips('compose.bcc'), [ME]);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });

  test('under StrictMode the automatic Bcc is applied once and the composer stays clean', async () => {
    const close = await mountCompose(
      { to: ['x@example.invalid'], bcc: ['u@example.invalid'] },
      { accounts: [account('A', { bcc: [ME] })], strict: true },
    );
    try {
      assert.deepEqual(chips('compose.bcc'), ['u@example.invalid', ME]);
      await hideTab();
      assert.equal(saved.length, 0);
    } finally { await close(); }
  });
});

describe('undo send', () => {
  // Mounted the way MailApp mounts it, so closing the composer unmounts it and reopening it
  // mounts a fresh one from the store's composeData.
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  const posted = [];
  const deleted = [];
  const cancels = [];
  let unmount;
  before(async () => {
    useStore.setState({
      plaintextEmail: false, composing: false, composeData: null, prepareComposeSwitch: null,
      notifications: [],
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    });
    api.post = async (path, payload) => {
      posted.push({ path, payload });
      return { ok: true, pending: true, pendingId: 'p1', sendAt: new Date(Date.now() + 10_000).toISOString(), remainingMs: 9_500 };
    };
    api.deleteDraft = async (...args) => { deleted.push(args); return { ok: true }; };
    api.cancelSend = async (id) => { cancels.push(id); return { cancelled: true }; };
    api.getSendStatus = async () => ({ status: 'pending' });
    useStore.getState().openCompose({
      accountId: 'acct',
      draftUid: 7,
      draftFolder: 'Drafts',
      to: ['Bob <bob@example.invalid>'],
      cc: [],
      subject: 'Contract',
      body: '<p>Here it is.</p>',
      attachments: [{ name: 'contract.pdf', size: 3, type: 'application/pdf', data: 'QUJD' }],
      priority: 'high',
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('Send hands the message to the server with an undo window and closes the composer', async () => {
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(posted.length, 1);
    const { payload } = posted[0];
    assert.equal(payload.undoSeconds, 10);
    assert.deepEqual(payload.draft, { uid: 7, folder: 'Drafts', accountId: 'acct' });
    assert.equal(payload.attachments[0].filename, 'contract.pdf');
    assert.equal(payload.priority, 'high');
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(deleted, [], 'the draft stays until the server has delivered the message');
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    assert.equal(bar.title, 'compose.undoSend.sending', 'the bar names the message (its subject)');
    assert.equal(bar.undoMs, 9_500, 'Undo lasts what the server said was left');
  });

  test('Undo gives the message back as it was sent, attachments included', async () => {
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { await bar.onUndo(); });
    await React.act(async () => {});
    assert.deepEqual(cancels, ['p1']);
    assert.equal(useStore.getState().composing, true);
    const data = useStore.getState().composeData;
    assert.equal(data.subject, 'Contract');
    assert.deepEqual(data.to, ['Bob <bob@example.invalid>']);
    assert.equal(data.priority, 'high');
    assert.equal(data.draftUid, 7);
    assert.match(document.body.textContent, /contract\.pdf/, 'the attachment is back in the composer');
    assert.match(document.querySelector('.ProseMirror').editor.getHTML(), /Here it is\./);
  });

  test('the reopened message counts as unsaved, so its draft is brought up to date', async () => {
    saved.length = 0;
    await hideTab();
    assert.equal(saved.length, 1, 'saved although nothing was typed since it reopened');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].subject, 'Contract');
  });

  test('a server without undo send delivers at once, and the draft is deleted from here', async () => {
    posted.length = 0;
    api.post = async (path, payload) => { posted.push({ path, payload }); return { ok: true }; };
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(deleted, [['acct', 8, 'Drafts']], 'the copy saved after the undo');
    assert.equal(useStore.getState().notifications[0].title, 'compose.sent.title');
  });
});

describe('undo send, message without attachments', () => {
  // With nothing to set it apart from its draft, only being a reopened message keeps it from
  // looking saved: closing it would then drop whatever was typed after the last autosave.
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  let unmount;
  before(async () => {
    useStore.setState({ plaintextEmail: false, notifications: [] });
    api.post = async () => ({ ok: true, pending: true, pendingId: 'p2', sendAt: new Date(Date.now() + 10_000).toISOString() });
    api.cancelSend = async () => ({ cancelled: true });
    useStore.getState().openCompose({
      accountId: 'acct', draftUid: 9, draftFolder: 'Drafts',
      to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Plan', body: '<p>Typed after the last autosave.</p>',
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('the reopened message still counts as unsaved', async () => {
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { await bar.onUndo(); });
    await React.act(async () => {});
    saved.length = 0;
    await hideTab();
    assert.equal(saved.length, 1, 'saved although nothing was typed since it reopened');
    assert.equal(saved[0].existingUid, 9);
    assert.match(saved[0].body, /Typed after the last autosave\./);
  });
});

describe('undo send while another message is being written', () => {
  // Keyed the way MailApp keys it.
  const Host = () => {
    const composing = useStore(s => s.composing);
    const session = useStore(s => s.composeSession);
    return composing ? React.createElement(ComposeModal, { key: session }) : null;
  };
  let unmount;
  let next = 0;
  before(async () => {
    useStore.setState({ plaintextEmail: false, notifications: [], composing: false, composeData: null });
    api.post = async () => ({ ok: true, pending: true, pendingId: `p-${++next}`, sendAt: new Date(Date.now() + 10_000).toISOString(), remainingMs: 10_000 });
    api.cancelSend = async () => ({ cancelled: true });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    unmount = () => React.act(async () => root.unmount());
  });
  after(async () => {
    // Signing out stops following the held sends, as it must for the next user of the tab.
    await React.act(async () => { useStore.setState({ user: { id: 'someone-else' } }); });
    assert.equal(useStore.getState().notifications.some(n => n.heldSendId), false, 'no Undo bar is left behind');
    await unmount();
  });

  const subjectField = () => document.querySelector('input[placeholder="compose.subject"]');
  const sendButton = () => [...document.querySelectorAll('button')].find(b => /compose\.(send|sending)$/.test(b.textContent.trim()));
  async function write(subject) {
    await React.act(async () => {
      useStore.getState().openCompose({ accountId: 'acct', to: ['Bob <bob@example.invalid>'], cc: [], subject, body: `<p>${subject} body</p>` });
    });
    await React.act(async () => {});
  }
  async function send() {
    await React.act(async () => { sendButton().click(); });
    await React.act(async () => {});
  }

  test('the undone message opens as itself once the open one is sent', async () => {
    await write('Plan A');
    await send();
    const undoA = useStore.getState().notifications.find(n => n.onUndo);
    await write('Plan B');
    await React.act(async () => { await undoA.onUndo(); });
    assert.equal(subjectField().value, 'Plan B', 'the message being written is left alone');

    await send();
    assert.equal(useStore.getState().composeData.subject, 'Plan A');
    assert.equal(subjectField().value, 'Plan A', 'the screen shows the reopened message, not the one just sent');
    assert.equal(sendButton().textContent.trim(), 'compose.send', 'and it can be sent again');
    assert.equal(sendButton().disabled, false);
  });
});

describe('pasting text copied from an email', () => {
  // What Chrome puts on the clipboard for a phrase copied out of an email shown as sent: the
  // words wrapped in the frame's white page and #1a1a1a text. utils/editorPaste.editor.test.js
  // covers the other shapes a copy takes; this checks the composer is wired to drop the colors.
  const COPIED = `<meta charset='utf-8'><span style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; display: inline !important; float: none;">ice resurfacer is booked for</span>`;
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  const posted = [];
  let unmount;
  before(async () => {
    useStore.setState({
      plaintextEmail: false, notifications: [], composing: false, composeData: null,
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    });
    api.post = async (path, payload) => { posted.push({ path, payload }); return { ok: true }; };
    useStore.getState().openCompose({ accountId: 'acct', to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Rink', body: '' });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('the message is sent without the colors of the email the text came from', async () => {
    const editor = document.querySelector('.ProseMirror').editor;
    // An explicit event, because jsdom has no ClipboardEvent for prosemirror-view to construct.
    await React.act(async () => { editor.view.pasteHTML(COPIED, new window.Event('paste')); });
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(posted.length, 1);
    assert.equal(posted[0].path, '/mail/send');
    assert.match(posted[0].payload.body, /ice resurfacer is booked for/);
    assert.doesNotMatch(posted[0].payload.body, /background-color|(?<![\w-])color\s*:/);
  });
});

describe('pasting into the signature and the quoted message', () => {
  // What Chrome puts on the clipboard for two paragraphs copied out of the message pane: each <p>
  // carries the email frame's white page and #1a1a1a text. utils/contentEditablePaste.test.js
  // covers the other shapes a copy takes; this checks both areas are wired to drop the colors.
  const PAGE = 'color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;';
  const COPIED = `<meta charset='utf-8'><p id="p1" style="${PAGE}">Hi Marty,</p><p id="p2" style="${PAGE}">The ice resurfacer is booked.</p>`;
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  const posted = [];

  // jsdom has no editing, so this stands in for the browser twice: insertHTML puts its HTML at
  // the caret and fires input, and a paste the page does not cancel inserts the clipboard's HTML
  // as it is, which is what the browser's own paste keeps of the colors.
  function insertAtCaret(target, html) {
    const selection = window.getSelection();
    let range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !target.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(range.createContextualFragment(html));
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  function paste(target, html) {
    document.execCommand = (command, showUi, value) => {
      if (command !== 'insertHTML') return false;
      insertAtCaret(target, value);
      return true;
    };
    try {
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      event.clipboardData = { getData: type => (type === 'text/html' ? html : '') };
      target.dispatchEvent(event);
      if (!event.defaultPrevented) insertAtCaret(target, html);
    } finally {
      delete document.execCommand;
    }
  }

  // Opens a reply with a signature and a quoted message, pastes the copy into both, and sends it.
  // Returns the payload the server was sent.
  async function pasteAndSend({ phone }) {
    posted.length = 0;
    useStore.setState({
      plaintextEmail: false, notifications: [], composing: false, composeData: null,
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff', signature: '<p>Marty Example</p>' }],
    });
    api.post = async (path, payload) => { posted.push({ path, payload }); return { ok: true }; };
    useStore.getState().openCompose({
      accountId: 'acct', isReply: true, to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Re: Rink', body: '',
      quotedBodyHtml: '<p>Original message</p>',
    });
    const width = window.innerWidth;
    if (phone) Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    const root = createRoot(document.getElementById('root'));
    try {
      await React.act(async () => { root.render(React.createElement(Host)); });
      await React.act(async () => {});
      const buttons = () => [...document.querySelectorAll('button')];
      // Only the phone layout shows Reply and Reply All side by side.
      assert.equal(buttons().some(b => b.textContent === 'compose.replyAll'), phone, 'precondition: the layout under test is rendered');
      const editable = (text) => [...document.querySelectorAll('[contenteditable]')].find(el => el.textContent.includes(text));
      const signature = editable('Marty Example');
      const quoted = editable('Original message');
      assert.ok(signature && quoted, 'precondition: the signature and the quoted message are editable');
      await React.act(async () => { paste(signature, COPIED); });
      await React.act(async () => { paste(quoted, COPIED); });
      await React.act(async () => { buttons().find(b => b.textContent.trim() === 'compose.send').click(); });
      await React.act(async () => {});
      assert.equal(posted.length, 1);
      return posted[0].payload;
    } finally {
      await React.act(async () => root.unmount());
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
    }
  }

  function assertNoCopiedColor({ editedSignature, quotedBodyHtml }) {
    for (const [name, html] of [['signature', editedSignature], ['quoted message', quotedBodyHtml]]) {
      assert.match(html, /The ice resurfacer is booked\./, `the paste reached the ${name}`);
      assert.doesNotMatch(html, /background-color|(?<![\w-])color\s*:/, `the ${name} carries no copied color`);
    }
  }

  test('the reply is sent without the colors of the email the text came from', async () => {
    assertNoCopiedColor(await pasteAndSend({ phone: false }));
  });

  test('and so it is from the phone layout, which has its own quoted message', async () => {
    assertNoCopiedColor(await pasteAndSend({ phone: true }));
  });
});
