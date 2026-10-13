// A dragged or resized window's geometry in its own CSS pixels (#591). Layout itself needs a
// browser; this checks the conversion against an element laid out as MailApp's font-size scale
// leaves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutScale, frameGeometry } from './frameGeometry.js';

// A position: fixed window at left 200, top 120, 600 x 420 in its own pixels, shown at `scale`.
const windowAt = (scale) => ({
  offsetWidth: 600,
  offsetHeight: 420,
  getBoundingClientRect: () => ({ left: 200 * scale, top: 120 * scale, width: 600 * scale, height: 420 * scale }),
  ownerDocument: {
    defaultView: {
      innerWidth: 1400,
      innerHeight: 900,
      getComputedStyle: () => ({ left: '200px', top: '120px' }),
    },
  },
});

test('reads the window in its own pixels whatever the scale, so a grab writes back what it read', () => {
  for (const scale of [1, 1.25, 0.9]) {
    const g = frameGeometry(windowAt(scale));
    assert.deepEqual({ x: g.x, y: g.y, w: g.w, h: g.h }, { x: 200, y: 120, w: 600, h: 420 }, `scale ${scale}`);
    assert.equal(g.scale, scale);
    assert.equal(g.viewW, 1400 / scale, 'the screen in the same pixels');
    assert.equal(g.viewH, 900 / scale);
  }
});

test('falls back to 1 for an element not laid out', () => {
  assert.equal(layoutScale({ offsetWidth: 0, getBoundingClientRect: () => ({ width: 0 }) }), 1);
});
