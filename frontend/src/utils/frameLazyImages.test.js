// Images further down an email held back until the reader nears them. Where they are against the
// viewport needs layout, and is checked in Chromium, Firefox and WebKit; this is the rewriting.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { deferProxiedImages, isDeferredImage, loadImagesNearView, EAGER_IMAGES } from './frameLazyImages.js';

const ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const proxied = (i, extra = '') => `<img src="/api/mail/messages/${ID}/image?u=a${i}&amp;w=180"${extra}>`;

describe('deferProxiedImages', () => {
  test('holds back the proxied images after the first few, srcset too', () => {
    const html = Array.from({ length: EAGER_IMAGES + 2 }, (_, i) => proxied(i, i === EAGER_IMAGES + 1 ? ` srcset="/api/mail/messages/${ID}/image?u=b 2x"` : '')).join('');
    const out = deferProxiedImages(html);
    assert.equal((out.match(/\ssrc=/g) || []).length, EAGER_IMAGES);
    assert.equal((out.match(/data-mf-src=/g) || []).length, 2);
    assert.match(out, /data-mf-srcset=/);
  });

  test('leaves inline, blocked-placeholder and other images alone, and does not count them', () => {
    const other = '<img src="data:image/png;base64,AA"><img src="cid:x"><img data-src="/api/mail/messages/x">';
    const html = other + Array.from({ length: EAGER_IMAGES }, (_, i) => proxied(i)).join('');
    assert.equal(deferProxiedImages(html), html);
  });
});

describe('loadImagesNearView', () => {
  test('without a frame to measure against, loads everything at once', () => {
    const doc = new JSDOM(`<body>${deferProxiedImages(Array.from({ length: EAGER_IMAGES + 2 }, (_, i) => proxied(i)).join(''))}</body>`).window.document;
    const held = [...doc.images].filter(isDeferredImage);
    assert.equal(held.length, 2);
    loadImagesNearView(doc);
    assert.equal([...doc.images].filter(isDeferredImage).length, 0);
    assert.ok(held.every(img => img.getAttribute('src')?.includes('/image?u=')));
  });
});
