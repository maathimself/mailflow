import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A new account takes the admin's "Allow AI for new users" setting (#644), which is on until it
// is turned off.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: { connectAllForUser: vi.fn() } }));
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

import express from 'express';
import session from 'express-session';
import { pool } from '../services/db.js';
import authRoutes from './auth.js';

let server, base, clientQueries, userCount, newUsersSetting;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, store: new session.MemoryStore() }));
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  clientQueries = [];
  userCount = 1;
  newUsersSetting = undefined;
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ count: String(userCount) }] };
      if (sql.includes("key IN ('registration_open'")) return { rows: [{ key: 'registration_open', value: 'true' }] };
      if (sql.includes('FROM system_settings WHERE key = $1') && params[0] === 'ai_new_users_enabled') {
        return { rows: newUsersSetting === undefined ? [] : [{ value: newUsersSetting }] };
      }
      if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 'u-new', username: params[0], is_admin: params[2] }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  }));
});

async function register() {
  clientQueries = [];
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'maria', password: 'nova-senha-123' }),
  });
  expect(response.status).toBe(200);
  const insert = clientQueries.find(q => q.sql.startsWith('INSERT INTO users'));
  expect(insert.sql).toMatch(/\(username, password_hash, is_admin, ai_enabled\)/);
  return insert.params[3];
}

describe('POST /api/auth/register: AI access for the new account', () => {
  it('is on when the setting has never been saved, including for the first user', async () => {
    expect(await register()).toBe(true);
    userCount = 0;
    expect(await register()).toBe(true);
  });

  it('follows "Allow AI for new users"', async () => {
    newUsersSetting = 'false';
    expect(await register()).toBe(false);
    newUsersSetting = 'true';
    expect(await register()).toBe(true);
  });

  it('reads the setting inside the registration transaction', async () => {
    newUsersSetting = 'false';
    await register();
    const sqls = clientQueries.map(q => q.sql);
    const read = clientQueries.findIndex(q => q.params?.[0] === 'ai_new_users_enabled');
    expect(read).toBeGreaterThan(sqls.indexOf('BEGIN'));
    expect(read).toBeLessThan(sqls.findIndex(s => s.startsWith('INSERT INTO users')));
  });
});
