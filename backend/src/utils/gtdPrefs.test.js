import { describe, it, expect } from 'vitest';
import { sanitizeGtdPrefs } from './gtdPrefs.js';

describe('sanitizeGtdPrefs — gtdCollapsedSections', () => {
  it('keeps a flat section→bool map', () => {
    const { gtdCollapsedSections } = sanitizeGtdPrefs({ gtdCollapsedSections: { todo: true, someday: false } });
    expect(gtdCollapsedSections).toEqual({ todo: true, someday: false });
  });

  it('coerces values to booleans', () => {
    const { gtdCollapsedSections } = sanitizeGtdPrefs({ gtdCollapsedSections: { todo: 1, watch: 0, someday: 'x' } });
    expect(gtdCollapsedSections).toEqual({ todo: true, watch: false, someday: true });
  });

  it('rejects arrays and non-objects', () => {
    expect(sanitizeGtdPrefs({ gtdCollapsedSections: ['todo'] }).gtdCollapsedSections).toBeNull();
    expect(sanitizeGtdPrefs({ gtdCollapsedSections: 'todo' }).gtdCollapsedSections).toBeNull();
    expect(sanitizeGtdPrefs({ gtdCollapsedSections: 5 }).gtdCollapsedSections).toBeNull();
    expect(sanitizeGtdPrefs({}).gtdCollapsedSections).toBeNull();
  });

  it('drops keys that are too long and caps the number of entries', () => {
    const longKey = 'x'.repeat(80);
    const many = {};
    for (let i = 0; i < 40; i++) many[`k${i}`] = true;
    const { gtdCollapsedSections } = sanitizeGtdPrefs({ gtdCollapsedSections: { ...many, [longKey]: true } });
    expect(Object.keys(gtdCollapsedSections)).not.toContain(longKey);
    expect(Object.keys(gtdCollapsedSections).length).toBeLessThanOrEqual(20);
  });
});

describe('sanitizeGtdPrefs — gtdPetSlug', () => {
  it('accepts a valid slug (lowercased)', () => {
    expect(sanitizeGtdPrefs({ gtdPetSlug: 'steve-jobs' }).gtdPetSlug).toBe('steve-jobs');
    expect(sanitizeGtdPrefs({ gtdPetSlug: 'Steve-Jobs' }).gtdPetSlug).toBe('steve-jobs');
  });

  it('treats an empty/blank value as an explicit clear ("")', () => {
    expect(sanitizeGtdPrefs({ gtdPetSlug: '' }).gtdPetSlug).toBe('');
    expect(sanitizeGtdPrefs({ gtdPetSlug: '   ' }).gtdPetSlug).toBe('');
  });

  it('skips (null) when absent or invalid, so the stored value is untouched', () => {
    expect(sanitizeGtdPrefs({}).gtdPetSlug).toBeNull();
    expect(sanitizeGtdPrefs({ gtdPetSlug: 'has spaces' }).gtdPetSlug).toBeNull();
    expect(sanitizeGtdPrefs({ gtdPetSlug: '../etc/passwd' }).gtdPetSlug).toBeNull();
    expect(sanitizeGtdPrefs({ gtdPetSlug: 42 }).gtdPetSlug).toBeNull();
    expect(sanitizeGtdPrefs({ gtdPetSlug: 'x'.repeat(80) }).gtdPetSlug).toBeNull();
  });
});

describe('sanitizeGtdPrefs — allow-list integrity', () => {
  it('reads only canonical GTD keys and ignores unrelated keys', () => {
    const out = sanitizeGtdPrefs({
      gtdCollapsedSections: { todo: true },
      gtdPetSlug: 'steve-jobs',
      foo: 'bar',
    });
    expect(out).toEqual({ gtdCollapsedSections: { todo: true }, gtdPetSlug: 'steve-jobs' });
    expect(out).not.toHaveProperty('foo');
  });
});
