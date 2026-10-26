// Run with: node --test src/utils/printMessage.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { buildPrintDocument, capturePrintSelection, openPrintWindow, printInWindow } = await import('./printMessage.js');

const A = {
  subject: 'Invoice <42> & receipt', from_name: 'Ana', from_email: 'ana@example.test',
  to_addresses: [{ name: 'Me', email: 'me@example.test' }], cc_addresses: [],
  date: '2026-09-01T10:00:00Z',
};
const B = { ...A, subject: 'Re: Invoice <42> & receipt', from_name: '', from_email: 'me@example.test', cc_addresses: '[{"email":"cc@example.test"}]' };

describe('buildPrintDocument', () => {
  it('blocks scripts in the print window and escapes the subject', () => {
    const html = buildPrintDocument([{ message: A, body: { text: 'hi' } }]);
    assert.match(html, /Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none';"/);
    assert.match(html, /<title>Invoice &lt;42&gt; &amp; receipt<\/title>/);
    assert.match(html, /<h1>Invoice &lt;42&gt; &amp; receipt<\/h1>/);
  });

  // A body served with remote images blocked prints without them, whatever the email's HTML still
  // references: the print window's CSP forbids remote loads, as the email frame's does.
  it('forbids remote loads when a printed body was served with remote images blocked', () => {
    const blocked = buildPrintDocument([{ message: A, body: { html: '<p>x</p>', remoteImagesBlocked: true } }]);
    assert.match(blocked, /base-uri 'none'; img-src data: blob:; font-src data:; media-src data: blob:;"/);
    const conversation = buildPrintDocument([
      { message: A, body: { html: '<p>allowed</p>', remoteImagesBlocked: false } },
      { message: B, body: { html: '<p>blocked</p>', remoteImagesBlocked: true } },
    ]);
    assert.match(conversation, /img-src data: blob:;/, 'any blocked message is enough');
    const allowed = buildPrintDocument([{ message: A, body: { html: '<p>x</p>', remoteImagesBlocked: false } }]);
    assert.doesNotMatch(allowed, /img-src/);
  });

  it('loads proxied images from MailFlow alone', () => {
    const proxied = buildPrintDocument([{ message: A, body: { html: '<p>x</p>', remoteImagesProxied: true } }]);
    assert.match(proxied, /base-uri 'none'; img-src 'self' data: blob:; font-src data:; media-src data: blob:;"/);
    const mixed = buildPrintDocument([
      { message: A, body: { html: '<p>x</p>', remoteImagesProxied: true } },
      { message: B, body: { html: '<p>y</p>', remoteImagesBlocked: true } },
    ]);
    assert.match(mixed, /img-src data: blob:;/, 'a blocked message wins');
    assert.doesNotMatch(mixed, /img-src 'self'/);
  });

  it('strips script and event handlers from an HTML body', () => {
    const html = buildPrintDocument([{ message: A, body: { html: '<p onclick="x()">Hello</p><script>alert(1)</script><img src=x onerror="y()">' } }]);
    assert.match(html, /<p>Hello<\/p>/);
    assert.doesNotMatch(html, /<script>alert|onclick|onerror/);
  });

  it('escapes a plain-text body instead of rendering it', () => {
    const html = buildPrintDocument([{ message: A, body: { text: '<b>not bold</b>' } }]);
    assert.match(html, /&lt;b&gt;not bold&lt;\/b&gt;/);
  });

  it('prints sender, recipients and date, and Cc only when there is one', () => {
    const one = buildPrintDocument([{ message: A, body: null }]);
    assert.match(one, /<span>From:<\/span> Ana &lt;ana@example.test&gt;/);
    assert.match(one, /<span>To:<\/span> Me &lt;me@example.test&gt;/);
    assert.doesNotMatch(one, /Cc:/);
    const cc = buildPrintDocument([{ message: B, body: null }]);
    assert.match(cc, /<span>Cc:<\/span> cc@example.test/);
  });

  it('prints a conversation under one title, every message in order with its own header', () => {
    const html = buildPrintDocument([{ message: A, body: { text: 'first body' } }, { message: B, body: { html: '<p>second body</p>' } }]);
    assert.equal(html.match(/<h1>/g).length, 1);
    assert.match(html, /<h1>Invoice &lt;42&gt; &amp; receipt<\/h1>/);
    const first = html.indexOf('first body'), second = html.indexOf('second body');
    assert.ok(first > 0 && second > first, 'both bodies, in reading order');
    assert.equal(html.match(/<span>From:<\/span>/g).length, 2);
  });
});

function fakeWindow() {
  const writes = [];
  return {
    writes, closed: false, printed: 0,
    document: { open() { writes.length = 0; }, write(h) { writes.push(h); }, close() {} },
    focus() {}, print() { this.printed++; },
  };
}

describe('print window', () => {
  it('captures selected email HTML and the current accent before opening a desktop preview', async () => {
    document.body.innerHTML = '<div id="email"><p>Keep <b>this part</b></p></div><p id="other">Other content</p>';
    const root = document.getElementById('email');
    const range = document.createRange();
    range.selectNodeContents(root.querySelector('b'));
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    document.documentElement.style.setProperty('--accent', '#123abc');
    const win = fakeWindow();
    let context;
    dom.window.open = () => { document.getSelection().removeAllRanges(); return win; };
    dom.window.mailflowNative = { printing: { preview: async (_name, metadata) => { context = metadata; } } };
    try {
      await printInWindow(openPrintWindow('', root), '<html>full email</html>');
      assert.equal(context.selectionHtml, 'this part');
      assert.equal(context.accent, '#123abc');
      range.selectNodeContents(document.getElementById('other'));
      document.getSelection().addRange(range);
      assert.equal(capturePrintSelection(root), '', 'selection elsewhere is excluded');
    } finally {
      delete dom.window.mailflowNative;
      document.getSelection().removeAllRanges();
      document.body.replaceChildren();
      document.documentElement.style.removeProperty('--accent');
    }
  });

  it('captures iframe selections, strips handlers, and preserves plain-text whitespace', () => {
    document.body.innerHTML = '<div id="email"><iframe></iframe><pre>first\nsecond</pre></div>';
    const root = document.getElementById('email');
    const frameDoc = root.querySelector('iframe').contentDocument;
    frameDoc.body.innerHTML = '<p onclick="bad()">Selected <b>email</b><script>bad()</script></p>';
    const range = frameDoc.createRange();
    range.selectNodeContents(frameDoc.body);
    frameDoc.getSelection().addRange(range);
    const html = capturePrintSelection(root);
    assert.match(html, /Selected <b>email<\/b>/);
    assert.doesNotMatch(html, /onclick|script/);
    frameDoc.getSelection().removeAllRanges();
    const textRange = document.createRange();
    textRange.selectNodeContents(root.querySelector('pre'));
    document.getSelection().addRange(textRange);
    assert.match(capturePrintSelection(root), /<pre style="white-space: pre-wrap;">first\nsecond<\/pre>/);
    document.getSelection().removeAllRanges();
    document.body.replaceChildren();
  });

  it('uses the desktop preview without focusing or printing the hidden document', async () => {
    const win = fakeWindow();
    win.name = 'mailflow-print-42';
    let previewName;
    dom.window.mailflowNative = { printing: { preview: async name => { previewName = name; } } };
    try {
      await printInWindow(win, '<html>email</html>');
      assert.equal(previewName, win.name);
      assert.deepEqual(win.writes, ['<html>email</html>']);
      assert.equal(win.printed, 0);
    } finally { delete dom.window.mailflowNative; }
  });

  it('opens uniquely named blank windows permitted by the desktop shell', () => {
    const calls = [];
    dom.window.open = (...args) => { calls.push(args); return fakeWindow(); };
    openPrintWindow();
    openPrintWindow();
    assert.equal(calls[0][0], '');
    assert.match(calls[0][1], /^mailflow-print-\d+$/);
    assert.match(calls[1][1], /^mailflow-print-\d+$/);
    assert.notEqual(calls[0][1], calls[1][1]);
  });

  it('shows a placeholder while the conversation loads', () => {
    const win = fakeWindow();
    win.opener = dom.window;
    dom.window.open = () => win;
    globalThis.window.open = dom.window.open;
    assert.equal(openPrintWindow('Preparing <to> print'), win);
    assert.equal(win.opener, null, 'email cannot reach the main window native bridge through its opener');
    assert.match(win.writes.join(''), /Preparing &lt;to&gt; print/);
  });

  it('replaces the placeholder with the document and prints it', () => {
    const win = fakeWindow();
    win.document.write('placeholder');
    printInWindow(win, '<html>doc</html>');
    assert.deepEqual(win.writes, ['<html>doc</html>']);
    assert.equal(win.printed, 1);
  });

  it('leaves a window the user already closed alone', () => {
    const win = fakeWindow();
    win.closed = true;
    printInWindow(win, '<html>doc</html>');
    assert.equal(win.printed, 0);
    printInWindow(null, '<html>doc</html>');
  });
});
