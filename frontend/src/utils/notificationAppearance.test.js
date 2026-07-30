import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToastAppearance } from './notificationAppearance.js';

describe('resolveToastAppearance', () => {
  it('uses the canonical foreground and background for a GTD classification', () => {
    assert.deepEqual(resolveToastAppearance({ gtdState: 'watch' }), {
      iconColor: '#D9B430',
      iconBackground: 'rgba(217,180,48,0.15)',
      bodyColor: '#D9B430',
    });
  });

  it('keeps the existing error appearance even if malformed state metadata is present', () => {
    assert.deepEqual(resolveToastAppearance({ type: 'error', gtdState: 'watch' }), {
      iconColor: 'var(--red)',
      iconBackground: 'rgba(248,113,113,0.15)',
      bodyColor: 'var(--text-tertiary)',
    });
  });

  it('keeps the existing default appearance for unrelated or unknown notifications', () => {
    const expected = {
      iconColor: 'var(--accent)',
      iconBackground: 'var(--accent-dim)',
      bodyColor: 'var(--text-tertiary)',
    };
    assert.deepEqual(resolveToastAppearance({}), expected);
    assert.deepEqual(resolveToastAppearance({ gtdState: 'unknown' }), expected);
  });
});
