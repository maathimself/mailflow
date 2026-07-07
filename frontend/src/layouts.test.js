// Run with: node --test src/layouts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, DEFAULT_LAYOUT, normalizeLayout } from './layouts.js';

describe('normalizeLayout', () => {
  it('passes through every currently-valid preset key', () => {
    for (const key of Object.keys(LAYOUTS)) {
      assert.equal(normalizeLayout(key), key);
    }
  });

  it('coerces removed/legacy presets to the default (#207)', () => {
    for (const stale of ['classic', 'wide_reader', 'wide_list']) {
      assert.equal(normalizeLayout(stale), DEFAULT_LAYOUT);
    }
  });

  it('coerces unknown, empty, null, and undefined keys to the default', () => {
    assert.equal(normalizeLayout('nonsense'), DEFAULT_LAYOUT);
    assert.equal(normalizeLayout(''), DEFAULT_LAYOUT);
    assert.equal(normalizeLayout(null), DEFAULT_LAYOUT);
    assert.equal(normalizeLayout(undefined), DEFAULT_LAYOUT);
  });

  it('has a default that is itself a valid preset', () => {
    assert.ok(LAYOUTS[DEFAULT_LAYOUT], 'DEFAULT_LAYOUT must exist in LAYOUTS');
  });
});
