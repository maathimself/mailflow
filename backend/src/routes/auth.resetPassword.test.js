import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The tables the reset touches. query() changes them at once, as autocommit does; withTransaction
// changes a copy and keeps it only once its function has returned, so a throw leaves nothing behind.
const { db } = vi.hoisted(() => ({ db: { tables: null, failOn: null } }));
vi.mock('../services/db.js', () => {
  const run = (tables, sql, params) => {
    if (db.failOn && sql.startsWith(db.failOn)) throw new Error('timeout exceeded when trying to connect');
    if (sql.includes('DELETE FROM password_reset_tokens')) {
      const userId = tables.links[params[0]];
      delete tables.links[params[0]];
      return { rows: userId ? [{ user_id: userId }] : [] };
    }
    if (sql.startsWith('UPDATE users SET password_hash')) {
      tables.passwords[params[1]] = params[0];
      return { rows: [] };
    }
    const revoked = /^DELETE FROM (trusted_devices|api_tokens) WHERE user_id = \$1$/.exec(sql);
    if (revoked) {
      tables[revoked[1]] = tables[revoked[1]].filter(userId => userId !== params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  };
  return {
    query: vi.fn(async (sql, params) => run(db.tables, sql, params)),
    withTransaction: vi.fn(async (fn) => {
      const copy = structuredClone(db.tables);
      const result = await fn({ query: async (sql, params) => run(copy, sql, params) });
      db.tables = copy;
      return result;
    }),
    pool: {},
  };
});
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(), resolveForConnection: vi.fn() }));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../services/authLimiter.js', () => ({ authLimiterConfig: { maxRequests: 10, windowMs: 900000 } }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({ invalidateGlobalCategorizationCache: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false })), reset: vi.fn() }));
vi.mock('../services/userSessions.js', () => ({ destroyUserSessions: vi.fn() }));

import crypto from 'crypto';
import express from 'express';
import authRoutes from './auth.js';
import { destroyUserSessions } from '../services/userSessions.js';

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

const RESET = 'a'.repeat(64);
const before = () => ({
  links: { [crypto.createHash('sha256').update(RESET).digest('hex')]: 'user-1' },
  passwords: { 'user-1': 'old-hash', 'user-2': 'theirs' },
  trusted_devices: ['user-1', 'user-2'],
  api_tokens: ['user-1', 'user-1', 'user-2'],
});
beforeEach(() => {
  destroyUserSessions.mockReset();
  db.tables = before();
  db.failOn = null;
});

const reset = token => fetch(`${base}/api/auth/reset-password`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: 'a-new-password' }),
});

describe('POST /api/auth/reset-password', () => {
  it('revokes the user\'s API tokens with their sessions and trusted devices', async () => {
    const res = await reset(RESET);
    expect(res.status).toBe(200);
    expect(destroyUserSessions).toHaveBeenCalledWith('user-1');
    expect(db.tables.passwords['user-1']).not.toBe('old-hash');
    expect(db.tables.trusted_devices).toEqual(['user-2']);
    expect(db.tables.api_tokens).toEqual(['user-2']);
    // The link works once.
    expect((await reset(RESET)).status).toBe(400);
  });

  it('revokes nothing for a reset link that does not work', async () => {
    expect((await reset('b'.repeat(64))).status).toBe(400);
    expect(db.tables).toEqual(before());
    expect(destroyUserSessions).not.toHaveBeenCalled();
  });

  it('changes nothing when revoking fails part-way, so the same link can be used again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.failOn = 'DELETE FROM api_tokens';
    const res = await reset(RESET);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to reset password' });
    // The link is not spent, the password not changed, and no token survived a reset that went through.
    expect(db.tables).toEqual(before());
    expect(destroyUserSessions).not.toHaveBeenCalled();
    error.mockRestore();

    db.failOn = null;
    expect((await reset(RESET)).status).toBe(200);
    expect(db.tables.api_tokens).toEqual(['user-2']);
  });
});
