import { it, expect, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('./lexicalRepo.js', () => ({ searchLexical: vi.fn(), buildOperatorClauses: vi.fn(), hasSearchableToken: vi.fn() }));
import { query } from '../db.js';
import { searchLexical } from './lexicalRepo.js';
import { search } from './searchService.js';

it('passes the metadata total through to the service result', async () => {
  query.mockResolvedValue({ rows: [{ id: 'acc-1' }] });
  searchLexical.mockResolvedValue({ rows: [{ id: 'm1' }], total: 42, hasCondition: true });
  const parsed = { filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] };
  const r = await search({ mode: 'lexical', userId: 'user-1', parsed, limit: 20, offset: 0 });
  expect(r.total).toBe(42);
  expect(searchLexical.mock.calls[0][1]).toMatchObject({ accountIds: ['acc-1'] });
});
