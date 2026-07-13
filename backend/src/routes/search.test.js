import { describe, it, expect, vi } from 'vitest';

// Keep route tests deterministic without opening a real DB or session store.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'u1' };
    next();
  },
}));

import express from 'express';
import { query } from '../services/db.js';
import {
  default as searchRoutes,
  parseSearchQuery,
  resolveSearchFolderScope,
  shouldExcludeTrashFromSearch,
  trashFolderExclusionCondition,
} from './search.js';

describe('GET /search', () => {
  it('selects recipient metadata needed by the selected-message header', async () => {
    const recipients = [{ name: 'Example Recipient', email: 'recipient@example.com' }];
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{ id: 'a1' }] })
      .mockImplementationOnce(async sql => {
        expect(sql).toContain('m.to_addresses');
        expect(sql).toContain('m.cc_addresses');
        return { rows: [{ id: 'm1', to_addresses: recipients, cc_addresses: [] }] };
      });

    const app = express();
    app.use('/search', searchRoutes);
    const server = await new Promise(resolve => {
      const listening = app.listen(0, () => resolve(listening));
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/search?q=recipient`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        messages: [{ id: 'm1', to_addresses: recipients, cc_addresses: [] }],
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

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
