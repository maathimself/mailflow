import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));

import { query } from '../services/db.js';
import { touchLastSeen } from '../services/lastSeen.js';
import { requireAuth, requireAdmin } from './auth.js';

const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const reply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const request = (userId = USER) => ({ session: userId ? { userId, destroy: vi.fn() } : {} });

beforeEach(() => {
  query.mockReset();
  touchLastSeen.mockReset();
});

describe('which requests count as the user being seen', () => {
  it('a signed-in user passing requireAuth', async () => {
    query.mockResolvedValue({ rows: [{ id: USER }] });
    const next = vi.fn();
    await requireAuth(request(), reply(), next);
    expect(next).toHaveBeenCalledWith();
    expect(touchLastSeen).toHaveBeenCalledWith(USER);
  });

  it('an admin passing requireAdmin, which the admin router uses on its own', async () => {
    query.mockResolvedValue({ rows: [{ is_admin: true }] });
    const next = vi.fn();
    await requireAdmin(request(), reply(), next);
    expect(next).toHaveBeenCalledWith();
    expect(touchLastSeen).toHaveBeenCalledWith(USER);
  });

  it('not a request that is turned away', async () => {
    const cases = [
      [requireAuth, request(null), null],
      [requireAuth, request(), { rows: [] }],
      [requireAdmin, request(null), null],
      [requireAdmin, request(), { rows: [{ is_admin: false }] }],
      [requireAdmin, request(), { rows: [] }],
    ];
    for (const [guard, req, row] of cases) {
      if (row) query.mockResolvedValueOnce(row);
      const res = reply();
      const next = vi.fn();
      await guard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status.mock.calls[0][0]).toBeGreaterThanOrEqual(401);
    }
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it('not a request whose lookup fails', async () => {
    query.mockRejectedValue(new Error('db down'));
    for (const guard of [requireAuth, requireAdmin]) {
      const next = vi.fn();
      await guard(request(), reply(), next);
      expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    }
    expect(touchLastSeen).not.toHaveBeenCalled();
  });
});
