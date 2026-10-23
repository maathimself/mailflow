// Inline images and the cached message body (#595).
import { describe, it, expect } from 'vitest';
import { CIDS_SETTLED, hasCidReference, needsCidRefetch, needsImageRefetch, settleCids, settledEarlier, withoutCidMarker } from './cidRefs.js';
import { rasterImageTypeOfName, standardImageType } from './inlineImages.js';

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
  it('marks every complete fetch, with references left or not (#640), and only a complete one', () => {
    expect(settleCids(body, true)).toBe(`${body}${CIDS_SETTLED}`);
    expect(settleCids(body, false)).toBe(body);
    expect(settleCids('<p>no references</p>', true)).toBe(`<p>no references</p>${CIDS_SETTLED}`);
    expect(settleCids(`${body}${CIDS_SETTLED}`, true)).toBe(`${body}${CIDS_SETTLED}`);
    expect(settleCids(`${body}<!--mf-cids-settled:2-->`, true)).toBe(`${body}${CIDS_SETTLED}`);
    expect(settleCids(null, true)).toBe(null);
    expect(settleCids('', true)).toBe('');
  });
  it('a marked body is not fetched again; an unmarked one, from before, is', () => {
    expect(needsCidRefetch(body)).toBe(true);
    expect(needsCidRefetch(settleCids(body, true))).toBe(false);
    expect(needsCidRefetch('<p>Your CID: 4521</p>')).toBe(false);
  });
  it('a body settled before images marked as attachments could show (#640) is fetched once more', () => {
    for (const legacy of [`${body}<!--mf-cids-settled-->`, `${body}<!--mf-cids-settled:2-->`]) {
      expect(needsCidRefetch(legacy)).toBe(true);
      expect(settledEarlier(legacy)).toBe(true);
      expect(withoutCidMarker(legacy)).toBe(body);
    }
    expect(settledEarlier(settleCids(body, true))).toBe(false);
    expect(settledEarlier(body)).toBe(false);
    expect(settledEarlier(null)).toBe(false);
  });
  it('never leaves MailFlow', () => {
    expect(withoutCidMarker(settleCids(body, true))).toBe(body);
    expect(withoutCidMarker(null)).toBe(null);
  });
});

describe('needsImageRefetch (#640)', () => {
  const html = '<p>Newsletter</p><img src="hdr.jpg">';
  const photo = { part: '2', filename: 'hdr.jpg', type: 'image/jpeg' };
  it('fetches an unmarked body again once its message has an image attachment', () => {
    expect(needsImageRefetch(html, [photo])).toBe(true);
    expect(needsImageRefetch(html, [{ filename: 'invoice.pdf', type: 'application/pdf' }, { filename: 'x', type: 'IMAGE/PNG' }])).toBe(true);
    // Sent as application/octet-stream or with no type, named like a raster image.
    expect(needsImageRefetch(html, [{ filename: 'Header.JPEG', type: 'application/octet-stream' }])).toBe(true);
    expect(needsImageRefetch(html, [{ filename: 'badge.webp' }])).toBe(true);
  });
  it('serves a body as stored when nothing in it can change', () => {
    expect(needsImageRefetch(settleCids(html, true), [photo])).toBe(false);
    expect(needsImageRefetch(html, [])).toBe(false);
    expect(needsImageRefetch(html, null)).toBe(false);
    expect(needsImageRefetch(html, [{ filename: 'invoice.pdf', type: 'application/pdf' }, { filename: 'notes.bin', type: 'application/octet-stream' }, { filename: 'fwd.eml', type: 'message/rfc822', contains: [{ filename: 'a.png', type: 'image/png' }] }])).toBe(false);
    expect(needsImageRefetch(html, [null, 'x'])).toBe(false);
    // A text-only body cannot hold the marker, so it would be fetched on every view.
    expect(needsImageRefetch(null, [photo])).toBe(false);
  });
});

describe('image types (#640)', () => {
  it('names the standard type for aliases mailers write', () => {
    expect(standardImageType('image/jpg')).toBe('image/jpeg');
    expect(standardImageType('IMAGE/PJPEG')).toBe('image/jpeg');
    expect(standardImageType('image/x-png')).toBe('image/png');
    expect(standardImageType('image/x-ms-bmp')).toBe('image/bmp');
    expect(standardImageType('image/png')).toBe('image/png');
    expect(standardImageType('image/svg+xml')).toBe('image/svg+xml');
  });
  it('types a raster image by its file name only', () => {
    expect(rasterImageTypeOfName('hdr.JPG')).toBe('image/jpeg');
    expect(rasterImageTypeOfName(' a.b.png ')).toBe('image/png');
    expect(rasterImageTypeOfName('x.avif')).toBe('image/avif');
    for (const name of ['logo.svg', 'report.pdf', 'jpg', 'image.', '', null, 'a.png.exe']) {
      expect(rasterImageTypeOfName(name)).toBe('');
    }
  });
});
