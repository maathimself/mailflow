import { describe, it, expect } from 'vitest';
import { sanitizeRightSidebarPrefs } from './rightSidebarPrefs.js';

describe('sanitizeRightSidebarPrefs — rightSidebarWidth', () => {
  it('accepts an integer or numeric string within range', () => {
    expect(sanitizeRightSidebarPrefs({ rightSidebarWidth: 320 }).rightSidebarWidth).toBe(320);
    expect(sanitizeRightSidebarPrefs({ rightSidebarWidth: '360' }).rightSidebarWidth).toBe(360);
  });

  it('rejects out-of-range and non-numeric widths', () => {
    expect(sanitizeRightSidebarPrefs({ rightSidebarWidth: 10 }).rightSidebarWidth).toBeNull();
    expect(sanitizeRightSidebarPrefs({ rightSidebarWidth: 5000 }).rightSidebarWidth).toBeNull();
    expect(sanitizeRightSidebarPrefs({ rightSidebarWidth: 'wide' }).rightSidebarWidth).toBeNull();
    expect(sanitizeRightSidebarPrefs({}).rightSidebarWidth).toBeNull();
  });
});

describe('sanitizeRightSidebarPrefs — rightSidebarHidden', () => {
  it('passes a boolean through unchanged', () => {
    expect(sanitizeRightSidebarPrefs({ rightSidebarHidden: true }).rightSidebarHidden).toBe(true);
    expect(sanitizeRightSidebarPrefs({ rightSidebarHidden: false }).rightSidebarHidden).toBe(false);
  });

  it('skips absent and non-boolean values', () => {
    expect(sanitizeRightSidebarPrefs({}).rightSidebarHidden).toBeNull();
    expect(sanitizeRightSidebarPrefs({ rightSidebarHidden: 'true' }).rightSidebarHidden).toBeNull();
    expect(sanitizeRightSidebarPrefs({ rightSidebarHidden: 1 }).rightSidebarHidden).toBeNull();
  });
});

describe('sanitizeRightSidebarPrefs — allow-list integrity', () => {
  it('reads only canonical right-sidebar keys', () => {
    const out = sanitizeRightSidebarPrefs({
      rightSidebarWidth: 300,
      rightSidebarHidden: false,
      theme: 'evil',
    });
    expect(out).toEqual({ rightSidebarWidth: 300, rightSidebarHidden: false });
    expect(out).not.toHaveProperty('theme');
  });
});
