import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../index.js', () => ({ imapManager: { disconnectUser: vi.fn() } }));
vi.mock('../services/encryption.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(), invalidateConnectionPolicyCache: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn() } }));
vi.mock('../services/userSessions.js', () => ({ destroyUserSessions: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));

import bcrypt from 'bcryptjs';
import { query } from '../services/db.js';
import { destroyUserSessions } from '../services/userSessions.js';
import { listUsers, updateUser, setUserPassword } from './admin.js';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000002';
const reply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const request = (params, body) => ({ params, body, query: {}, session: { userId: ADMIN, username: 'admin' }, sessionID: 'current-session' });

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [{ username: 'maria' }] });
  destroyUserSessions.mockReset().mockResolvedValue();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('GET /admin/users', () => {
  it('reports when each user was last seen, and never the password hash', async () => {
    const seen = new Date('2026-09-20T10:00:00Z');
    query
      .mockResolvedValueOnce({ rows: [{
        id: USER, username: 'maria', is_admin: false, totp_enabled: false, created_at: seen,
        last_seen_at: seen, recovery_email: 'maria@example.com', has_password: true,
      }] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });
    const res = reply();
    await listUsers({ query: {} }, res);
    const [user] = res.json.mock.calls[0][0].users;
    expect(user).toMatchObject({ lastSeenAt: seen, recoveryEmail: 'maria@example.com', hasPassword: true });
    expect(JSON.stringify(user)).not.toMatch(/password_hash|\$2[aby]\$/);
    expect(query.mock.calls[0][0]).not.toMatch(/SELECT[^;]*\bpassword_hash\b\s*,/);
  });
});

describe('PATCH /admin/users/:id', () => {
  it('changes only the fields it is given', async () => {
    const res = reply();
    await updateUser(request({ id: USER }, { username: '  Maria.Silva ', recoveryEmail: 'Maria@Example.com ' }), res);
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE users'));
    expect(update[0]).toBe('UPDATE users SET username = $1, recovery_email = $2 WHERE id = $3');
    expect(update[1]).toEqual(['maria.silva', 'maria@example.com', USER]);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('clears the recovery email when given an empty one', async () => {
    await updateUser(request({ id: USER }, { recoveryEmail: '' }), reply());
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE users'));
    expect(update[1]).toEqual([null, USER]);
  });

  it('rejects an invalid username or email before touching the database', async () => {
    for (const body of [{ username: '   ' }, { username: 'a\u0007b' }, { username: 'x'.repeat(121) }, { recoveryEmail: 'not-an-email' }, {}]) {
      query.mockClear();
      const res = reply();
      await updateUser(request({ id: USER }, body), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('reports a username that is already taken', async () => {
    query.mockResolvedValueOnce({ rows: [{ username: 'maria' }] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    const res = reply();
    await updateUser(request({ id: USER }, { username: 'joao' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('still refuses to remove your own admin status, and still toggles admin for others', async () => {
    const own = reply();
    await updateUser(request({ id: ADMIN }, { isAdmin: false }), own);
    expect(own.status).toHaveBeenCalledWith(400);
    await updateUser(request({ id: USER }, { isAdmin: true }), reply());
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE users'));
    expect(update).toEqual(['UPDATE users SET is_admin = $1 WHERE id = $2', [true, USER]]);
  });

  it('answers 404 for a user that does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = reply();
    await updateUser(request({ id: USER }, { username: 'joao' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /admin/users/:id/password', () => {
  it('stores a bcrypt hash and signs the user out everywhere', async () => {
    const res = reply();
    await setUserPassword(request({ id: USER }, { password: 'nova-senha-123' }), res);
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE users SET password_hash'));
    expect(await bcrypt.compare('nova-senha-123', update[1][0])).toBe(true);
    expect(update[1][1]).toBe(USER);
    expect(destroyUserSessions).toHaveBeenCalledWith(USER, { exceptSessionId: undefined });
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("keeps the admin's own session when they set their own password", async () => {
    await setUserPassword(request({ id: ADMIN }, { password: 'nova-senha-123' }), reply());
    expect(destroyUserSessions).toHaveBeenCalledWith(ADMIN, { exceptSessionId: 'current-session' });
  });

  it('refuses short, missing or over-long passwords', async () => {
    for (const password of ['1234567', undefined, 12345678, 'ç'.repeat(40)]) {
      query.mockClear();
      const res = reply();
      await setUserPassword(request({ id: USER }, { password }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
      expect(destroyUserSessions).not.toHaveBeenCalled();
    }
  });
});
