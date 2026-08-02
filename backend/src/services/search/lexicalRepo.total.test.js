import { describe, it, expect, vi } from 'vitest';
vi.mock('../db.js', () => ({ query: vi.fn() }));
import { searchLexical } from './lexicalRepo.js';

// NOTE: the real searchLexical takes `client` as a FUNCTION (client(sql, params)),
// not an object with a .query method (the plan's Consumes was written earlier —
// real code wins). We adapt the fake accordingly.
const parsed = { filters: [], terms: [{ value: 'budget', negate: false }], unsupported: [] };

describe('searchLexical metadata total', () => {
  it('returns a real total via a bounded COUNT over the same predicate (no LIMIT/OFFSET)', async () => {
    const client = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'm1' }] })      // page query
      .mockResolvedValueOnce({ rows: [{ total: '42' }] });  // count query
    const out = await searchLexical(client, { parsed, accountIds: ['acc-1'], scope: 'metadata', limit: 20, offset: 0 });
    expect(out.total).toBe(42);
    const countSql = client.mock.calls[1][0];
    expect(countSql).toMatch(/COUNT\(\*\)/i);
    expect(countSql).not.toMatch(/\bLIMIT\b/i);
    expect(countSql).not.toMatch(/\bOFFSET\b/i);
  });

  it("does not COUNT for scope:'body' (no total)", async () => {
    const client = vi.fn().mockResolvedValueOnce({ rows: [] }); // page query only
    const out = await searchLexical(client, { parsed, accountIds: ['acc-1'], scope: 'body', limit: 20, offset: 0 });
    expect(out.total).toBeUndefined();
    expect(client.mock.calls.every((c) => !/COUNT\(\*\)/i.test(c[0]))).toBe(true);
  });
});
