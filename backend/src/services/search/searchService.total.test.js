import { it, expect, vi } from 'vitest';
vi.mock('./lexicalRepo.js', () => ({ searchLexical: vi.fn(), buildOperatorClauses: vi.fn(), hasSearchableToken: vi.fn() }));
import { searchLexical } from './lexicalRepo.js';
import { search } from './searchService.js';

it('passes the metadata total through to the service result', async () => {
  searchLexical.mockResolvedValue({ rows: [{ id: 'm1' }], total: 42, hasCondition: true });
  const parsed = { filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] };
  const r = await search({ mode: 'lexical', scope: 'metadata', parsed, accountIds: ['acc-1'], limit: 20, offset: 0 });
  expect(r.total).toBe(42);
  expect(searchLexical.mock.calls[0][1]).toMatchObject({ scope: 'metadata', accountIds: ['acc-1'] });
});
