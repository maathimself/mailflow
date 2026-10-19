import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTags } from './stripTags.js';

test('tags become spaces and text is kept', () => {
  assert.equal(stripTags('<p>Hello <b>there</b></p>'), ' Hello  there  ');
  // A bare `<` with no `>` after it is text; as before, `< b and c >` reads as a tag.
  assert.equal(stripTags('if a < b'), 'if a < b');
  assert.equal(stripTags('a < b and c > d'), 'a   d');
  assert.equal(stripTags(null), '');
});

// Timed against plain markup of the same size on the same machine, not a fixed limit.
test('stays linear on a body full of unclosed tags', () => {
  const time = (s) => { const t = performance.now(); stripTags(s); return performance.now() - t; };
  const plain = time('<p>x</p>'.repeat(40_000));
  for (const hostile of ['<'.repeat(320_000), '<div '.repeat(64_000), `<${'a'.repeat(320_000)}`]) {
    assert.ok(time(hostile) < plain * 10 + 50, 'linear');
  }
});
