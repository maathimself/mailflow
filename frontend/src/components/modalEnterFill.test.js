import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// A transform animation that keeps filling after it ends ('both' / 'forwards') leaves the
// element on its own compositor layer for as long as it is open. Under the font-size
// wrapper's transform: scale() a centered modal sits at a fractional pixel offset, so that
// layer is drawn resampled and all its text goes soft (#642). 'backwards' plays the same
// entrance and then lets the element drop back into normal, pixel-snapped painting.
describe('centered modal entrance animation', () => {
  it('never keeps the modal-enter transform after it finishes', () => {
    const dir = new URL('./', import.meta.url);
    const offenders = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsx')) continue;
      const src = readFileSync(new URL(name, dir), 'utf8');
      for (const m of src.matchAll(/animation:\s*['"`]modal-enter\b[^'"`]*['"`]/g)) {
        if (/\b(both|forwards)\b/.test(m[0])) offenders.push(`${name}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
