// Editor-level tests for the composer's link mark.
//
// These exist because the unit tests next door (editorLink.test.js) do NOT prove the
// composer works. They assert the mark's `inclusive` flag and how ProseMirror applies marks
// to a hand-built document, which is a much weaker claim than "pasting a URL into the real
// editor behaves correctly". A change can satisfy every one of those assertions and still
// break pasting, because pasting goes through the paste rules, the autolink plugin, and the
// editor's own paste handling, none of which a schema-level test touches.
//
// So this file boots an actual Tiptap Editor against jsdom and pastes into it.
//
// The extension set here is deliberately just StarterKit plus the composer's link. The full
// ComposeModal list (TextStyle, Color, FontFamily, BackgroundColor, FontSize, TextAlign, the
// Table stack, Placeholder) plus its editorProps.handlePaste were verified to produce
// byte-identical results for every scenario below, so they are left out to keep this file
// from drifting out of sync with the component.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Tiptap reads browser globals at import time, so the DOM has to exist first. That rules out
// static imports here and is why the modules under test are pulled in with await import().
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'https://mailflow.test/',
});
const { window } = dom;

// jsdom has no ClipboardEvent, and prosemirror-view constructs one when simulating a paste.
if (!window.ClipboardEvent) {
  window.ClipboardEvent = class extends window.Event {
    constructor(type, init = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  };
}

for (const key of [
  'window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement', 'Event',
  'MouseEvent', 'KeyboardEvent', 'ClipboardEvent', 'MutationObserver', 'Range',
  'getComputedStyle',
]) {
  Object.defineProperty(globalThis, key, {
    value: key === 'window' ? window : window[key],
    configurable: true,
    writable: true,
  });
}
// navigator is a getter-only property on globalThis in Node, so it needs defineProperty.
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const { Editor } = await import('@tiptap/core');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { ComposerLink } = await import('./editorLink.js');

const URL_UNDER_TEST = 'https://example.com';
const ANCHOR = new RegExp(`<a [^>]*href="${URL_UNDER_TEST}"[^>]*>`);

const editors = [];

function makeEditor() {
  const element = window.document.createElement('div');
  window.document.getElementById('root').appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit.configure({ link: false }), ComposerLink],
    content: '<p></p>',
  });
  editor.commands.focus();
  editors.push(editor);
  return editor;
}

// The text of the anchor in the editor's HTML, or null when nothing is linked. This is the
// question that actually matters: which characters ended up inside the <a>.
function linkedText(html) {
  const m = html.match(/<a [^>]*>([^<]*)<\/a>/);
  return m ? m[1] : null;
}

after(() => { editors.forEach(e => { try { e.destroy(); } catch { /* already gone */ } }); });

describe('composer link: pasting', () => {
  test('a pasted URL becomes a link (plain text clipboard)', () => {
    const editor = makeEditor();
    editor.view.pasteText(URL_UNDER_TEST);
    assert.match(editor.getHTML(), ANCHOR);
    assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST);
  });

  test('a pasted URL becomes a link (text/html clipboard)', () => {
    // What a browser puts on the clipboard when you copy from a page or the address bar.
    const editor = makeEditor();
    editor.view.pasteHTML(URL_UNDER_TEST);
    assert.match(editor.getHTML(), ANCHOR);
  });

  test('a pasted URL wrapped in markup still becomes a link', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(`<meta charset="utf-8"><span style="color:#000">${URL_UNDER_TEST}</span>`);
    assert.match(editor.getHTML(), ANCHOR);
  });

  test('an already-anchored link survives the paste', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(`<a href="${URL_UNDER_TEST}">${URL_UNDER_TEST}</a>`);
    assert.match(editor.getHTML(), ANCHOR);
  });
});

describe('composer link: typing after a link (#415)', () => {
  test('text typed after a pasted URL stays OUT of the link', () => {
    const editor = makeEditor();
    editor.view.pasteText(URL_UNDER_TEST);
    editor.commands.insertContent(' tail');
    assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST,
      'the anchor must cover the URL only, not the text typed after it');
    assert.match(editor.getHTML(), /<\/a> tail/);
  });

  test('same when the URL arrived as text/html', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(URL_UNDER_TEST);
    editor.commands.insertContent(' tail');
    assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST);
  });

  test('a space typed after a pasted URL stays out of the link', () => {
    const editor = makeEditor();
    editor.view.pasteText(URL_UNDER_TEST);
    editor.commands.insertContent(' ');
    assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST);
  });

  test('it is not specific to space: any character stays out', () => {
    for (const ch of ['x', '!', '.']) {
      const editor = makeEditor();
      editor.view.pasteText(URL_UNDER_TEST);
      editor.commands.insertContent(ch);
      assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST, `"${ch}" must stay out of the link`);
    }
  });
});

describe('composer link: typed URLs still autolink', () => {
  test('typing a URL then a space creates a link', () => {
    // The regression guard that matters most: disabling autolink would also make the mark
    // non-inclusive and would satisfy every assertion above while silently breaking this.
    const editor = makeEditor();
    editor.commands.insertContent(URL_UNDER_TEST);
    editor.commands.insertContent(' ');
    assert.match(editor.getHTML(), ANCHOR);
    assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST);
  });

  test('typing past an autolinked URL does not extend it', () => {
    const editor = makeEditor();
    editor.commands.insertContent(URL_UNDER_TEST);
    editor.commands.insertContent(' ');
    editor.commands.insertContent('tail');
    assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST);
  });
});

describe('composer link: editor reuse', () => {
  test('the shared extension instance works across several editors', () => {
    // ComposerLink is a module-level singleton shared by every compose window.
    for (let i = 0; i < 3; i++) {
      const editor = makeEditor();
      editor.view.pasteText(URL_UNDER_TEST);
      editor.commands.insertContent(' tail');
      assert.equal(linkedText(editor.getHTML()), URL_UNDER_TEST, `editor #${i + 1} misbehaved`);
    }
  });
});
