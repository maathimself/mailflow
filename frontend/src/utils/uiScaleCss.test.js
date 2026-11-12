import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descaleCss } from './uiScaleCss.js';

test('descaleCss divides a viewport length by the wrapper scale, 1 outside the wrapper (#777)', () => {
  assert.equal(descaleCss('85vh'), 'calc((85vh) / var(--ui-scale, 1))');
  // Parenthesized, so a subtraction is divided as a whole.
  assert.equal(descaleCss('100vh - 8px'), 'calc((100vh - 8px) / var(--ui-scale, 1))');
});
