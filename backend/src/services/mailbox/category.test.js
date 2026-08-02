import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));

import { query } from '../db.js';
import { setCategory } from './category.js';

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => query.mockReset());

describe('setCategory', () => {
  it('stores primary as null while returning the requested category', async () => {
    query.mockResolvedValue({ rows: [{ id: ID }] });

    const result = await setCategory(null, {
      userId: 'u1',
      accountIds: null,
      id: ID,
      category: 'primary',
    });

    expect(result).toEqual({ ok: true, category: 'primary' });
    expect(query.mock.calls[0][1]).toEqual([null, ID, 'u1']);
  });

  it('narrows the update to non-null accountIds', async () => {
    query.mockResolvedValue({ rows: [] });

    const result = await setCategory(null, {
      userId: 'u1',
      accountIds: ['a1'],
      id: ID,
      category: 'newsletter',
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Message not found' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('messages.account_id = ANY($4::uuid[])');
    expect(params).toEqual(['newsletter', ID, 'u1', ['a1']]);
  });
});
