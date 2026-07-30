import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarTransition } from './sidebarTransition.js';

describe('sidebarTransition', () => {
  it('uses the shared GTD timing and easing for one animated property', () => {
    assert.equal(sidebarTransition('width'), 'width 0.2s ease');
  });

  it('applies the shared animation to every supplied property', () => {
    assert.equal(
      sidebarTransition('width', 'min-width'),
      'width 0.2s ease, min-width 0.2s ease',
    );
  });
});
