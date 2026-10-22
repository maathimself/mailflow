// Editor-level tests for what a paste brings into the composer (editorPaste.js).
//
// The contents copied out of an email are what Chromium 152 wrote for selections in an email
// rendered in MessageBodyView's frame, as sent and, for the *_SHOWN_DARK ones, recolored dark.
// They were captured from a drag of each selection, which Chrome serializes with the same code
// as a copy; the leading <meta charset> is what a copy adds. They are the point of these
// tests: the bug only exists because of how a browser serializes a copied selection, so a
// hand-written "<span style=background-color:...>" would prove less. The markup from other
// sources is written by hand in the shape those sources use: from Word, Google Docs and Firefox,
// whose colors have to stay, and FIREFOX_RECOLORED, Firefox's copy of a recolored email, whose
// recoloring has to go.

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
const { TextStyle, Color, FontFamily, BackgroundColor } = await import('@tiptap/extension-text-style');
const { ComposerLink } = await import('./editorLink.js');
const { PasteWithoutPageColors } = await import('./editorPaste.js');

// The wrapper Chrome puts around each copied run of text: every style in effect where the text
// sat. Byte for byte what it wrote, with only the two colors varying between captures.
const inEffect = (color, background) => `color: ${color}; font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: ${background}; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; display: inline !important; float: none;`;
// An email shown as sent: the frame's white page with #1a1a1a text.
const PAGE = inEffect('rgb(26, 26, 26)', 'rgb(255, 255, 255)');

// A few words from the middle of a paragraph.
const PHRASE = `<meta charset='utf-8'><span style="${PAGE}">ice resurfacer is booked for</span>`;

// The same words with the email shown dark (utils/darkBody.js, recolored with the default dark
// theme's palette): its text color on the theme's own page color.
const PHRASE_SHOWN_DARK = `<meta charset='utf-8'><span style="${inEffect('rgb(228, 228, 232)', 'rgb(15, 15, 17)')}">ice resurfacer is booked for</span>`;

// From "Please note:" to the end of a two-item list, in the same email shown dark, with a list
// added after the second paragraph whose first item has red words. A copy that spans paragraphs
// puts Chrome's wrapper on the blocks; each element inside keeps its own inline style, here the
// recoloring's.
const PARAGRAPHS_SHOWN_DARK = `<meta charset='utf-8'><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Please note:<span>\u00a0</span><span id="hl" style="background-color: rgb(21, 21, 0) !important; color: rgb(232, 232, 236) !important; -webkit-text-fill-color: currentcolor !important;">the rink opens late</span><span>\u00a0</span>on Friday.</p><ul style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li style="color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">First item with<span>\u00a0</span><span style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">red words</span></li><li style="color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Second item</li></ul>`;

// Three paragraphs of another email recolored dark. The highlight's text sits in a <strong>, so
// the recoloring gives the highlight an !important background of its own and the
// -webkit-text-fill-color marker only to the <strong>. The third paragraph has the sender's red
// around bold words: the recoloring rewrote the <b>, and left the red as written.
const HIGHLIGHT_AROUND_BOLD_SHOWN_DARK = `<meta charset='utf-8'><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Please note:<span>\u00a0</span><span id="hl" style="background-color: rgb(21, 21, 0) !important;"><strong style="color: rgb(232, 232, 236) !important; -webkit-text-fill-color: currentcolor !important;">the rink opens late</strong></span><span>\u00a0</span>on Friday.</p><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Second paragraph with<span>\u00a0</span><span style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">red words</span>.</p><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Third:<span>\u00a0</span><span style="color: rgb(192, 0, 0);"><b style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">bold red words</b></span><span>\u00a0</span>end.</p>`;

