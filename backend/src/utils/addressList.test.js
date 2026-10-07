import { describe, expect, it } from 'vitest';
import { normalizeAddressList } from './addressList.js';

const LABEL = 'Automatic Bcc';

function rejectionOf(value, options) {
  try {
    normalizeAddressList(value, LABEL, options);
  } catch (err) {
    return err;
  }
  throw new Error('expected normalizeAddressList to throw');
}

const numbered = n => Array.from({ length: n }, (_, i) => `user${i}@example.com`);

describe('normalizeAddressList', () => {
  it('trims, drops blanks and removes duplicates ignoring case, keeping the first spelling', () => {
    expect(normalizeAddressList([' Me@Example.com ', 'me@example.com', 'other@example.invalid', '', '  '], LABEL))
      .toEqual(['Me@Example.com', 'other@example.invalid']);
  });

  it('treats a missing list as empty', () => {
    expect(normalizeAddressList(null, LABEL)).toEqual([]);
    expect(normalizeAddressList(undefined, LABEL)).toEqual([]);
  });

  it('accepts an address of exactly 254 characters', () => {
    const longest = `${'a'.repeat(242)}@example.com`;
    expect(normalizeAddressList([longest], LABEL)).toEqual([longest]);
  });

  it('counts the limit after removing duplicates', () => {
    expect(normalizeAddressList([...numbered(10), 'USER0@example.com'], LABEL)).toEqual(numbered(10));
  });

  it.each([
    ['a single string instead of a list', 'me@example.com', `${LABEL} must be a list of email addresses`],
    ['an entry that is not a string', ['me@example.com', 42], `${LABEL}: entry 2 is not a string`],
    ['two addresses in one entry', ['a@example.com, b@example.com'], '"a@example.com, b@example.com" is not a single email address'],
    ['a display name', ['Me <me@example.com>'], '"Me <me@example.com>" is not a single email address'],
    ['an injected header', ['a@example.com\r\nBcc: x@example.invalid'], '"a@example.com\\r\\nBcc: x@example.invalid" contains invalid characters'],
    ['a null byte', ['me@example.com\0'], 'contains invalid characters'],
    ['a domain without a dot', ['nobody@localhost'], '"nobody@localhost" is not a single email address'],
    ['an address over 254 characters', [`${'a'.repeat(243)}@example.com`], 'is longer than 254 characters'],
    ['more than 10 addresses', numbered(11), 'at most 10 addresses'],
  ])('rejects %s with a 400 naming the list and the entry', (_name, value, message) => {
    const err = rejectionOf(value);
    expect(err.status).toBe(400);
    expect(err.message).toContain(LABEL);
    expect(err.message).toContain(message);
  });

  it('applies a custom limit', () => {
    expect(rejectionOf(numbered(3), { max: 2 }).message).toBe(`${LABEL}: at most 2 addresses are allowed`);
  });
});
