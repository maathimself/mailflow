import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitDraftSignature } from './draftSignature.js';

const SIG = '<div data-mailflow-signature="1" style="margin-top:16px;color:#555;font-size:13px">Matt<br>MailFlow</div>';
const LEGACY = '<div style="margin-top:16px;color:#555;font-size:13px">Matt</div>';

describe('the signature that multiplied on every reopen (#432)', () => {
  test('lifts the signature out so the compose window does not render a second one', () => {
    const { body, signature, inline } = splitDraftSignature(`<p>hello</p>${SIG}`);
    assert.equal(body, '<p>hello</p>');
    assert.equal(signature, 'Matt<br>MailFlow');
    assert.equal(inline, false);
  });

  test('is idempotent across repeated save and reopen cycles', () => {
    // The actual bug: each cycle appended one more copy. Re-splitting a rebuilt draft must
    // return the same body and signature every time, forever.
    let body = '<p>hello</p>', signature = 'Matt';
    for (let i = 0; i < 5; i++) {
      const rebuilt = `${body}<div data-mailflow-signature="1" style="x">${signature}</div>`;
      ({ body, signature } = splitDraftSignature(rebuilt));
      assert.equal(body, '<p>hello</p>', `cycle ${i}: body must not accumulate`);
      assert.equal(signature, 'Matt', `cycle ${i}: signature must not accumulate`);
    }
  });

  test('keeps quoted text in the body, where it already was', () => {
    const { body, signature } = splitDraftSignature(`<p>reply</p>${SIG}<blockquote>original</blockquote>`);
    assert.equal(body, '<p>reply</p><blockquote>original</blockquote>');
    assert.equal(signature, 'Matt<br>MailFlow');
  });

  test('handles a signature containing nested divs', () => {
    const nested = '<div data-mailflow-signature="1"><div>Matt</div><div><b>MailFlow</b></div></div>';
    const { body, signature } = splitDraftSignature(`<p>hi</p>${nested}`);
    assert.equal(body, '<p>hi</p>');
    assert.equal(signature, '<div>Matt</div><div><b>MailFlow</b></div>');
  });
});

describe('when it cannot be certain, it never adds a second signature', () => {
  test('a legacy draft keeps its inline signature and reports it', () => {
    // Drafts saved before the marker existed cannot be lifted safely. Leaving the signature in
    // the body and telling the caller is correct; rendering another one is the bug.
    const { body, signature, inline } = splitDraftSignature(`<p>hi</p>${LEGACY}`);
    assert.equal(body, `<p>hi</p>${LEGACY}`, 'the draft is returned untouched');
    assert.equal(signature, null);
    assert.equal(inline, true, 'caller must suppress its own signature region');
  });

  test('two marked blocks are ambiguous, so nothing is lifted', () => {
    const { signature, inline } = splitDraftSignature(`<p>hi</p>${SIG}${SIG}`);
    assert.equal(signature, null);
    assert.equal(inline, true);
  });

  test('an unbalanced signature div is left alone', () => {
    const { body, signature, inline } = splitDraftSignature('<p>hi</p><div data-mailflow-signature="1">Matt');
    assert.equal(body, '<p>hi</p><div data-mailflow-signature="1">Matt');
    assert.equal(signature, null);
    assert.equal(inline, true);
  });
});

describe('drafts with no signature at all', () => {
  test('a plain draft is unchanged and needs no suppression', () => {
    const { body, signature, inline } = splitDraftSignature('<p>just a body</p>');
    assert.equal(body, '<p>just a body</p>');
    assert.equal(signature, null);
    assert.equal(inline, false, 'the account signature should still be offered');
  });

  test('an empty signature block lifts as empty rather than null', () => {
    const { body, signature } = splitDraftSignature('<p>hi</p><div data-mailflow-signature="1"></div>');
    assert.equal(body, '<p>hi</p>');
    assert.equal(signature, '');
  });

  test('degenerate input does not throw', () => {
    for (const bad of [undefined, null, '', 0, {}]) {
      const r = splitDraftSignature(bad);
      assert.equal(r.signature, null);
      assert.equal(r.inline, false);
    }
  });
});

// A signature turned off in the composer is saved as an empty block (#555). Reopening must read
// it as "no separate signature", also once sanitizing has dropped the marker attribute.
test('an empty signature block reads as no separate signature', () => {
  const marked = splitDraftSignature('<p>Hello</p><div data-mailflow-signature="1" style="margin-top:16px;color:#555;font-size:13px"></div><blockquote>q</blockquote>');
  assert.equal(marked.signature, '');
  assert.equal(marked.inline, false);
  assert.equal(marked.body, '<p>Hello</p><blockquote>q</blockquote>');
  const unmarked = splitDraftSignature('<p>Hello</p><div style="margin-top:16px;color:#555;font-size:13px"></div>');
  assert.equal(unmarked.signature, null);
  assert.equal(unmarked.inline, true);
});
