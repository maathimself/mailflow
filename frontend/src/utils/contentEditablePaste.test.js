// Tests for pasting into the plain contenteditables (contentEditablePaste.js).
//
// The contents copied out of an email are what Chromium 152 wrote for selections in an email
// rendered in MessageBodyView's frame, as sent and, for HIGHLIGHT_AROUND_BOLD_SHOWN_DARK,
// recolored dark. They were captured from a drag of each selection, which Chrome serializes with
// the same code as a copy. utils/editorPaste.editor.test.js pastes the same captures and the
// other shapes a copy takes into the composer's editor. Unlike that editor, these keep the inline
// colors they are given, so the colors a copy across paragraphs puts on each <p> stay unless they
// are dropped here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported, so the DOM comes first.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mailflow.test/' });
for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'DocumentFragment']) {
  Object.defineProperty(globalThis, key, {
    value: key === 'window' ? dom.window : dom.window[key],
    configurable: true,
    writable: true,
  });
}

const { pasteWithoutPageColors } = await import('./contentEditablePaste.js');

const NBSP = String.fromCharCode(160);
// The styles Chrome writes for each copied run: everything in effect where the text sat.
const inEffect = (color, background) => `color: ${color}; font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: ${background}; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;`;
// MessageBodyView's frame: a white page with #1a1a1a text. A run of text also gets display and float.
const PAGE = inEffect('rgb(26, 26, 26)', 'rgb(255, 255, 255)');
const RUN = `${PAGE} display: inline !important; float: none;`;

const PHRASE = `<meta charset='utf-8'><span style="${RUN}">ice resurfacer is booked for</span>`;
const PARAGRAPHS = `<meta charset='utf-8'><p id="p1" style="${PAGE}">Hi Marty,</p><p id="p2" style="${PAGE}">The ice resurfacer is booked for<span>${NBSP}</span><b>Tuesday at 6am</b>. Details are on<span>${NBSP}</span><a rel="noopener noreferrer" href="https://example.com/schedule" style="color: rgb(99, 102, 241);">the schedule page</a>.</p>`;
// Two paragraphs and a list with the sender's own highlight and red words in them.
const PARAGRAPHS_AS_SENT = `<meta charset='utf-8'><p style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Please note:<span>${NBSP}</span><span id="hl" style="background-color: rgb(255, 255, 0);">the rink opens late</span><span>${NBSP}</span>on Friday.</p><ul style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li>First item with<span>${NBSP}</span><span style="color: rgb(192, 0, 0);">red words</span></li><li>Second item</li></ul>`;
// Three paragraphs of an email recolored dark: a highlight around bold text, which the
// recoloring gave an !important background of its own, red words it recolored, and the sender's
// red around bold words, which it left as written.
const HIGHLIGHT_AROUND_BOLD_SHOWN_DARK = `<meta charset='utf-8'><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Please note:<span>${NBSP}</span><span id="hl" style="background-color: rgb(21, 21, 0) !important;"><strong style="color: rgb(232, 232, 236) !important; -webkit-text-fill-color: currentcolor !important;">the rink opens late</strong></span><span>${NBSP}</span>on Friday.</p><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Second paragraph with<span>${NBSP}</span><span style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">red words</span>.</p><p style="font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(15, 15, 17); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; color: rgb(228, 228, 232) !important; -webkit-text-fill-color: currentcolor !important;">Third:<span>${NBSP}</span><span style="color: rgb(192, 0, 0);"><b style="color: rgb(255, 98, 80) !important; -webkit-text-fill-color: currentcolor !important;">bold red words</b></span><span>${NBSP}</span>end.</p>`;
const DARK_BLOCK = `<meta charset='utf-8'><span style="${inEffect('rgb(255, 255, 255)', 'rgb(17, 17, 17)')} display: inline !important; float: none;">Dark newsletter text block</span>`;
const LINE_WITH_HIGHLIGHT = `<meta charset='utf-8'><span style="${RUN}">Please note:<span>${NBSP}</span></span><span id="hl" style="color: rgb(26, 26, 26); font-family: -apple-system, Arial, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial; background-color: rgb(255, 255, 0);">the rink opens late</span><span style="${RUN}"><span>${NBSP}</span>on Friday.</span>`;

