import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripOpeningTagStyleAttributes } from './htmlStyleSafety.js';

describe('stripOpeningTagStyleAttributes', () => {
  it('removes style attributes only inside opening tags', () => {
    const html = `<p title="1 > 0" STYLE = 'color:red' data-copy="style=bold">My style="bold" today</p>`;

    assert.equal(
      stripOpeningTagStyleAttributes(html),
      '<p title="1 > 0" data-copy="style=bold">My style="bold" today</p>',
    );
  });

  it('handles quoted, unquoted, and valueless style attributes without touching neighbors', () => {
    assert.equal(
      stripOpeningTagStyleAttributes('<p a="1" style="x > y" b=2><i STYLE=x c=3><b style>x</b>'),
      '<p a="1" b=2><i c=3><b>x</b>',
    );
  });

  it('leaves comments, closing tags, and malformed unterminated tags unchanged in bounded time', () => {
    const malformed = `<p style="color:red" data-copy="${'x'.repeat(500_000)}`;
    const startedAt = performance.now();
    assert.equal(stripOpeningTagStyleAttributes(malformed), malformed);
    assert.ok(performance.now() - startedAt < 100);
    assert.equal(
      stripOpeningTagStyleAttributes('<!-- <p style="x"> --></p style="text">'),
      '<!-- <p style="x"> --></p style="text">',
    );
  });
});
