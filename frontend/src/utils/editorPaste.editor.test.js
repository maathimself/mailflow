// Editor-level tests for what a paste brings into the composer (editorPaste.js).
//
// The clipboard contents below are what Chrome 152 wrote for selections in an email rendered
// in MessageBodyView's frame, as sent and, for the two *_SHOWN_DARK, shown dark. They were
// captured from a drag of each selection, which Chrome serialises with the same code as a
// copy; the leading <meta charset> is what a copy adds.
// They are the point of these tests: the bug only exists because of how a browser serialises
// a copied selection, so a hand-written "<span style=background-color:...>" would prove less.

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
const { PasteWithoutSourceColors } = await import('./editorPaste.js');

// The wrapper Chrome puts around each copied run of text: every style in effect where the text
// sat. Byte for byte what it wrote, with only the two colours varying between captures.
const inEffect = (color, background) => `color: ${color}; font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: ${background}; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; display: inline !important; float: none;`;
// An email shown as sent: the frame's white page with #1a1a1a text.
const PAGE = inEffect('rgb(26, 26, 26)', 'rgb(255, 255, 255)');

// A few words from the middle of a paragraph.
const PHRASE = `<meta charset='utf-8'><span style="${PAGE}">ice resurfacer is booked for</span>`;

// The same words with the email shown dark (utils/darkBody.js, recoloured with the default dark
// theme's palette): its text colour on the theme's own page colour.
const PHRASE_SHOWN_DARK = `<meta charset='utf-8'><span style="${inEffect('rgb(228, 228, 232)', 'rgb(15, 15, 17)')}">ice resurfacer is booked for</span>`;

// From "Please note:" to the end of a two-item list, in the same email shown dark, with a list
// added after the second paragraph whose first item has red words. A copy that spans paragraphs
// puts the page's colours on the blocks, which the composer drops; each element inside keeps
// its own inline style, here the recolouring's.
const PARAGRAPHS_SHOWN_DARK = `<meta charset='utf-8'><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Please note:<span>\u00a0</span><span id="hl" style="background-color: rgb(21, 21, 0) !important; color: rgb(232, 232, 236) !important; -webkit-text-fill-color: currentcolor !important;">the rink opens late</span><span>\u00a0</span>on Friday.</p><ul style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li style="color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">First item with<span>\u00a0</span><span style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">red words</span></li><li style="color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Second item</li></ul>`;

// A sentence with bold text and a link in it. Chrome writes the colours onto the <b> and the
// <a> too, which the composer has never kept; the spans around them are what carried colour.
const SENTENCE = `<meta charset='utf-8'><span style="${PAGE}">booked for<span>\u00a0</span></span><b style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Tuesday at 6am</b><span style="${PAGE}">. Details are on<span>\u00a0</span></span><a rel="noopener noreferrer" href="https://example.com/schedule" style="color: rgb(99, 102, 241); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255);">the schedule</a>`;

// Text from a newsletter's dark block: white on rgb(17, 17, 17).
const DARK_BLOCK = `<meta charset='utf-8'><span style="${inEffect('rgb(255, 255, 255)', 'rgb(17, 17, 17)')}">Dark newsletter text block</span>`;

// A line with a yellow highlight in the middle. The highlight is written the same way as the
// page around it, which is why it cannot be told apart and kept.
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
      PasteWithoutSourceColors,
    ],
    content,
  });
  editor.commands.focus('end');
  editors.push(editor);
  return editor;
}

// Every colour declaration in the editor's HTML, which is the body that gets sent.
function colours(editor) {
  return editor.getHTML().match(/(?:background-color|(?<![\w-])color)\s*:[^;"]*/g) || [];
}

// The editor's text, with Chrome's no-break spaces read as the spaces they stand for.
function text(editor) {
  return editor.getText().replace(/\u00a0/g, ' ');
}

// Each run of text in the document with the background its mark carries, or null. Read from
// the document because getHTML rewrites colours as rgb(), which hides whether two runs agree.
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
    assert.deepEqual(colours(editor), []);
  });

  test('a phrase from an email shown dark does not bring the dark page with it', () => {
    // It hardly shows in the dark composer, but a recipient reading on white gets a black box.
    const editor = makeEditor();
    editor.view.pasteHTML(PHRASE_SHOWN_DARK);
    assert.match(editor.getHTML(), /ice resurfacer is booked for/);
    assert.deepEqual(colours(editor), []);
  });

  test('colours inside a copy that spans paragraphs go too', () => {
    // Pasted at the end of a paragraph, the first block joins it, as an open slice should.
    const editor = makeEditor('<p>Typed first. </p>');
    editor.view.pasteHTML(PARAGRAPHS_SHOWN_DARK);
    assert.match(text(editor), /^Typed first\.Please note: the rink opens late on Friday\./);
    assert.match(editor.getHTML(), /<li><p>First item with/);
    assert.deepEqual(colours(editor), []);
  });

  test('what is typed after the paste is not inside a coloured box either', () => {
    // The mark is inclusive, so before the fix this text joined the white box.
    const editor = makeEditor('<p>Typed first.</p>');
    editor.view.pasteHTML(PHRASE);
    editor.commands.insertContent(' and typed after.');
    assert.match(editor.getHTML(), /ice resurfacer is booked for and typed after\./);
    assert.deepEqual(colours(editor), []);
  });

  test('white text from a dark block does not stay white', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(DARK_BLOCK);
    assert.match(editor.getHTML(), /Dark newsletter text block/);
    assert.deepEqual(colours(editor), []);
  });

  test('a highlight inside the copied line goes with the page around it', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(LINE_WITH_HIGHLIGHT);
    assert.equal(text(editor), 'Please note: the rink opens late on Friday.');
    assert.deepEqual(colours(editor), []);
  });

  test('bold, links and the font are kept', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(SENTENCE);
    const html = editor.getHTML();
    assert.equal(text(editor), 'booked for Tuesday at 6am. Details are on the schedule');
    assert.match(html, /<strong>Tuesday at 6am<\/strong>/);
    assert.match(html, /<a [^>]*href="https:\/\/example\.com\/schedule"[^>]*>the schedule<\/a>/);
    assert.match(html, /font-family: -apple-system, Arial, sans-serif/);
    assert.deepEqual(colours(editor), []);
  });

  test('text that only mentions data-pm-slice does not pass for the editor\'s own copy', () => {
    const editor = makeEditor();
    editor.view.pasteHTML(`<meta charset='utf-8'><span style="${PAGE}">set data-pm-slice="1 1 []" on the first block</span>`);
    assert.deepEqual(colours(editor), []);
  });

  test('a span that carried only colours leaves no empty span behind', () => {
    const editor = makeEditor();
    editor.view.pasteHTML('<span style="color:#000000;background-color:transparent">plain words</span>');
    assert.equal(editor.getHTML(), '<p>plain words</p>');
  });
});

describe('colours the user applied in the composer', () => {
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