// Parse HTML back into elements, to read attributes the way the editor will hold them.
function parse(html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  return box;
}

// Every color the HTML still carries in its style attributes.
function colors(html) {
  return [...parse(html).querySelectorAll('[style]')].flatMap(el => el.getAttribute('style')
    .match(/(?:background(?:-color)?|(?<![\w-])color|-webkit-text-fill-color)\s*:[^;]*/gi) || []);
}

const text = html => parse(html).textContent.replaceAll(NBSP, ' ');

// jsdom has no editing commands, so insertHTML is a stand-in that records what the page inserts.
// It adds it to the editor and reports that it did, unless told it inserts nothing or reports
// otherwise.
function paste(data, { inserts = true, reports = inserts } = {}) {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', '');
  editor.innerHTML = '<p>Marty Example</p>';
  const inserted = [];
  document.execCommand = (command, showUi, value) => {
    inserted.push({ command, showUi, value });
    if (inserts) editor.insertAdjacentHTML('beforeend', value);
    return reports;
  };
  const event = { currentTarget: editor, defaultPrevented: false, clipboardData: { getData: type => data[type] ?? '' } };
  event.preventDefault = () => { event.defaultPrevented = true; };
  try {
    pasteWithoutPageColors(event);
  } finally {
    delete document.execCommand;
  }
  return { inserted, browserPastes: !event.defaultPrevented };
}

// The HTML the page inserts in place of the browser's own paste.
function pastedByPage(html) {
  const { inserted, browserPastes } = paste({ 'text/html': html });
  assert.deepEqual(inserted.map(({ command, showUi }) => [command, showUi]), [['insertHTML', false]], 'the page inserts the paste');
  assert.equal(browserPastes, false, 'and the browser does not paste it again');
  return inserted[0].value;
}

function assertPastedByBrowser(html) {
  const { inserted, browserPastes } = paste({ 'text/html': html });
  assert.equal(inserted.length, 0, 'the page inserts nothing');
  assert.equal(browserPastes, true, 'the browser pastes it as it is');
}

describe('text copied from an email', () => {
  test('a phrase loses the white page and the dark text, and keeps its font', () => {
    const html = pastedByPage(PHRASE);
    assert.equal(text(html), 'ice resurfacer is booked for');
    assert.deepEqual(colors(html), []);
    assert.match(parse(html).querySelector('span').getAttribute('style'), /font-family: -apple-system, Arial, sans-serif/);
  });

  test('paragraphs lose the page on each <p>, and keep their bold text and link', () => {
    const html = pastedByPage(PARAGRAPHS);
    const box = parse(html);
    assert.equal(box.querySelectorAll('p').length, 2);
    assert.equal(text(html), 'Hi Marty,The ice resurfacer is booked for Tuesday at 6am. Details are on the schedule page.');
    assert.equal(box.querySelector('b').textContent, 'Tuesday at 6am');
    assert.equal(box.querySelector('a').getAttribute('href'), 'https://example.com/schedule');
    // The link keeps the frame's link color, which Chrome writes on the <a> itself.
    assert.deepEqual(colors(html), ['color: rgb(99, 102, 241)']);
  });

  test('a copy across paragraphs keeps the sender\'s own highlight and red words', () => {
    const html = pastedByPage(PARAGRAPHS_AS_SENT);
    assert.equal(text(html), 'Please note: the rink opens late on Friday.First item with red wordsSecond item');
    assert.deepEqual(colors(html), ['background-color: rgb(255, 255, 0)', 'color: rgb(192, 0, 0)']);
  });

  test('a copy from an email recolored dark loses the recoloring, and keeps the red it left alone', () => {
    const html = pastedByPage(HIGHLIGHT_AROUND_BOLD_SHOWN_DARK);
    assert.match(text(html), /^Please note: the rink opens late on Friday\./);
    assert.deepEqual(colors(html), ['color: rgb(192, 0, 0)']);
  });

  test('white text from a dark block does not stay white', () => {
    const html = pastedByPage(DARK_BLOCK);
    assert.equal(text(html), 'Dark newsletter text block');
    assert.deepEqual(colors(html), []);
  });

  test('a highlight copied within a paragraph goes with the page around it', () => {
    // Chrome writes it in the same wrapper as the page, so the two cannot be told apart.
    const html = pastedByPage(LINE_WITH_HIGHLIGHT);
    assert.equal(text(html), 'Please note: the rink opens late on Friday.');
    assert.deepEqual(colors(html), []);
  });
});

