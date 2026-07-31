import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildEmailFrameDocument,
  createEmailFrameSourceToken,
  emailFrameDocumentMatchesSource,
} from './emailFrameDocument.js';

describe('buildEmailFrameDocument', () => {
  it('builds a scriptless forced-light document around immutable message HTML', () => {
    const html = '<p id="sentinel">body</p>';
    const documentHtml = buildEmailFrameDocument(html);

    assert.equal(html, '<p id="sentinel">body</p>');
    assert.equal(documentHtml.split(html).length - 1, 1);
    assert.match(documentHtml, /script-src 'none'/);
    assert.match(documentHtml, /object-src 'none'/);
    assert.match(documentHtml, /frame-src 'none'/);
    assert.match(documentHtml, /form-action 'none'/);
    assert.doesNotMatch(documentHtml, /<script\b/i);
    assert.doesNotMatch(documentHtml, /allow-scripts/i);
    assert.match(documentHtml, /<meta name="color-scheme" content="light dark">/);
    assert.match(documentHtml, /<div id="mf-scale-wrapper">/);
    assert.match(documentHtml, /data-mailflow-email-base/);
    assert.match(documentHtml, /background-color:\s*#ffffff/i);
    assert.match(documentHtml, /color:\s*#1a1a1a/i);
    assert.match(documentHtml, /a\s*\{\s*color:\s*#6366f1/i);
    assert.match(documentHtml, /blockquote\s*\{[^}]*border-left:\s*3px solid #ddd[^}]*color:\s*#555/is);
    assert.match(documentHtml, /#mf-scale-wrapper > table/);
    assert.match(documentHtml, /td, th\s*\{\s*min-width:\s*0 !important/i);
    assert.match(documentHtml, /img\s*\{\s*max-width:\s*100% !important/i);
    assert.match(documentHtml, /pre, code\s*\{\s*overflow-x:\s*auto/i);
    assert.match(documentHtml, /animation:\s*none !important/i);
    assert.match(documentHtml, /transition:\s*none !important/i);
  });

  it('uses a forced-light recovery shell without sender-owned style blocks', () => {
    const documentHtml = buildEmailFrameDocument('<style>.sender { color: black }</style><p class="sender" title="1 > 0" style="color:red">My style="bold" today</p>', { recovery: true });

    assert.doesNotMatch(documentHtml, /\.sender/);
    assert.doesNotMatch(documentHtml, /style="color:red"/);
    assert.match(documentHtml, /data-mailflow-email-base/);
    assert.match(documentHtml, /background-color:\s*#ffffff/i);
    assert.match(documentHtml, /<p class="sender" title="1 > 0">My style="bold" today<\/p>/);
  });

  it('embeds an escaped navigation source marker and verifies it exactly', () => {
    const sourceToken = 'source"<&token';
    const documentHtml = buildEmailFrameDocument('<p>body</p>', { sourceToken });
    const matchingDocument = {
      querySelector: selector => selector === 'meta[name="mailflow-source"]'
        ? { content: sourceToken }
        : null,
    };

    assert.match(documentHtml, /<meta name="mailflow-source" content="source&quot;&lt;&amp;token">/);
    assert.equal(emailFrameDocumentMatchesSource(matchingDocument, sourceToken), true);
    assert.equal(emailFrameDocumentMatchesSource(matchingDocument, `${sourceToken}-stale`), false);
    assert.equal(emailFrameDocumentMatchesSource(null, sourceToken), false);
  });

  it('creates distinct synchronous source tokens', () => {
    const first = createEmailFrameSourceToken();
    const second = createEmailFrameSourceToken();

    assert.match(first, /^[a-zA-Z0-9-]+$/);
    assert.notEqual(first, second);
  });
});
