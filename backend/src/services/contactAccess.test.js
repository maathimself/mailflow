import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { getOwnedContactByEmail } from './contactAccess.js';
beforeEach(() => query.mockReset());
it('looks up primary and secondary email addresses only within the user, preferring explicit contacts', async () => {
  query.mockResolvedValue({ rows: [{ first_name: 'Ada' }] });
  expect(await getOwnedContactByEmail('u1', 'ada@example.test')).toEqual({ first_name: 'Ada' });
  const [sql, params] = query.mock.calls[0];
  expect(params).toEqual(['u1', 'ada@example.test']);
  expect(sql).toContain('c.user_id = $1');
  expect(sql).toContain("lower(e->>'value') = lower($2)");
  expect(sql).toContain('ORDER BY c.is_auto ASC');
});
it('does not query without a user or recipient and returns null for a missing contact', async () => {
  expect(await getOwnedContactByEmail(null, 'a@b.test')).toBeNull();
  expect(await getOwnedContactByEmail('u1', null)).toBeNull();
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValue({ rows: [] });
  expect(await getOwnedContactByEmail('u1', 'a@b.test')).toBeNull();
});
