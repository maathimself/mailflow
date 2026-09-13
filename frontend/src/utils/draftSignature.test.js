import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { splitDraftSignature, splitDraftSignatureText, draftComposeFields } from './draftSignature.js';

const { document } = new JSDOM('').window;
const split = (html) => splitDraftSignature(html, { document });

// Mirrors backend/src/utils/signatureWrapper.js; the backend test pins the same string.
const wrap = (sig) => `<div class="mailexpert-signature" style="margin-top:16px;color:#555;font-size:13px">${sig}</div>`;
const legacyWrap = (sig) => `<div style="margin-top:16px;color:#555;font-size:13px">${sig}</div>`;
const QUOTE_HTML = '<div style="border-left:3px solid var(--border,#ccc);padding-left:12px"><p>On x, a wrote:</p><p>older</p></div>';
const QUOTE_TEXT = '\n\n---\nOn x, a <a@b.c> wrote:\n> older';

// Mirrors how backend/src/routes/draft.js buildRawDraft assembles the stored HTML and text.
const buildDraftHtml = (body, sig, quote = '') => body + (sig ? wrap(sig) : '') + quote;
const buildDraftText = (body, sig, quote = '') => (sig ? `${body}\n\n-- \n${sig}${quote}` : `${body}${quote}`);

const countWrappers = (html) => (html.match(/mailexpert-signature/g) || []).length;

describe('splitDraftSignature', () => {
  it('removes a marked wrapper followed by a quote and keeps the quote in the body', () => {
    const out = split(`<p>hi</p>${wrap('<b>Sig</b>')}${QUOTE_HTML}`);
    assert.equal(out.bodyHtml, `<p>hi</p>${QUOTE_HTML}`);
    assert.equal(out.signatureHtml, '<b>Sig</b>');
  });

  it('keeps nested markup inside the signature intact', () => {
    const sig = '<div><div>Name</div><div><a href="https://x.test">x</a></div></div>';
    const out = split(`<p>hi</p>${wrap(sig)}`);
    assert.equal(out.bodyHtml, '<p>hi</p>');
    assert.equal(out.signatureHtml, sig);
  });

  it('removes a legacy unmarked wrapper with the exact style', () => {
    const out = split(`<p>hi</p>${legacyWrap('Sig')}`);
    assert.equal(out.bodyHtml, '<p>hi</p>');
    assert.equal(out.signatureHtml, 'Sig');
  });

  it('does not treat a div with a different style as a legacy wrapper', () => {
    const html = '<p>hi</p><div style="margin-top:16px;color:#555">Sig</div>';
    assert.deepEqual(split(html), { bodyHtml: html, signatureHtml: null });
  });

  it('leaves drafts without a wrapper unchanged (e.g. a Gmail web draft)', () => {
    const html = '<div dir="ltr">hello<br><div>--<br>Gmail sig</div></div>';
    assert.deepEqual(split(html), { bodyHtml: html, signatureHtml: null });
  });

  it('ignores a wrapper nested inside a quoted message', () => {
    const html = `<p>hi</p><div class="quote">${wrap('Their sig')}</div>`;
    assert.deepEqual(split(html), { bodyHtml: html, signatureHtml: null });
  });

  it('removes only the last wrapper of an already duplicated draft', () => {
    const out = split(`<p>hi</p>${wrap('Sig')}${wrap('Sig')}`);
    assert.equal(out.bodyHtml, `<p>hi</p>${wrap('Sig')}`);
    assert.equal(out.signatureHtml, 'Sig');
  });

  it('prefers the marked wrapper over a legacy one', () => {
    const out = split(`<p>hi</p>${legacyWrap('Old')}${wrap('New')}`);
    assert.equal(out.bodyHtml, `<p>hi</p>${legacyWrap('Old')}`);
    assert.equal(out.signatureHtml, 'New');
  });

  it('keeps a leading <style> block in place', () => {
    const out = split(`<style>p{margin:0}</style><p>hi</p>${wrap('Sig')}`);
    assert.equal(out.bodyHtml, '<style>p{margin:0}</style><p>hi</p>');
  });

  it('returns empty input unchanged', () => {
    assert.deepEqual(split(''), { bodyHtml: '', signatureHtml: null });
  });

  it('is idempotent across save -> reopen -> save cycles', () => {
    let stored = buildDraftHtml('<p>hi</p>', '<b>Sig</b>', QUOTE_HTML);
    for (let i = 0; i < 3; i++) {
      const { bodyHtml, signatureHtml } = split(stored);
      // The reopened composer sends the body back and the draft's own signature as editedSignature.
      stored = buildDraftHtml(bodyHtml, signatureHtml);
      assert.equal(countWrappers(stored), 1, `cycle ${i}`);
    }
    assert.equal(split(stored).signatureHtml, '<b>Sig</b>');
  });

  it('turns a legacy draft into a single marked signature after one cycle', () => {
    const first = split(`<p>hi</p>${legacyWrap('Sig')}`);
    const stored = buildDraftHtml(first.bodyHtml, first.signatureHtml);
    assert.equal(stored, `<p>hi</p>${wrap('Sig')}`);
  });
});

