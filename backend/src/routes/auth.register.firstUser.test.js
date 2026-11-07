import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// FIRST_USER_REGISTRATION=false: where admins come from single sign-on, the first visitor to
// register must not become admin, and must not get past the registration settings either.
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
import { closeRegistrationBeforeFirstUser, firstUserRegistrationAllowed } from '../services/firstUserRegistration.js';

let server, base, clientQueries, registrationOpen, userCount;

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
  registrationOpen = 'true';
  userCount = '0';
  pool.connect.mockReset().mockImplementation(async () => ({
    query: vi.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ count: userCount }] };
      if (sql.includes("key IN ('registration_open'")) return { rows: [{ key: 'registration_open', value: registrationOpen }] };
      if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 'u-new', username: params[0], is_admin: params[2] }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  }));
});

afterEach(() => {
  delete process.env.FIRST_USER_REGISTRATION;
});

async function register() {
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'maria', password: 'nova-senha-123' }),
  });
  const insert = clientQueries.find(q => q.sql.startsWith('INSERT INTO users'));
  return { status: response.status, isAdmin: insert ? insert.params[2] : null };
}

describe('POST /api/auth/register on an install without accounts', () => {
  it('makes the first account admin, whatever the settings say, by default', async () => {
    registrationOpen = 'false';
    expect(await register()).toEqual({ status: 200, isAdmin: true });
  });

  it('applies the registration settings to the first account with FIRST_USER_REGISTRATION=false', async () => {
    process.env.FIRST_USER_REGISTRATION = 'false';
    registrationOpen = 'false';
    expect(await register()).toEqual({ status: 403, isAdmin: null });
  });

  it('never makes it admin with FIRST_USER_REGISTRATION=false, even with registration open', async () => {
    process.env.FIRST_USER_REGISTRATION = 'false';
    expect(await register()).toEqual({ status: 200, isAdmin: false });
    expect(clientQueries.some(q => /registration_open', 'false'/.test(q.sql))).toBe(false);
  });
});

describe('POST /api/auth/register on an install that already has accounts', () => {
  // Setting FIRST_USER_REGISTRATION=false on an existing install must change nothing: same answer,
  // same account, same queries as without it.
  it.each(['true', 'false'])('behaves exactly as without it, with registration_open=%s', async open => {
    userCount = '3';
    registrationOpen = open;
    const without = await register();
    const queriesWithout = clientQueries.map(q => q.sql);

    clientQueries = [];
    process.env.FIRST_USER_REGISTRATION = 'false';
    expect(await register()).toEqual(without);
    expect(clientQueries.map(q => q.sql)).toEqual(queriesWithout);
    expect(without.isAdmin).not.toBe(true);
  });
});

describe('FIRST_USER_REGISTRATION', () => {
  it.each([undefined, '', 'true', '1', 'yes'])('leaves the first-user path on for %j', value => {
    expect(firstUserRegistrationAllowed(value === undefined ? {} : { FIRST_USER_REGISTRATION: value })).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ' false '])('turns it off for %j', value => {
    expect(firstUserRegistrationAllowed({ FIRST_USER_REGISTRATION: value })).toBe(false);
  });

  it('closes registration at startup only while no account exists', async () => {
    const queryFn = vi.fn(async () => ({ rowCount: 1 }));
    expect(await closeRegistrationBeforeFirstUser({ env: {}, queryFn })).toBe(false);
    expect(queryFn).not.toHaveBeenCalled();

    expect(await closeRegistrationBeforeFirstUser({ env: { FIRST_USER_REGISTRATION: 'false' }, queryFn })).toBe(true);
    const [sql] = queryFn.mock.calls[0];
    expect(sql).toMatch(/SET value = 'false'/);
    expect(sql).toMatch(/key = 'registration_open'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM users\)/);
  });
});