// Two paragraphs of an email recolored dark: the sender's red around bold words, written
// !important, which the recoloring left alone (it rewrote the <b>), then a highlight around bold
// words, which it gave an !important background of its own.
const IMPORTANT_RED_SHOWN_DARK = `<meta charset='utf-8'><p id="a" style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Note:<span>\u00a0</span><span style="color: rgb(192, 0, 0) !important;"><b style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">bold red words</b></span><span>\u00a0</span>end.</p><p id="z" style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Second:<span>\u00a0</span><span style="background-color: rgb(21, 21, 0) !important;"><strong style="color: rgb(232, 232, 236) !important; -webkit-text-fill-color: currentcolor !important;">highlight words</strong></span><span>\u00a0</span>here.</p>`;

// The same two paragraphs shown as sent: the sender's !important red and its highlight.
const IMPORTANT_RED_AS_SENT = `<meta charset='utf-8'><p id="a" style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Note:<span>\u00a0</span><span style="color: rgb(192, 0, 0) !important;"><b>bold red words</b></span><span>\u00a0</span>end.</p><p id="z" style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Second:<span>\u00a0</span><span style="background-color: rgb(255, 255, 0);"><strong>highlight words</strong></span><span>\u00a0</span>here.</p>`;

// Two paragraphs of an email shown as sent, its highlight written !important around bold words.
const IMPORTANT_HIGHLIGHT_AS_SENT = `<meta charset='utf-8'><p style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Note:<span>\u00a0</span><span style="background-color: rgb(255, 255, 0) !important;"><strong>important highlight</strong></span><span>\u00a0</span>end.</p><p style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Second line here.</p>`;

// Two paragraphs of an email shown as sent: the sender's !important red around bold words and a
// plain highlight, then a button that writes its own fill marker over a plain dark background.
const BUTTON_FILL_MARKER_AS_SENT = `<meta charset='utf-8'><p style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Note:<span>\u00a0</span><span style="color: rgb(192, 0, 0) !important;"><b>bold red words</b></span><span>\u00a0</span>and<span>\u00a0</span><span style="background-color: rgb(255, 255, 0);">a highlight</span><span>\u00a0</span>end.</p><p style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Button:<span>\u00a0</span><span style="background-color: rgb(17, 17, 17); color: rgb(255, 255, 255) !important; -webkit-text-fill-color: rgb(255, 255, 255) !important;">Sign up</span><span>\u00a0</span>here.</p>`;

// A phrase whose middle words sit in a highlight written as the background shorthand, which
// Chrome keeps as the shorthand inside its wrapper.
const BACKGROUND_SHORTHAND = `<meta charset='utf-8'><span style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; display: inline !important; float: none;">note:<span>\u00a0</span></span><span style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; background: rgb(255, 255, 0);">the rink opens late</span><span style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; display: inline !important; float: none;"><span>\u00a0</span>on Fri</span>`;

// A recolored email as Firefox puts it on the clipboard (written by hand in its shape, as on
// Windows): the recolored markup as it stands, with the recoloring's marker and no wrapper.
const FIREFOX_RECOLORED = `<html><body>\n<!--StartFragment--><p style="color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Please note: <span id="hl" style="background-color: rgb(21, 21, 0) !important;"><strong style="color: rgb(232, 232, 236) !important; -webkit-text-fill-color: currentcolor !important;">the rink opens late</strong></span> on Friday.</p><p style="color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Second paragraph with <span style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">red words</span>.</p><!--EndFragment-->\n</body>\n</html>`;

// The same selection out of the email shown as sent: the elements inside carry the sender's own
// highlight and red words, and no wrapper of their own.
const PARAGRAPHS_AS_SENT = `<meta charset='utf-8'><p style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Please note:<span>\u00a0</span><span id="hl" style="background-color: rgb(255, 255, 0);">the rink opens late</span><span>\u00a0</span>on Friday.</p><ul style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li>First item with<span>\u00a0</span><span style="color: rgb(192, 0, 0);">red words</span></li><li>Second item</li></ul>`;

// A sentence with bold text and a link in it. Chrome writes the colors onto the <b> and the
// <a> too, which the composer has never kept; the spans around them are what carried color.
const SENTENCE = `<meta charset='utf-8'><span style="${PAGE}">booked for<span>\u00a0</span></span><b style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Tuesday at 6am</b><span style="${PAGE}">. Details are on<span>\u00a0</span></span><a rel="noopener noreferrer" href="https://example.com/schedule" style="color: rgb(99, 102, 241); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255);">the schedule</a>`;

