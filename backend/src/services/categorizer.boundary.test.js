import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ completeText: vi.fn() }));

import { query } from './db.js';
import { backfillCategories, invalidateSocialDomainCache } from './categorizer.js';

describe('backfillCategories folder boundary', () => {
  beforeEach(() => query.mockReset());

  it('reads only rows owned by a present folder with a known UID epoch', async () => {
    invalidateSocialDomainCache('user-1');
    query.mockImplementation(async (sql) => {
      if (typeof sql !== 'string') return { rows: [] };
      if (sql.includes('FROM category_list_sources')) return { rows: [] };
      if (sql.includes('SELECT m.id, m.from_email, m.is_bulk')) {
        return { rows: [{ id: 'row-1', from_email: 'news@example.com', is_bulk: true }] };
      }
      return { rows: [] };
    });

    await expect(backfillCategories('acct-1', 'user-1')).resolves.toBe(1);

    const selectSql = query.mock.calls.find(
      ([sql]) => sql.includes('SELECT m.id, m.from_email, m.is_bulk'),
    )[0];
    expect(selectSql).toMatch(/JOIN folders f/);
    expect(selectSql).toMatch(/f\.account_id = m\.account_id/);
    expect(selectSql).toMatch(/f\.path = m\.folder/);
    expect(selectSql).toMatch(/f\.is_present = true/);
    expect(selectSql).toMatch(/f\.uid_validity IS NOT NULL/);
  });
});
