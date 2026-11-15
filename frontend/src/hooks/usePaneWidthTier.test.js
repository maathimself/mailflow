import test from 'node:test';
import assert from 'node:assert/strict';
import { paneWidthTier, PANE_NARROW_BELOW, PANE_MEDIUM_BELOW } from './usePaneWidthTier.js';

test('the tier follows the measured pane width', () => {
  assert.equal(paneWidthTier(PANE_NARROW_BELOW - 1), 'narrow');
  assert.equal(paneWidthTier(PANE_NARROW_BELOW), 'medium');
  assert.equal(paneWidthTier(PANE_MEDIUM_BELOW - 1), 'medium');
  assert.equal(paneWidthTier(PANE_MEDIUM_BELOW), 'wide');
});

test('the widths the GTD sidebar left the list are narrow, whatever the viewport', () => {
  // 768px and 900px windows with both sidebars open, and 1440px at 150% font scale.
  for (const width of [232, 364, 383]) assert.equal(paneWidthTier(width), 'narrow');
  // 1440px at 100% with both sidebars open.
  assert.equal(paneWidthTier(868), 'wide');
});

test('a hidden or unmeasured pane has no tier', () => {
  assert.equal(paneWidthTier(0), null);
  assert.equal(paneWidthTier(undefined), null);
});