describe('pastes the browser still makes itself', () => {
  test('colors from Word, Google Docs and Firefox', () => {
    assertPastedByBrowser("<p class=MsoNormal><span style='color:red;mso-fareast-language:EN-GB'>Do not reply to this thread</span></p>");
    assertPastedByBrowser('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-5f1c2d3e"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#ff0000;background-color:transparent;font-weight:400;">Do not reply to this thread</span></b>');
    assertPastedByBrowser('<p>Please note: <span style="background-color: #ffff00">the rink opens late</span>, <span style="color: #c00000">bring skates</span>.</p>');
  });

  test('HTML copied in the composer\'s own editor', () => {
    assertPastedByBrowser('<p data-pm-slice="1 1 []">keep <span style="background-color: #ffd43b">this highlight</span></p>');
  });

  test('an element with only some of the wrapper\'s properties, and text that mentions them', () => {
    assertPastedByBrowser('<span style="orphans: 2; widows: 2; color: rgb(192, 0, 0);">print styles</span> and <span style="-webkit-text-stroke-width: 1px; color: rgb(0, 0, 192);">an outline</span>');
    assertPastedByBrowser('<span style="color: rgb(192, 0, 0);">orphans: 2; widows: 2; -webkit-text-stroke-width: 0px</span>');
    // Nothing is dropped from this, though written back it would read differently (double quotes).
    assertPastedByBrowser("<meta charset='utf-8'><span style=\"-webkit-text-stroke-width: 1px; color: rgb(0, 0, 192);\">an outline</span>");
  });

  test('a paste without HTML', () => {
    const { inserted, browserPastes } = paste({ 'text/plain': 'just text' });
    assert.equal(inserted.length, 0);
    assert.equal(browserPastes, true);
  });

  test('a paste with nothing left once it is sanitized', () => {
    const { inserted, browserPastes } = paste({ 'text/html': `<script style="${PAGE}">steal()</script>` });
    assert.equal(inserted.length, 0);
    assert.equal(browserPastes, true);
  });

  test('a paste insertHTML refuses, rather than losing the text', () => {
    const { inserted, browserPastes } = paste({ 'text/html': PHRASE }, { inserts: false });
    assert.equal(inserted.length, 1);
    assert.equal(browserPastes, true);
  });
});

describe('a paste the page has inserted', () => {
  test('is not pasted again when insertHTML reports false for it, as Chrome can', () => {
    const { inserted, browserPastes } = paste({ 'text/html': PHRASE }, { reports: false });
    assert.equal(inserted.length, 1);
    assert.equal(browserPastes, false);
  });

  test('is not pasted again when insertHTML reports it inserted, even if the editor reads the same', () => {
    const { inserted, browserPastes } = paste({ 'text/html': PHRASE }, { inserts: false, reports: true });
    assert.equal(inserted.length, 1);
    assert.equal(browserPastes, false);
  });

  test('does not bring the wrapper and line breaks the Windows clipboard adds', () => {
    // How Chrome on Windows hands a paste the clipboard's HTML: from <html> on, with CRLFs.
    const windows = html => `<html>\r\n<body>\r\n<!--StartFragment-->${html}<!--EndFragment-->\r\n</body>\r\n</html>`;
    for (const copy of [PHRASE, PARAGRAPHS]) assert.equal(pastedByPage(windows(copy)), pastedByPage(copy));
  });
});

describe('what the page inserts itself', () => {
  test('scripts, event handlers, javascript: links and <style> blocks do not get in', () => {
    // The <style> comes after content, where Google Sheets puts it; a leading one would be parsed
    // into <head> and dropped regardless.
    const html = pastedByPage(
      `<p style="${PAGE}" onclick="steal()">a</p><style>body{display:none}</style><img src="x.png" onerror="steal()">`
      + '<a href="javascript:steal()">b</a><script>steal()</script>',
    );
    assert.doesNotMatch(html, /<style|onclick|onerror|javascript:|<script|steal/i);
    assert.equal(parse(html).querySelector('img').getAttribute('src'), 'x.png');
  });
});