describe('splitDraftSignatureText', () => {
  it('splits a trailing signature block', () => {
    assert.deepEqual(splitDraftSignatureText('hi\n\n-- \nSig'), { body: 'hi', signature: 'Sig', quote: '' });
  });

  it('separates a reply quote that follows the signature', () => {
    assert.deepEqual(
      splitDraftSignatureText(`hi\n\n-- \nLine 1\n\nLine 2${QUOTE_TEXT}`),
      { body: 'hi', signature: 'Line 1\n\nLine 2', quote: QUOTE_TEXT },
    );
  });

  it('separates a forwarded message that follows the signature', () => {
    const fwd = '\n\n---------- Forwarded message ----------\nFrom: a\n\nbody\n\n-- \nTheir sig';
    assert.deepEqual(splitDraftSignatureText(`hi\n\n-- \nSig${fwd}`), { body: 'hi', signature: 'Sig', quote: fwd });
  });

  it('ignores a delimiter that only appears inside the quote', () => {
    const fwd = '\n\n---------- Forwarded message ----------\nFrom: a\n\nbody\n\n-- \nTheir sig';
    assert.deepEqual(splitDraftSignatureText(`hi${fwd}`), { body: 'hi', signature: null, quote: fwd });
  });

  it('leaves text without a delimiter or quote unchanged', () => {
    assert.deepEqual(splitDraftSignatureText('hi\n--\nnot a sig'), { body: 'hi\n--\nnot a sig', signature: null, quote: '' });
    assert.deepEqual(splitDraftSignatureText(''), { body: '', signature: null, quote: '' });
  });

  it('is idempotent across save -> reopen -> save cycles', () => {
    let stored = buildDraftText('hi', 'Sig', QUOTE_TEXT);
    for (let i = 0; i < 3; i++) {
      const { body, signature, quote } = splitDraftSignatureText(stored);
      // The reopened composer sends body, the draft's signature and the quote back separately.
      stored = buildDraftText(body, signature, quote);
      assert.equal(stored, buildDraftText('hi', 'Sig', QUOTE_TEXT), `cycle ${i}`);
      assert.equal((stored.match(/\n-- \n/g) || []).length, 1, `cycle ${i}`);
    }
  });
});

describe('draftComposeFields', () => {
  it('opens an HTML draft without its signature and seeds draftSignature', () => {
    const fields = draftComposeFields({ html: `<p>hi</p>${wrap('Sig')}`, text: 'hi\n\n-- \nSig' }, { document });
    assert.deepEqual(fields, { body: '<p>hi</p>', bodyIsHtml: true, draftSignature: 'Sig' });
  });

  it('omits draftSignature when the draft has no recognisable signature', () => {
    const fields = draftComposeFields({ html: '<p>hi</p>', text: 'hi' }, { document });
    assert.deepEqual(fields, { body: '<p>hi</p>', bodyIsHtml: true });
    assert.equal('draftSignature' in fields, false);
  });

  it('uses the text part in plain-text mode and escapes the signature for the editor', () => {
    const fields = draftComposeFields(
      { html: `<p>hi</p>${wrap('a &lt; b')}`, text: 'hi\n\n-- \na < b\nline 2' },
      { document, plaintext: true },
    );
    assert.deepEqual(fields, { body: 'hi', bodyIsHtml: false, draftSignature: 'a &lt; b<br>\nline 2' });
  });

  it('passes a plain-text quote separately so the signature stays above it on the next save', () => {
    const fields = draftComposeFields({ html: '<p>x</p>', text: `hi\n\n-- \nSig${QUOTE_TEXT}` }, { document, plaintext: true });
    assert.deepEqual(fields, { body: 'hi', bodyIsHtml: false, quotedBody: QUOTE_TEXT, draftSignature: 'Sig' });
  });

  it('falls back to the text part when there is no HTML part', () => {
    const fields = draftComposeFields({ html: null, text: 'hi\n\n-- \nSig' }, { document });
    assert.deepEqual(fields, { body: 'hi', bodyIsHtml: false, draftSignature: 'Sig' });
  });

  it('returns an empty body for an empty draft', () => {
    assert.deepEqual(draftComposeFields({}, { document }), { body: '', bodyIsHtml: false });
  });
});
