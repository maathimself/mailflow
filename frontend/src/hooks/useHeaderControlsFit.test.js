import test from 'node:test';
import assert from 'node:assert/strict';
import { oneLineWidth, controlsFit, sortIconOnly, breakEvenly, MIN_TITLE_WIDTH } from './useHeaderControlsFit.js';

test('oneLineWidth adds the controls and the gaps between them', () => {
  assert.equal(oneLineWidth([40, 26, 26], 4), 100);
  assert.equal(oneLineWidth([50], 4), 50);
  assert.equal(oneLineWidth([], 4), 0);
});

test('oneLineWidth skips controls that are not rendered', () => {
  assert.equal(oneLineWidth([40, 0, 26], 4), 70);
});

test('an icon-only title needs only its own width beside the controls', () => {
  // All Inboxes: a 17px icon, 6px column gap, 300px of controls.
  assert.equal(controlsFit({ available: 323, controlsWidth: 300, titleWidth: 17, columnGap: 6 }), true);
  assert.equal(controlsFit({ available: 322, controlsWidth: 300, titleWidth: 17, columnGap: 6 }), false);
});

test('a long title keeps at least MIN_TITLE_WIDTH before the controls move down', () => {
  const need = MIN_TITLE_WIDTH + 6 + 300;
  assert.equal(controlsFit({ available: need, controlsWidth: 300, titleWidth: 400, columnGap: 6 }), true);
  assert.equal(controlsFit({ available: need - 1, controlsWidth: 300, titleWidth: 400, columnGap: 6 }), false);
});

test('unmeasured sizes count as fitting', () => {
  assert.equal(controlsFit({ available: 0, controlsWidth: 300, titleWidth: 17, columnGap: 6 }), true);
  assert.equal(controlsFit({ available: 200, controlsWidth: 0, titleWidth: 17, columnGap: 6 }), true);
});

test('Sort drops its label only when that makes the row fit', () => {
  // English Focused: 177px for Sort (62 with its label, 36 without), Unread, page size and layout.
  assert.equal(sortIconOnly({ available: 177, labeled: 196, iconOnly: 170 }), true);
  // Fits with the label: keep it.
  assert.equal(sortIconOnly({ available: 200, labeled: 196, iconOnly: 170 }), false);
  // Does not fit even without it: keep the label and let the row wrap evenly.
  assert.equal(sortIconOnly({ available: 165, labeled: 196, iconOnly: 170 }), false);
});

test('an unmeasured row keeps the label', () => {
  assert.equal(sortIconOnly({ available: 0, labeled: 196, iconOnly: 170 }), false);
});

test('the second row breaks evenly only when even an icon-only Sort does not fit', () => {
  // English Focused in Chromium: 177px, 208 with the label, 180 without.
  assert.equal(breakEvenly({ available: 177, iconOnly: 180, count: 4 }), true);
  assert.equal(breakEvenly({ available: 180, iconOnly: 180, count: 4 }), false);
  // No Sort in this folder: three controls, nothing to balance.
  assert.equal(breakEvenly({ available: 120, iconOnly: 150, count: 3 }), false);
  assert.equal(breakEvenly({ available: 0, iconOnly: 180, count: 4 }), false);
});
