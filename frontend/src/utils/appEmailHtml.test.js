// Email HTML placed in MailFlow's own page (the composer's quote, the div renderer) keeps images
// only from MailFlow itself. The CSS escape cases depend on the browser's CSS parser and are checked
// in Chromium, Firefox and WebKit; jsdom covers the URL handling and what must be kept.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// DOMPurify binds to the window it finds when it is first imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mail.example.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { sanitizeEmailForApp } = await import('./appEmailHtml.js');
const DOMPurify = (await import('dompurify')).default;

const parse = html => new dom.window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

describe('sanitizeEmailForApp', () => {
  it("drops a sender's image, written plainly or with a line break in its scheme", () => {
    const out = parse(sanitizeEmailForApp('<img id="a" src="https://evil.example/a.gif"><img id="b" src="ht\ntps://evil.example/b.gif"><td id="c" background="https://evil.example/c.gif">x</td>'));
    assert.equal(out.querySelector('#a').hasAttribute('src'), false);
    assert.equal(out.querySelector('#b').hasAttribute('src'), false);
  });

  it('drops a srcset with any remote candidate, and an SVG image from the sender', () => {
    const out = parse(sanitizeEmailForApp('<img id="s" srcset="/api/mail/messages/1/image?u=a 1x, https://evil.example/s.png 2x"><svg><image id="v" href="https://evil.example/v.png"></image></svg>'));
    assert.equal(out.querySelector('#s').hasAttribute('srcset'), false);
    assert.equal(out.querySelector('#v')?.hasAttribute('href') ?? false, false);
  });

  it("keeps MailFlow's own images, data: and cid: images, and ordinary styling", () => {
    const out = parse(sanitizeEmailForApp('<img id="p" src="/api/mail/messages/1/image?u=abc"><img id="d" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><img id="c" src="cid:logo@x"><p id="t" style="color: red; font-weight: bold">Hi</p>'));
    assert.equal(out.querySelector('#p').getAttribute('src'), '/api/mail/messages/1/image?u=abc');
    assert.ok(out.querySelector('#d').getAttribute('src').startsWith('data:'));
    assert.equal(out.querySelector('#c').getAttribute('src'), 'cid:logo@x');
    assert.equal(out.querySelector('#t').style.color, 'red');
    assert.equal(out.querySelector('#t').style.fontWeight, 'bold');
  });

  it("drops a style declaration that loads from the sender and keeps the rest", () => {
    const out = parse(sanitizeEmailForApp('<div id="x" style="color: red; background-image: url(https://evil.example/bg.gif)">x</div>'));
    assert.equal(out.querySelector('#x').style.backgroundImage, '');
    assert.equal(out.querySelector('#x').style.color, 'red');
  });

  it('leaves other sanitizes alone', () => {
    sanitizeEmailForApp('<p>x</p>');
    assert.match(DOMPurify.sanitize('<img src="https://example.com/a.png">'), /https:\/\/example\.com\/a\.png/);
  });
});
