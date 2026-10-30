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

describe('API token requests', () => {
  // As apiTokenAuth sets them up: a plain request-only session and the token's identity.
  const tokenRequest = () => ({ session: { userId: USER, destroy: vi.fn() }, apiToken: { id: 't1', userId: USER } });
  const tokenReply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() });

  it('pass requireAuth without counting as the user being seen', async () => {
    query.mockResolvedValue({ rows: [{ id: USER }] });
    const next = vi.fn();
    await requireAuth(tokenRequest(), tokenReply(), next);
    expect(next).toHaveBeenCalledWith();
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it('whose user is gone get the token\'s 401, with no session to end', async () => {
    query.mockResolvedValue({ rows: [] });
    const req = tokenRequest();
    const res = tokenReply();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired API token' });
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="MailFlow", error="invalid_token"');
    expect(req.session.destroy).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('never pass requireAdmin, even a token of an admin', async () => {
    query.mockResolvedValue({ rows: [{ is_admin: true }] });
    const res = tokenReply();
    const next = vi.fn();
    await requireAdmin(tokenRequest(), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(touchLastSeen).not.toHaveBeenCalled();
  });
});
