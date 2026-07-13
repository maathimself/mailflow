import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampRightSidebarWidth } from './rightSidebar.js';

describe('clampRightSidebarWidth', () => {
  it('clamps to the supported pixel range and rounds', () => {
    assert.equal(clampRightSidebarWidth(296), 296);
    assert.equal(clampRightSidebarWidth(120), 200);
    assert.equal(clampRightSidebarWidth(999), 600);
    assert.equal(clampRightSidebarWidth(305.7), 306);
  });

  it('falls back to the default width for non-numeric input', () => {
    assert.equal(clampRightSidebarWidth('abc'), 296);
    assert.equal(clampRightSidebarWidth(null), 296);
    assert.equal(clampRightSidebarWidth(undefined), 296);
  });
});
