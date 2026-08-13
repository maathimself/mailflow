import { describe, expect, it } from 'vitest';

import { parseContactSource } from './contacts.js';

describe('parseContactSource', () => {
  it('accepts the address-book sources exposed by the contacts list', () => {
    expect(parseContactSource(undefined)).toBe(null);
    expect(parseContactSource('carddav')).toBe('carddav');
    expect(parseContactSource('local')).toBe('local');
  });

  it('rejects unknown and repeated source parameters', () => {
    expect(() => parseContactSource('remote')).toThrow(/invalid contact source/i);
    expect(() => parseContactSource(['carddav', 'local'])).toThrow(/invalid contact source/i);
  });
});