// Text from a newsletter's dark block: white on rgb(17, 17, 17).
const DARK_BLOCK = `<meta charset='utf-8'><span style="${inEffect('rgb(255, 255, 255)', 'rgb(17, 17, 17)')}">Dark newsletter text block</span>`;

// A line with a yellow highlight in the middle. Chrome writes the highlight in the same wrapper
// as the page around it, so within a paragraph the two cannot be told apart.
const LINE_WITH_HIGHLIGHT = `<meta charset='utf-8'><span style="${PAGE}">Please note:<span>\u00a0</span></span><span id="hl" style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; background-color: rgb(255, 255, 0);">the rink opens late</span><span style="${PAGE}"><span>\u00a0</span>on Friday.</span>`;

const editors = [];

function makeEditor(content = '<p></p>') {
  const element = window.document.createElement('div');
  window.document.getElementById('root').appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ link: false }), ComposerLink,
      TextStyle, Color, FontFamily, BackgroundColor,
      PasteWithoutPageColors,
    ],
    content,
  });
  editor.commands.focus('end');
  editors.push(editor);
  return editor;
}

// Every color declaration in the editor's HTML, which is the body that gets sent.
function colors(editor) {
  return editor.getHTML().match(/(?:background-color|(?<![\w-])color)\s*:[^;"]*/g) || [];
}

// The editor's text, with Chrome's no-break spaces read as the spaces they stand for.
function text(editor) {
  return editor.getText().replace(/\u00a0/g, ' ');
}

// Each run of text in the document with the background its mark carries, or null. Read from
// the document because getHTML rewrites colors as rgb(), which hides whether two runs agree.
function backgrounds(editor) {
  const runs = [];
  editor.state.doc.descendants(node => {
    if (node.isText) runs.push([node.text, node.marks.find(m => m.type.name === 'textStyle')?.attrs.backgroundColor ?? null]);
  });
  return runs;
}

// The document position range of the first text node that reads `wanted`.
function rangeOf(editor, wanted) {
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.isText && node.text === wanted) found = { from: pos, to: pos + node.nodeSize };
  });
  return found;
}

after(() => { editors.forEach(e => { try { e.destroy(); } catch { /* already gone */ } }); });

