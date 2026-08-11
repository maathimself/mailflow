import { describe, it, expect } from 'vitest';
import {
  parseQuery,
  resolveSearchFolderScope,
  shouldExcludeTrashFromSearch,
} from './queryParser.js';

const NOW = new Date('2026-07-16T00:00:00.000Z');

describe('parseQuery — preserved grammar', () => {
  it('treats bare words as free-text terms', () => {
    const { filters, terms } = parseQuery('hello world');
    expect(filters).toEqual([]);
    expect(terms).toEqual([
      { value: 'hello', negate: false },
      { value: 'world', negate: false },
    ]);
  });

  it('extracts positive operators and lowercases their values', () => {
    const { filters, terms } = parseQuery('from:Amazon subject:Invoice hello');
    expect(filters).toEqual([
      { key: 'from', value: 'amazon', negate: false },
      { key: 'subject', value: 'invoice', negate: false },
    ]);
    expect(terms).toEqual([{ value: 'hello', negate: false }]);
  });

  it('supports quoted operator values with spaces', () => {
    const { filters } = parseQuery('from:"John Smith" report');
    expect(filters).toEqual([{ key: 'from', value: 'john smith', negate: false }]);
  });

  it('negates an operator when prefixed with -', () => {
    const { filters } = parseQuery('-from:Smith report');
    expect(filters).toEqual([{ key: 'from', value: 'smith', negate: true }]);
  });

  it('negates a free-text term when prefixed with -', () => {
    const { terms } = parseQuery('report -invoice');
    expect(terms).toEqual([
      { value: 'report', negate: false },
      { value: 'invoice', negate: true },
    ]);
  });

  it('preserves repeated and mixed positive/negative operators', () => {
    const { filters } = parseQuery('from:alice -from:bob is:unread');
    expect(filters).toEqual([
      { key: 'from', value: 'alice', negate: false },
      { key: 'from', value: 'bob', negate: true },
      { key: 'is', value: 'unread', negate: false },
    ]);
  });

  it('ignores a lone - so it is not treated as a negated empty term', () => {
    const { terms } = parseQuery('report - draft');
    expect(terms).toEqual([
      { value: 'report', negate: false },
      { value: 'draft', negate: false },
    ]);
  });

  it('returns empty structures for blank input', () => {
    expect(parseQuery('')).toEqual({ filters: [], terms: [], unsupported: [], errors: [] });
    expect(parseQuery('    ')).toEqual({ filters: [], terms: [], unsupported: [], errors: [] });
  });

  it('parses in:all and named folders', () => {
    expect(parseQuery('in:all invoice').filters).toEqual([
      { key: 'in', value: 'all', negate: false },
    ]);
    expect(parseQuery('in:Sent proposal').filters).toEqual([
      { key: 'in', value: 'sent', negate: false },
    ]);
  });
});

describe('parseQuery — new msgvault operators', () => {
  it('adds cc: as a real filter', () => {
    const { filters } = parseQuery('cc:boss@corp.com report');
    expect(filters).toEqual([{ key: 'cc', value: 'boss@corp.com', negate: false }]);
  });

  it('maps newer_than: to an after: date and older_than: to a before: date', () => {
    const newer = parseQuery('newer_than:2w', { now: NOW }).filters;
    expect(newer[0].key).toBe('after');
    expect(newer[0].value.startsWith('2026-07-02')).toBe(true);

    const older = parseQuery('older_than:7d', { now: NOW }).filters;
    expect(older[0].key).toBe('before');
    expect(older[0].value.startsWith('2026-07-09')).toBe(true);
  });

  it('records larger:/smaller:/bcc:/label:/l: as recognized-but-unsupported (never widened)', () => {
    const { filters, unsupported } = parseQuery('larger:5M bcc:x@y.com label:work l:home smaller:100K');
    expect(filters).toEqual([]); // none of these silently become predicates
    expect(unsupported).toEqual([
      { key: 'larger', token: 'larger:5m' },
      { key: 'bcc', token: 'bcc:x@y.com' },
      { key: 'label', token: 'label:work' },
      { key: 'label', token: 'l:home' },
      { key: 'smaller', token: 'smaller:100k' },
    ]);
  });

  it('records a malformed typed value as an error, not a filter', () => {
    const { errors, unsupported } = parseQuery('larger:5X older_than:3q');
    expect(unsupported).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('larger');
    expect(errors[1]).toContain('older_than');
  });
});

