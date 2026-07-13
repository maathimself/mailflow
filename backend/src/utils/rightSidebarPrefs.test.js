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

describe('sanitizeRightSidebarPrefs — rightSidebarCollapsed', () => {
  it('coerces each section value to a boolean', () => {
    expect(sanitizeRightSidebarPrefs({ rightSidebarCollapsed: { Receipts: true, Newsletters: 0 } }).rightSidebarCollapsed)
      .toEqual({ Receipts: true, Newsletters: false });
  });

  it('skips absent values and non-object shapes', () => {
    expect(sanitizeRightSidebarPrefs({}).rightSidebarCollapsed).toBeNull();
    expect(sanitizeRightSidebarPrefs({ rightSidebarCollapsed: ['Receipts'] }).rightSidebarCollapsed).toBeNull();
    expect(sanitizeRightSidebarPrefs({ rightSidebarCollapsed: 'Receipts' }).rightSidebarCollapsed).toBeNull();
  });

  it('drops over-long keys and caps the map', () => {
    const longKey = 'x'.repeat(256);
    expect(sanitizeRightSidebarPrefs({ rightSidebarCollapsed: { [longKey]: true } }).rightSidebarCollapsed).toEqual({});

    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, true]));
    expect(Object.keys(sanitizeRightSidebarPrefs({ rightSidebarCollapsed: many }).rightSidebarCollapsed)).toHaveLength(40);
  });
});

describe('sanitizeRightSidebarPrefs — allow-list integrity', () => {
  it('reads only canonical right-sidebar keys', () => {
    const out = sanitizeRightSidebarPrefs({
      rightSidebarWidth: 300,
      rightSidebarHidden: false,
      theme: 'evil',
    });
    expect(out).toEqual({ rightSidebarWidth: 300, rightSidebarHidden: false, rightSidebarCollapsed: null });
    expect(out).not.toHaveProperty('theme');
  });
});