describe('pasting text copied from an email', () => {
  test('a phrase does not bring the white page or the dark text with it', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(PHRASE);
    assert.match(editor.getHTML(), /ice resurfacer is booked for/);
    assert.deepEqual(colors(editor), []);
  });

  test('a phrase from an email shown dark does not bring the dark page with it', () => {
    // It hardly shows in the dark composer, but a recipient reading on white gets a black box.
    const editor = makeEditor();
    editor.view.pasteHTML(PHRASE_SHOWN_DARK);
    assert.match(editor.getHTML(), /ice resurfacer is booked for/);
    assert.deepEqual(colors(editor), []);
  });

  test('the recoloring inside a copy that spans paragraphs goes too', () => {
    // Pasted at the end of a paragraph, the first block joins it, as an open slice should.
    const editor = makeEditor('<p>Typed first. </p>');
    editor.view.pasteHTML(PARAGRAPHS_SHOWN_DARK);
    assert.match(text(editor), /^Typed first\.Please note: the rink opens late on Friday\./);
    assert.match(editor.getHTML(), /<li><p>First item with/);
    assert.deepEqual(colors(editor), []);
    assert.doesNotMatch(editor.getHTML(), /<span>/, 'a span left with no style becomes no span');
  });

  test('a recolored copy loses the background the recoloring gave a highlight around bold text', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(HIGHLIGHT_AROUND_BOLD_SHOWN_DARK);
    assert.match(text(editor), /Please note: the rink opens late on Friday\./);
    // The sender's red around the bold words was never recolored, so it stays.
    assert.deepEqual(colors(editor), ['color: rgb(192, 0, 0)']);
  });

  test('a highlight Chrome writes as the background shorthand goes too', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(BACKGROUND_SHORTHAND);
    assert.match(text(editor), /the rink opens late/);
    assert.deepEqual(colors(editor), []);
  });

  test('a recolored copy as Firefox writes it, without Chrome\'s wrapper, loses the recoloring', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(FIREFOX_RECOLORED);
    assert.match(text(editor), /Please note: the rink opens late on Friday\./);
    assert.deepEqual(colors(editor), []);
  });

  test('what is typed after the paste is not inside a colored box either', () => {
    // The mark is inclusive, so before the fix this text joined the white box.
    const editor = makeEditor('<p>Typed first.</p>');
    editor.view.pasteHTML(PHRASE);
    editor.commands.insertContent(' and typed after.');
    assert.match(editor.getHTML(), /ice resurfacer is booked for and typed after\./);
    assert.deepEqual(colors(editor), []);
  });

  test('white text from a dark block does not stay white', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(DARK_BLOCK);
    assert.match(editor.getHTML(), /Dark newsletter text block/);
    assert.deepEqual(colors(editor), []);
  });

  test('a highlight inside the copied line goes with the page around it', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(LINE_WITH_HIGHLIGHT);
    assert.equal(text(editor), 'Please note: the rink opens late on Friday.');
    assert.deepEqual(colors(editor), []);
  });

  test('bold, links and the font are kept', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(SENTENCE);
    const html = editor.getHTML();
    assert.equal(text(editor), 'booked for Tuesday at 6am. Details are on the schedule');
    assert.match(html, /<strong>Tuesday at 6am<\/strong>/);
    assert.match(html, /<a [^>]*href="https:\/\/example\.com\/schedule"[^>]*>the schedule<\/a>/);
    assert.match(html, /font-family: -apple-system, Arial, sans-serif/);
    assert.deepEqual(colors(editor), []);
  });

});

describe('colors that someone chose', () => {
  test('a copy that spans paragraphs from an email shown as sent keeps the sender\'s own', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(PARAGRAPHS_AS_SENT);
    assert.match(editor.getHTML(), /<li><p>First item with/);
    assert.deepEqual(colors(editor), ['background-color: rgb(255, 255, 0)', 'color: rgb(192, 0, 0)']);
  });

  test('a recolored copy keeps the sender\'s !important red that the recoloring left alone', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(IMPORTANT_RED_SHOWN_DARK);
    assert.deepEqual(colors(editor), ['color: rgb(192, 0, 0) !important']);
  });

  test('a copy as sent keeps the sender\'s !important red and its highlight', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(IMPORTANT_RED_AS_SENT);
    assert.deepEqual(colors(editor), ['color: rgb(192, 0, 0) !important', 'background-color: rgb(255, 255, 0)']);
  });

  test('a copy as sent keeps the sender\'s !important highlight', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(IMPORTANT_HIGHLIGHT_AS_SENT);
    assert.deepEqual(colors(editor), ['background-color: rgb(255, 255, 0) !important']);
  });

  test('an email\'s own fill marker costs that element all its colors, and only that element', () => {
    // Indistinguishable from the recoloring's, so the button's colors go, its plain background
    // too: on its own that would be dark under the text. The red and the highlight stay.
    const editor = makeEditor();
    editor.view.pasteHTML(BUTTON_FILL_MARKER_AS_SENT);
    assert.match(text(editor), /Sign up/);
    assert.deepEqual(colors(editor), ['color: rgb(192, 0, 0) !important', 'background-color: rgb(255, 255, 0)']);
  });

  test('markup as written, as Firefox copies it, keeps its colors', () => {
    const editor = makeEditor();
    editor.view.pasteHTML('<p>Please note: <span style="background-color: #ffff00">the rink opens late</span>, <span style="color: #c00000">bring skates</span>.</p>');
    assert.deepEqual(colors(editor), ['background-color: rgb(255, 255, 0)', 'color: rgb(192, 0, 0)']);
  });

  test('a red line from Google Docs keeps its color', () => {
    const editor = makeEditor();
    editor.view.pasteHTML('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-5f1c2d3e"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#ff0000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Do not reply to this thread</span></b>');
    assert.deepEqual(colors(editor), ['color: rgb(255, 0, 0)', 'background-color: transparent']);
  });

  test('a red line from Word keeps its color', () => {
    const editor = makeEditor();
    editor.view.pasteHTML("<p class=MsoNormal><span style='color:red;mso-fareast-language:EN-GB'>Do not reply to this thread</span></p>");
    assert.deepEqual(colors(editor), ['color: red']);
  });

  test('Chrome\'s wrapper needs all three of its properties on the one element', () => {
    const editor = makeEditor();
    editor.view.pasteHTML('<span style="orphans: 2; widows: 2; color: rgb(192, 0, 0);">print styles</span> and <span style="-webkit-text-stroke-width: 1px; color: rgb(0, 0, 192);">an outline</span>');
    assert.deepEqual(colors(editor), ['color: rgb(192, 0, 0)', 'color: rgb(0, 0, 192)']);
  });

  test('text that mentions the wrapper\'s properties is not the wrapper', () => {
    const editor = makeEditor();
    editor.view.pasteHTML('<span style="color: rgb(192, 0, 0);">orphans: 2; widows: 2; -webkit-text-stroke-width: 0px</span>');
    assert.deepEqual(colors(editor), ['color: rgb(192, 0, 0)']);
  });
});

