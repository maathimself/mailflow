// Inline images and the cached message body (#595).
import { describe, it, expect } from 'vitest';
import { CIDS_SETTLED, hasCidReference, needsCidRefetch, settleCids, withoutCidMarker } from './cidRefs.js';

describe('hasCidReference', () => {
  it('finds a cid: reference where a URL goes', () => {
    expect(hasCidReference('<img src="cid:logo@x">')).toBe(true);
    expect(hasCidReference("<img src='cid:logo@x'>")).toBe(true);
    expect(hasCidReference('<div style="background:url(cid:bg@x)">')).toBe(true);
    expect(hasCidReference('<img src=" cid:logo@x">')).toBe(true);
  });
  it('ignores the text "CID:" in an email, which sent every view to the mail server', () => {
    expect(hasCidReference('<p>Your CID: 4521</p>')).toBe(false);
    expect(hasCidReference('<p>Lucid: a story</p>')).toBe(false);
    expect(hasCidReference(null)).toBe(false);
  });
  it('stays fast on hostile input', () => {
    const started = performance.now();
    hasCidReference(`${'"'.repeat(200000)}${' '.repeat(200000)}x`);
    hasCidReference(`${'" '.repeat(200000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('the settled marker', () => {
  const body = '<p>hi</p><img src="cid:missing@x">';
  it('marks a complete fetch that leaves references, and only that', () => {
    expect(settleCids(body, true)).toBe(`${body}${CIDS_SETTLED}`);
    expect(settleCids(body, false)).toBe(body);
    expect(settleCids('<p>no references</p>', true)).toBe('<p>no references</p>');
    expect(settleCids(`${body}${CIDS_SETTLED}`, true)).toBe(`${body}${CIDS_SETTLED}`);
    expect(settleCids(null, true)).toBe(null);
  });
  it('a marked body is not fetched again; an unmarked one, from before, is', () => {
    expect(needsCidRefetch(body)).toBe(true);
    expect(needsCidRefetch(settleCids(body, true))).toBe(false);
    expect(needsCidRefetch('<p>Your CID: 4521</p>')).toBe(false);
  });
  it('a body settled before images marked as attachments could show (#640) is fetched once more', () => {
    const legacy = `${body}<!--mf-cids-settled-->`;
    expect(needsCidRefetch(legacy)).toBe(true);
    expect(withoutCidMarker(legacy)).toBe(body);
  });
  it('never leaves MailFlow', () => {
    expect(withoutCidMarker(settleCids(body, true))).toBe(body);
    expect(withoutCidMarker(null)).toBe(null);
  });
});
