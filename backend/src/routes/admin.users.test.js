import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => {
  const query = vi.fn();
  // The transaction client runs its statements through the same mock, so they are recorded in order.
  return { query, pool: {}, withTransaction: vi.fn(async fn => fn({ query })) };
});
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
import { listUsers, updateUser, setUserPassword, disableUserTotp } from './admin.js';

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER = 'bbbbbbbb-0000-4000-8000-000000000002';
const reply = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const request = (params, body) => ({ params, body, query: {}, ip: '203.0.113.7', session: { userId: ADMIN, username: 'admin' }, sessionID: 'current-session' });

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

// Statements run against the database, in order, without their parameters.
const sqls = () => query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
const events = () => query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO auth_events')).map(([, v]) => v);
// The target user's row for the lookups, and the acting admin's current name, which differs from
// the one in the session: the log must not show a name the admin no longer has.
function users({ recoveryEmail = 'maria@example.com' } = {}) {
  query.mockImplementation(async (sql, params) => {
    if (/FROM users WHERE id = \$1/.test(sql) && params?.[0] === ADMIN) return { rows: [{ username: 'admin-renamed' }] };
    if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ username: 'maria', recovery_email: recoveryEmail }] };
    return { rows: [] };
  });
}

describe('what an admin password reset takes away', () => {
  it('revokes trusted devices, pending reset links and email login codes with the password change', async () => {
    users();
    const res = reply();
    await setUserPassword(request({ id: USER }, { password: 'nova-senha-123' }), res);
    const run = sqls();
    const at = s => run.findIndex(x => x.startsWith(s));
    for (const table of ['trusted_devices', 'password_reset_tokens', 'email_otp_tokens']) {
      const i = at(`DELETE FROM ${table} WHERE user_id = $1`);
      expect(i, table).toBeGreaterThan(at('UPDATE users SET password_hash'));
      expect(query.mock.calls[i][1]).toEqual([USER]);
    }
    expect(destroyUserSessions).toHaveBeenCalledWith(USER, { exceptSessionId: undefined });
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('signs nobody out and logs nothing when the password change fails', async () => {
    users();
    const failing = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('DELETE FROM email_otp_tokens')) throw new Error('db down');
      return failing(sql, params);
    });
    await expect(setUserPassword(request({ id: USER }, { password: 'nova-senha-123' }), reply())).rejects.toThrow('db down');
    expect(destroyUserSessions).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });
});

describe('what a recovery email change takes away', () => {
  it('revokes pending reset links and login codes when the address changes', async () => {
    users();
    await updateUser(request({ id: USER }, { recoveryEmail: 'new@example.com' }), reply());
    const run = sqls();
    expect(run).toContain('DELETE FROM password_reset_tokens WHERE user_id = $1');
    expect(run).toContain('DELETE FROM email_otp_tokens WHERE user_id = $1');
    expect(run).not.toContain('DELETE FROM trusted_devices WHERE user_id = $1');
  });

  it('also when the address is removed', async () => {
    users();
    await updateUser(request({ id: USER }, { recoveryEmail: '' }), reply());
    expect(sqls()).toContain('DELETE FROM password_reset_tokens WHERE user_id = $1');
  });

  it('leaves them when the address is the same, or only the name changes', async () => {
    for (const body of [{ recoveryEmail: ' Maria@Example.com ' }, { username: 'maria.silva' }]) {
      users();
      query.mockClear();
      await updateUser(request({ id: USER }, body), reply());
      expect(sqls().filter(s => s.startsWith('DELETE')), JSON.stringify(body)).toEqual([]);
    }
  });
});

describe('the security log records admin changes and who made them', () => {
  const expectEvent = (type, username) => expect(events()).toEqual([[type, username, USER, 'admin-renamed', '203.0.113.7', true]]);

  it('a password set by an admin', async () => {
    users();
    await setUserPassword(request({ id: USER }, { password: 'nova-senha-123' }), reply());
    expectEvent('admin_password_set', 'maria');
  });

  it('an edit, under the name the account has afterwards', async () => {
    users();
    await updateUser(request({ id: USER }, { username: 'Maria.Silva' }), reply());
    expectEvent('admin_user_update', 'maria.silva');
  });

  it('2FA turned off by an admin', async () => {
    users();
    const res = reply();
    await disableUserTotp(request({ id: USER }), res);
    expect(sqls()).toContain('UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1');
    expectEvent('admin_totp_disable', 'maria');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('nothing for a refused or failed change', async () => {
    users();
    await updateUser(request({ id: USER }, { recoveryEmail: 'not-an-email' }), reply());
    await setUserPassword(request({ id: USER }, { password: 'short' }), reply());
    await disableUserTotp(request({ id: ADMIN }), reply());
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT username')) return { rows: [{ username: 'maria' }] };
      if (sql.startsWith('UPDATE users')) throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { rows: [] };
    });
    const taken = reply();
    await updateUser(request({ id: USER }, { username: 'joao' }), taken);
    expect(taken.status).toHaveBeenCalledWith(409);
    expect(events()).toEqual([]);
  });

  it("keeps an admin's session name current when they rename themselves", async () => {
    users();
    const req = request({ id: ADMIN }, { username: 'Chefe' });
    await updateUser(req, reply());
    expect(req.session.username).toBe('chefe');
  });
});
