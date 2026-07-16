import { describe, it, expect, vi } from 'vitest';

// search.js opens a DB handle and registers auth middleware at import time;
// neither is exercised by the pure parser under test, so stub them out.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));

import {
  parseSearchQuery,
  resolveSearchFolderScope,
  shouldExcludeTrashFromSearch,
  trashFolderExclusionCondition,
  freeTextTermCondition,
  FTS_BODY_CHAR_CAP,
} from './search.js';

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

  it('scopes search to the client folder param when no in: operator is present', () => {
    const { filters } = parseSearchQuery('subject:newsletter');
    expect(resolveSearchFolderScope(filters, 'INBOX')).toEqual({
      folderScope: 'INBOX',
      folderFuzzy: false,
    });
  });

  it('lets in: override the client folder param', () => {
    const { filters } = parseSearchQuery('in:trash subject:newsletter');
    expect(resolveSearchFolderScope(filters, 'INBOX')).toEqual({
      folderScope: 'trash',
      folderFuzzy: true,
    });
  });

  it('excludes trash-like folders from ordinary all-folder searches', () => {
    const { filters } = parseSearchQuery('subject:newsletter');
    const { folderScope } = resolveSearchFolderScope(filters);
    expect(folderScope).toBeNull();
    expect(shouldExcludeTrashFromSearch(folderScope)).toBe(true);
    expect(trashFolderExclusionCondition()).toContain('NOT EXISTS');
    expect(trashFolderExclusionCondition()).toContain('%trash%');
    expect(trashFolderExclusionCondition()).toContain('%deleted%');
  });

  it('keeps explicit folder searches eligible to find trash messages', () => {
    const { filters } = parseSearchQuery('in:trash subject:newsletter');
    const { folderScope } = resolveSearchFolderScope(filters);
    expect(shouldExcludeTrashFromSearch(folderScope)).toBe(false);
  });
});

describe('freeTextTermCondition (oversized-body crash hotfix)', () => {
  it('caps the body tsvector so a multi-megabyte email cannot exceed the 1MB tsvector limit', () => {
    const cond = freeTextTermCondition(3, 4);
    // The body text is fed to to_tsvector through LEFT(..., FTS_BODY_CHAR_CAP).
    // Without this cap a single oversized body raises SQLSTATE 54000 and 500s search.
    expect(cond).toContain(
      `to_tsvector('english', LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP}))`
    );
    // Guard against a regression back to the uncapped expression.
    expect(cond).not.toContain("to_tsvector('english', coalesce(m.body_text,'')) @@");
  });

  it('pins the cap at 600000 chars (msgvault maxFTSBodyChars parity)', () => {
    expect(FTS_BODY_CHAR_CAP).toBe(600000);
  });

  it('still matches sender, subject, and the stored search_vector at the given param positions', () => {
    const cond = freeTextTermCondition(3, 4);
    expect(cond).toContain('m.from_name ILIKE $3');
    expect(cond).toContain('m.from_email ILIKE $3');
    expect(cond).toContain('m.subject ILIKE $3');
    expect(cond).toContain("m.search_vector @@ plainto_tsquery('english', $4)");
  });
});