describe('colors the user applied in the composer', () => {
  const HIGHLIGHTED = '<p>keep <span style="background-color: #ffd43b">this highlight</span> please</p>';

  test('survive being copied and pasted within the draft', () => {
    const editor = makeEditor(HIGHLIGHTED);
    const { from, to } = rangeOf(editor, 'this highlight');
    editor.commands.setTextSelection({ from, to });
    const { dom: copied } = editor.view.serializeForClipboard(editor.state.selection.content());
    assert.match(copied.outerHTML, /data-pm-slice/, 'precondition: this is the editor\'s own clipboard HTML');
    editor.commands.focus('end');
    editor.view.pasteHTML(copied.innerHTML);
    const copies = backgrounds(editor).filter(([run]) => run === 'this highlight');
    assert.equal(copies.length, 2);
    assert.ok(copies.every(([, background]) => background), 'the pasted copy keeps the highlight as well');
  });

  test('survive being dragged within the draft', () => {
    const editor = makeEditor(HIGHLIGHTED);
    const { view } = editor;
    const { from, to } = rangeOf(editor, 'this highlight');
    editor.commands.setTextSelection({ from, to });
    const data = {};
    const dataTransfer = { files: [], clearData() {}, setData(type, value) { data[type] = value; }, getData: type => data[type] ?? '' };
    const fire = type => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer, clientX: 0, clientY: 0 });
      view.dom.dispatchEvent(event);
    };
    // jsdom has no layout, so where the drag starts and ends is given rather than measured.
    view.posAtCoords = () => ({ pos: from, inside: -1 });
    fire('dragstart');
    view.posAtCoords = () => ({ pos: 1, inside: -1 });
    fire('drop');
    assert.equal(text(editor), 'this highlightkeep  please');
    // Compared by run: stripped, the text would merge into the unmarked text beside it.
    assert.deepEqual(backgrounds(editor).filter(([run]) => run.includes('highlight')), [['this highlight', '#ffd43b']]);
  });

  test('carry over to plain text pasted inside them, as they do to typing', () => {
    const editor = makeEditor('<p><span style="background-color: #ffd43b">highlighted</span></p>');
    editor.commands.setTextSelection(rangeOf(editor, 'highlighted').from + 4);
    editor.view.pasteText('LY ');
    assert.equal(text(editor), 'highLY lighted');
    assert.ok(backgrounds(editor).every(([, background]) => background), 'the pasted text is highlighted too');
  });
});
