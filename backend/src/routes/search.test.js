import { describe, it, expect, vi } from 'vitest';

// search.js opens a DB handle and registers auth middleware at import time;
// neither is exercised by the pure parser under test, so stub them out.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));

import { parseSearchQuery } from './search.js';

describe('parseSearchQuery', () => {
  it('treats bare words as free-text terms', () => {
    const { filters, terms } = parseSearchQuery('hello world');
    expect(filters).toEqual([]);
    expect(terms).toEqual([
      { value: 'hello', negate: false },
      { value: 'world', negate: false },
    ]);
  });

  it('extracts positive operators and lowercases their values', () => {
    const { filters, terms } = parseSearchQuery('from:Amazon subject:Invoice hello');
    expect(filters).toEqual([
      { key: 'from', value: 'amazon', negate: false },
      { key: 'subject', value: 'invoice', negate: false },
    ]);
    expect(terms).toEqual([{ value: 'hello', negate: false }]);
  });

  it('supports quoted operator values with spaces', () => {
    const { filters, terms } = parseSearchQuery('from:"John Smith" report');
    expect(filters).toEqual([{ key: 'from', value: 'john smith', negate: false }]);
    expect(terms).toEqual([{ value: 'report', negate: false }]);
  });

  it('negates an operator when prefixed with -', () => {
    const { filters, terms } = parseSearchQuery('-from:Smith report');
    expect(filters).toEqual([{ key: 'from', value: 'smith', negate: true }]);
    expect(terms).toEqual([{ value: 'report', negate: false }]);
  });

  it('negates a free-text term when prefixed with -', () => {
    const { filters, terms } = parseSearchQuery('report -invoice');
    expect(filters).toEqual([]);
    expect(terms).toEqual([
      { value: 'report', negate: false },
      { value: 'invoice', negate: true },
    ]);
  });

  it('parses the in: scope operator (in:all and named folders)', () => {
    expect(parseSearchQuery('in:all invoice').filters).toEqual([
      { key: 'in', value: 'all', negate: false },
    ]);
    expect(parseSearchQuery('in:Sent proposal').filters).toEqual([
      { key: 'in', value: 'sent', negate: false },
    ]);
  });

  it('preserves repeated and mixed positive/negative operators', () => {
    const { filters } = parseSearchQuery('from:alice -from:bob is:unread');
    expect(filters).toEqual([
      { key: 'from', value: 'alice', negate: false },
      { key: 'from', value: 'bob', negate: true },
      { key: 'is', value: 'unread', negate: false },
    ]);
  });

  it('ignores a lone - so it is not treated as a negated empty term', () => {
    const { filters, terms } = parseSearchQuery('report - draft');
    expect(filters).toEqual([]);
    expect(terms).toEqual([
      { value: 'report', negate: false },
      { value: 'draft', negate: false },
    ]);
  });

  it('returns empty structures for blank input', () => {
    expect(parseSearchQuery('')).toEqual({ filters: [], terms: [] });
    expect(parseSearchQuery('    ')).toEqual({ filters: [], terms: [] });
  });

  it('does not treat unknown prefixes as operators', () => {
    const { filters, terms } = parseSearchQuery('label:work');
    expect(filters).toEqual([]);
    expect(terms).toEqual([{ value: 'label:work', negate: false }]);
  });

  it('handles all supported operator keys', () => {
    const raw = 'from:a to:b subject:c has:attachment is:starred after:2024-01-01 before:2024-12-31 in:archive';
    const keys = parseSearchQuery(raw).filters.map(f => f.key);
    expect(keys).toEqual(['from', 'to', 'subject', 'has', 'is', 'after', 'before', 'in']);
  });
});
