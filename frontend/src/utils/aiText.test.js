// Run with: node --test src/utils/aiText.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aiTextToHtml } from './aiText.js';

describe('aiTextToHtml', () => {
  test('keeps the blank line between paragraphs, and a line break within one', () => {
    assert.equal(aiTextToHtml('Hi Ana,\n\nApproved.\nThanks'), '<p>Hi Ana,</p><p></p><p>Approved.<br>Thanks</p>');
  });

  test('reads a blank line with spaces in it, or Windows line endings, as one blank line', () => {
    assert.equal(aiTextToHtml('One.\n  \nTwo.\r\n\r\nThree.\n\n\n\nFour.'), '<p>One.</p><p></p><p>Two.</p><p></p><p>Three.</p><p></p><p>Four.</p>');
  });

  test('keeps markup the AI wrote as text', () => {
    assert.equal(
      aiTextToHtml('See <a href="https://evil.example">here</a> & <img src=x onerror=alert(1)>'),
      '<p>See &lt;a href=&quot;https://evil.example&quot;&gt;here&lt;/a&gt; &amp; &lt;img src=x onerror=alert(1)&gt;</p>',
    );
  });

  test('stays linear on a long run of spaces', () => {
    const started = performance.now();
    aiTextToHtml(`${' '.repeat(200_000)}x`);
    assert.ok(performance.now() - started < 1000);
  });

  test('is a single empty paragraph for no text', () => {
    assert.equal(aiTextToHtml(''), '<p></p>');
    assert.equal(aiTextToHtml(null), '<p></p>');
  });
});
