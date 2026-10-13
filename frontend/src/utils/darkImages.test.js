// Images in an email body shown dark (#228): which images are MailFlow's placeholders, which can be
// read, and which need a light backing. Reading pixels needs a real canvas and is checked in
// Chromium by the dark-mode audit harness's self-test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isBlockedPlaceholder, readablePixels, needsBacking } from './darkImages.js';

const img = (attrs) => {
  const doc = new JSDOM(`<!doctype html><img ${attrs}>`, { url: 'https://mail.example.invalid/' }).window.document;
  return doc.querySelector('img');
};
const placeholder = (w, h, fill = '#e8e8e8') =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${fill}"/></svg>`)}`;

describe('isBlockedPlaceholder', () => {
  test("recognizes exactly what blockRemoteImages writes", () => {
    assert.equal(isBlockedPlaceholder(img(`src="${placeholder(600, 200)}"`)), true);
    assert.equal(isBlockedPlaceholder(img(`src="${placeholder(1, 1)}"`)), true);
  });
  test("leaves the email's own images alone, even gray SVG boxes", () => {
    assert.equal(isBlockedPlaceholder(img(`src="${placeholder(600, 200, '#e9e9e9')}"`)), false);
    assert.equal(isBlockedPlaceholder(img('src="data:image/png;base64,iVBORw0KGgo="')), false);
    assert.equal(isBlockedPlaceholder(img('src="https://example.invalid/a.png"')), false);
    assert.equal(isBlockedPlaceholder(img('src="data:image/svg+xml,%E0%A4%A"')), false, 'malformed escapes');
  });
});

describe('readablePixels', () => {
  test('data: and blob: images, and the page\'s own origin', () => {
    globalThis.location = { origin: 'https://mail.example.invalid' };
    try {
      assert.equal(readablePixels(img('src="data:image/png;base64,iVBORw0KGgo="')), true);
      assert.equal(readablePixels(img('src="https://mail.example.invalid/api/x.png"')), true);
      assert.equal(readablePixels(img('src="https://example.invalid/logo.png"')), false, 'a remote image taints the canvas');
      assert.equal(readablePixels(img('src="//example.invalid/logo.png"')), false);
    } finally {
      delete globalThis.location;
    }
  });
});

describe('needsBacking', () => {
  test('a see-through image whose visible part is largely dark', () => {
    assert.equal(needsBacking({ transparent: 0.5, dark: 1 }), true, 'black logo lettering');
    assert.equal(needsBacking({ transparent: 0.1, dark: 0.3 }), true, 'at the thresholds');
    assert.equal(needsBacking({ transparent: 0.5, dark: 0.1 }), false, 'a light logo shows fine');
    assert.equal(needsBacking({ transparent: 0.05, dark: 1 }), false, 'an opaque image keeps its own background');
    assert.equal(needsBacking(null), false, 'unreadable');
  });
});
