// The image proxy's URLs turned back into the email's own references (backend services/imageProxy.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unproxyImages } from './imageProxy.js';

const ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
// As the backend's imageProxyPath writes it.
const proxy = (raw) => `/api/mail/messages/${ID}/image?u=${encodeURIComponent(raw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

test('restores every reference exactly, wherever it sits', () => {
  const original = '<img src="https://img.example/a.png?x=1&amp;y=2"><div style="background:url(&quot;//img.example/b.png&quot;)">x</div>'
    + "<style>.s{background:url('https://img.example/a(1)\\'.png')}</style>";
  const proxied = original
    .replace('https://img.example/a.png?x=1&amp;y=2', proxy('https://img.example/a.png?x=1&amp;y=2'))
    .replace('//img.example/b.png', proxy('//img.example/b.png'))
    .replace("https://img.example/a(1)\\'.png", proxy("https://img.example/a(1)\\'.png"));
  assert.doesNotMatch(proxied, /\/\/img\.example/, 'no loadable original URL is left');
  assert.equal(unproxyImages(proxied), original);
});

test('leaves everything else alone', () => {
  const html = '<a href="/api/mail/messages/x/image?u=1">x</a><img src="data:image/png;base64,AAAA">';
  assert.equal(unproxyImages(html), html);
  assert.equal(unproxyImages(null), null);
  assert.equal(unproxyImages(`<img src="/api/mail/messages/${ID}/image?u=%E0%A4%A">`), `<img src="/api/mail/messages/${ID}/image?u=%E0%A4%A">`, 'a broken escape stays as it is');
});