describe('parseQuery — bare quoted phrases (Wave D Fix 4, msgvault tokenize parity)', () => {
  it('treats a double-quoted phrase as ONE term without the quote chars (port "quoted phrase")', () => {
    expect(parseQuery('"hello world"').terms).toEqual([{ value: 'hello world', negate: false }]);
  });

  it('mixes phrases with operators and bare words in order (port "mixed operators and text")', () => {
    const { filters, terms } = parseQuery('from:alice@example.com "meeting notes" urgent');
    expect(filters).toEqual([{ key: 'from', value: 'alice@example.com', negate: false }]);
    expect(terms).toEqual([
      { value: 'meeting notes', negate: false },
      { value: 'urgent', negate: false },
    ]);
  });

  it('keeps colons inside a phrase from becoming operators (port QuotedPhrasesWithColons)', () => {
    expect(parseQuery('"foo:bar"').terms).toEqual([{ value: 'foo:bar', negate: false }]);
    expect(parseQuery('"meeting at 10:30"').terms).toEqual([{ value: 'meeting at 10:30', negate: false }]);
    expect(parseQuery('"check http://example.com"').terms).toEqual([{ value: 'check http://example.com', negate: false }]);
    expect(parseQuery('"a:b:c:d"').terms).toEqual([{ value: 'a:b:c:d', negate: false }]);
  });

  it('parses a colon phrase alongside a real operator (port "quoted colon phrase mixed with real operator")', () => {
    const { filters, terms } = parseQuery('from:alice@example.com "subject:not an operator"');
    expect(filters).toEqual([{ key: 'from', value: 'alice@example.com', negate: false }]);
    expect(terms).toEqual([{ value: 'subject:not an operator', negate: false }]);
  });

  it('parses a leading phrase before an operator (port "operator followed by quoted colon phrase")', () => {
    const { filters, terms } = parseQuery('"re: meeting notes" from:bob@example.com');
    expect(filters).toEqual([{ key: 'from', value: 'bob@example.com', negate: false }]);
    expect(terms).toEqual([{ value: 're: meeting notes', negate: false }]);
  });

  it('accepts single-quoted phrases (msgvault tokenize takes both quote chars)', () => {
    expect(parseQuery("'hello world'").terms).toEqual([{ value: 'hello world', negate: false }]);
  });

  it('never starts a phrase at an apostrophe INSIDE a word', () => {
    expect(parseQuery("d'Angelo report").terms).toEqual([
      { value: "d'Angelo", negate: false },
      { value: 'report', negate: false },
    ]);
  });

  it('unescapes backslash-escaped quotes inside a phrase (msgvault unescapeQuotedValue)', () => {
    expect(parseQuery('"say \\"hi\\" now"').terms).toEqual([{ value: 'say "hi" now', negate: false }]);
    expect(parseQuery('"a\\\\b"').terms).toEqual([{ value: 'a\\b', negate: false }]);
  });

  it('negates a phrase with a leading -', () => {
    expect(parseQuery('report -"weekly digest"').terms).toEqual([
      { value: 'report', negate: false },
      { value: 'weekly digest', negate: true },
    ]);
  });

  it('drops an empty phrase and leaves op:"value" quoting to the operator grammar', () => {
    expect(parseQuery('""').terms).toEqual([]);
    expect(parseQuery('from:"John Smith"').filters).toEqual([{ key: 'from', value: 'john smith', negate: false }]);
    expect(parseQuery('from:"John Smith"').terms).toEqual([]);
  });
});

describe('parseQuery — before:/after: validation (Wave D Fix 5)', () => {
  it('records an invalid before:/after: value as an error, never a filter (no silent widening)', () => {
    const { filters, errors } = parseQuery('before:notadate after:2025-99-99 invoice');
    expect(filters).toEqual([]);
    expect(errors).toEqual([
      'invalid value "notadate" for before: — expected a date like YYYY-MM-DD',
      'invalid value "2025-99-99" for after: — expected a date like YYYY-MM-DD',
    ]);
  });

  it('keeps valid dates as filters (msgvault parseDate accepts several forms)', () => {
    const { filters, errors } = parseQuery('after:2025-01-02 before:2025/03/04');
    expect(errors).toEqual([]);
    expect(filters.map((f) => f.key)).toEqual(['after', 'before']);
  });
});

describe('resolveSearchFolderScope / shouldExcludeTrashFromSearch', () => {
  it('scopes to the client folder param when no in: operator is present', () => {
    const { filters } = parseQuery('subject:newsletter');
    expect(resolveSearchFolderScope(filters, 'INBOX')).toEqual({
      folderScope: 'INBOX',
      folderFuzzy: false,
    });
  });

  it('lets in: override the client folder param', () => {
    const { filters } = parseQuery('in:trash subject:newsletter');
    expect(resolveSearchFolderScope(filters, 'INBOX')).toEqual({
      folderScope: 'trash',
      folderFuzzy: true,
    });
  });

  it('flags all-folder searches for trash exclusion', () => {
    const { filters } = parseQuery('subject:newsletter');
    const { folderScope } = resolveSearchFolderScope(filters);
    expect(folderScope).toBeNull();
    expect(shouldExcludeTrashFromSearch(folderScope)).toBe(true);
  });

  it('keeps explicit folder searches eligible to find trash', () => {
    const { filters } = parseQuery('in:trash subject:newsletter');
    const { folderScope } = resolveSearchFolderScope(filters);
    expect(shouldExcludeTrashFromSearch(folderScope)).toBe(false);
  });
});
