// Run with: node --test src/utils/printMessage.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { buildPrintDocument, openPrintWindow, printInWindow } = await import('./printMessage.js');

const A = {
  subject: 'Invoice <42> & receipt', from_name: 'Ana', from_email: 'ana@example.test',
  to_addresses: [{ name: 'Me', email: 'me@example.test' }], cc_addresses: [],
  date: '2026-09-01T10:00:00Z',
};
const B = { ...A, subject: 'Re: Invoice <42> & receipt', from_name: '', from_email: 'me@example.test', cc_addresses: '[{"email":"cc@example.test"}]' };

describe('buildPrintDocument', () => {
  it('blocks scripts in the print window and escapes the subject', () => {
    const html = buildPrintDocument([{ message: A, body: { text: 'hi' } }]);
    assert.match(html, /Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'"/);
    assert.match(html, /<title>Invoice &lt;42&gt; &amp; receipt<\/title>/);
    assert.match(html, /<h1>Invoice &lt;42&gt; &amp; receipt<\/h1>/);
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
  it('shows a placeholder while the conversation loads', () => {
    const win = fakeWindow();
    dom.window.open = () => win;
    globalThis.window.open = dom.window.open;
    assert.equal(openPrintWindow('Preparing <to> print'), win);
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
