// Run with: node --test src/layouts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, DEFAULT_LAYOUT, normalizeLayout, applyLayout } from './layouts.js';

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

// #596: List first is a full-width list with no reading pane beside it.
describe('List first', () => {
  it('is a preset of its own, joined by the opt-in Gmail skin', () => {
    assert.equal(normalizeLayout('list'), 'list');
    assert.deepEqual(Object.keys(LAYOUTS).filter(k => LAYOUTS[k].listFirst), ['list', 'gmail']);
    assert.equal(LAYOUTS.list.listWidth, null, 'no fixed list width: the list takes the content area');
  });
});


describe('Gmail presentation scope', () => {
  it('is opt-in, full width, and removes its CSS scope when switching away', () => {
    assert.equal(DEFAULT_LAYOUT, 'comfortable');
    assert.equal(normalizeLayout('gmail'), 'gmail');
    assert.equal(LAYOUTS.gmail.listWidth, null);
    const previous = globalThis.document;
    const properties = {};
    const root = { dataset: {}, style: { setProperty: (key, value) => { properties[key] = value; } } };
    globalThis.document = { documentElement: root };
    try {
      for (const next of ['comfortable', 'compact', 'list', 'removed-layout']) {
        applyLayout('gmail');
        assert.equal(root.dataset.mailflowLayout, 'gmail');
        applyLayout(next, 412);
        assert.equal(root.dataset.mailflowLayout, undefined);
        assert.equal(properties['--layout-row-py'], `${LAYOUTS[normalizeLayout(next)].rowPy}px`);
      }
      assert.equal(properties['--list-width'], '412px');
    } finally { globalThis.document = previous; }
  });
});
