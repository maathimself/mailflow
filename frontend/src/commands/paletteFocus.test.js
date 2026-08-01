import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRestorableFocus, nextFocusIndex } from './paletteFocus.js';

describe('palette focus helpers', () => {
  it('restores only connected, enabled, visible, focusable elements', () => {
    const base = { isConnected: true, disabled: false, tabIndex: 0, getClientRects: () => [{ width: 1 }] };
    assert.equal(isRestorableFocus(base), true);
    assert.equal(isRestorableFocus({ ...base, isConnected: false }), false);
    assert.equal(isRestorableFocus({ ...base, disabled: true }), false);
    assert.equal(isRestorableFocus({ ...base, tabIndex: -1 }), false);
    assert.equal(isRestorableFocus({ ...base, getClientRects: () => [] }), false);
  });

  it('wraps Tab and Shift+Tab indices inside the dialog', () => {
    assert.equal(nextFocusIndex(3, 0, false), 1);
    assert.equal(nextFocusIndex(3, 2, false), 0);
    assert.equal(nextFocusIndex(3, 0, true), 2);
    assert.equal(nextFocusIndex(0, -1, false), -1);
  });
});
