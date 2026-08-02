import { describe, expect, it } from 'vitest';
import {
  dedupePreferNamed,
  mapRecipientList,
  normalizeRecipients,
  parseAddress,
  sanitizeHeaderValue,
} from './addresses.js';

describe('parseAddress', () => {
  it.each([
    ['Name <USER@Example.com>', { name: 'Name', email: 'user@example.com' }],
    ['"Quoted Name"<user@example.com>', { name: 'Quoted Name', email: 'user@example.com' }],
    ['<USER@Example.com>', { name: '', email: 'user@example.com' }],
    [' USER@Example.com ', { name: '', email: 'user@example.com' }],
  ])('parses %j', (value, expected) => {
    expect(parseAddress(value)).toEqual(expected);
  });

  it('keeps the guarded draft call-site behavior for non-string values', () => {
    expect(parseAddress(null)).toEqual({ name: '', email: '' });
    expect(parseAddress(42)).toEqual({ name: '', email: '' });
  });
});

describe('recipient helpers', () => {
  it('maps recipient strings and tolerates absent lists', () => {
    expect(mapRecipientList(['A <a@example.com>', 'b@example.com'])).toEqual([
      { name: 'A', email: 'a@example.com' },
      { name: '', email: 'b@example.com' },
    ]);
    expect(mapRecipientList()).toEqual([]);
  });

  it('normalizes valid recipients without changing their display form', () => {
    expect(normalizeRecipients([' Name <A@example.com> '], 'to')).toEqual(['Name <A@example.com>']);
  });

  it.each([
    [undefined, 'to must be an array'],
    [[''], 'to[0] is empty or not a string'],
    [['a@example.com\nBcc: x@example.com'], 'to[0] contains invalid characters'],
    [['missing-at'], 'to[0] is not a valid email address'],
    [['missing@'], 'to[0] is not a valid email address'],
  ])('rejects malformed recipients with status 400', (value, message) => {
    expect(() => normalizeRecipients(value, 'to')).toThrowError(
      expect.objectContaining({ message, status: 400 }),
    );
  });

  it('sanitizes single-line header values', () => {
    expect(sanitizeHeaderValue('  hello\r\nBcc: x\0  ')).toBe('helloBcc: x');
    expect(sanitizeHeaderValue(null)).toBe('');
  });
});

describe('dedupePreferNamed', () => {
  it('deduplicates case-insensitively and replaces an unnamed entry with a named one', () => {
    expect(dedupePreferNamed([
      { name: '', email: 'A@example.com' },
      { name: 'Alice', email: 'a@EXAMPLE.com' },
      { name: 'Bob', email: 'b@example.com' },
      { name: '', email: 'B@example.com' },
    ])).toEqual([
      { name: 'Alice', email: 'a@EXAMPLE.com' },
      { name: 'Bob', email: 'b@example.com' },
    ]);
  });
});
