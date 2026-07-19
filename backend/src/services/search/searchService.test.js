import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('./lexicalRepo.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, searchLexical: vi.fn() };
});

import { query } from '../db.js';
import { searchLexical } from './lexicalRepo.js';
import { search } from './searchService.js';

beforeEach(() => {
  query.mockReset();
  searchLexical.mockReset();
});

function withAccounts(ids) {
  query.mockResolvedValueOnce({ rows: ids.map(id => ({ id })) });
}

describe('searchService.search', () => {
  it('returns an empty shaped result when the user has no enabled accounts', async () => {
    withAccounts([]);
    const res = await search({ userId: 'u1', parsed: { filters: [], terms: [{ value: 'hi', negate: false }] } });
    expect(res).toEqual({ messages: [], mode: 'lexical', page: { offset: 0, limit: 50, hasMore: false } });
    expect(searchLexical).not.toHaveBeenCalled();
  });

  it('scopes to a single account only when it belongs to the user', async () => {
    withAccounts(['a1', 'a2']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: true });
    await search({ userId: 'u1', accountId: 'a2', parsed: { filters: [], terms: [{ value: 'hi', negate: false }] } });
    expect(searchLexical.mock.calls[0][1].accountIds).toEqual(['a2']);
  });

  it('chooses relevance ordering for free text and date ordering for filter-only queries', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: true });
    await search({ userId: 'u1', parsed: { filters: [], terms: [{ value: 'invoice', negate: false }] } });
    expect(searchLexical.mock.calls[0][1].ordering).toBe('relevance');

    query.mockReset(); searchLexical.mockReset();
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: true });
    await search({ userId: 'u1', parsed: { filters: [{ key: 'is', value: 'unread', negate: false }], terms: [] } });
    expect(searchLexical.mock.calls[0][1].ordering).toBe('date');
  });

  it('shapes rows into messages + page, clamping the limit to 200 and flagging hasMore on a full page', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: new Array(200).fill({ id: 'm' }), hasCondition: true });
    const res = await search({ userId: 'u1', limit: 9999, offset: 40, parsed: { filters: [], terms: [{ value: 'x', negate: false }] } });
    expect(res.messages).toHaveLength(200);
    expect(res.mode).toBe('lexical');
    expect(res.page).toEqual({ offset: 40, limit: 200, hasMore: true });
    expect(searchLexical.mock.calls[0][1].limit).toBe(200);
  });

  it('returns empty when there is no real search condition', async () => {
    withAccounts(['a1']);
    searchLexical.mockResolvedValue({ rows: [], hasCondition: false });
    const res = await search({ userId: 'u1', parsed: { filters: [{ key: 'in', value: 'inbox', negate: false }], terms: [] } });
    expect(res.messages).toEqual([]);
    expect(res.page.hasMore).toBe(false);
  });
});
