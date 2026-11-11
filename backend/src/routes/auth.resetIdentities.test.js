import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  closeSockets: vi.fn(),
  disconnectUser: vi.fn(),
  kv: { set: vi.fn() },
  removeIdentities: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query, pool: {}, withTransaction: fn => fn({ query: mocks.query }) }));
vi.mock('../index.js', () => ({
  imapManager: { closeSockets: mocks.closeSockets, disconnectUser: mocks.disconnectUser },
}));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn(), SystemEmailNotConfigured: class SystemEmailNotConfigured extends Error {} }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn(async () => null) }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/kvStore.js', () => ({ kv: mocks.kv }));
vi.mock('../services/userIdentities.js', () => ({ removeIdentitiesForPasswordReset: mocks.removeIdentities }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(async () => ({ limited: false })),
  reset: vi.fn(),
}));
// Password hashing is not under test, and bcrypt at cost 12 is slow enough to matter under load.
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn(async () => 'new-hash'), hashSync: () => 'dummy-hash', compare: vi.fn() },
}));

import express from 'express';
import authRoutes from './auth.js';
import { logAuthEvent } from '../services/authEvents.js';

// #714: a self-service password reset removes the user's linked single sign-on identities (while
// password sign-in is on, which userIdentities.js decides), in the transaction that sets the
// password, and logs each one.
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = {}; next(); });
app.use('/api/auth', authRoutes);
let server, base;
beforeAll(async () => { await new Promise(r => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
afterAll(async () => { await new Promise(r => server.close(r)); });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async sql => (
    sql.includes('DELETE FROM password_reset_tokens') ? { rows: [{ user_id: 'u1' }] }
      : sql.includes('FROM users WHERE id') ? { rows: [{ username: 'maria' }] } : { rows: [] }));
});
const reset = () => fetch(`${base}/api/auth/reset-password`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'reset-token', password: 'a-new-password' }),
});
const sqls = () => mocks.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());

describe('a password reset and linked identities', () => {
  it('removes them after locking the user and setting the password, and logs each', async () => {
    mocks.removeIdentities.mockImplementation(async () => {
      mocks.query('-- identities removed');
      return [{ provider_name: 'Pocket ID' }, { provider_name: 'Google' }];
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await reset()).status).toBe(200);
    const order = sqls().filter(s => /FOR UPDATE|SET password_hash|identities removed/.test(s));
    expect(order).toEqual(['SELECT username FROM users WHERE id = $1 FOR UPDATE', 'UPDATE users SET password_hash = $1 WHERE id = $2', '-- identities removed']);
    expect(mocks.removeIdentities.mock.calls[0][1]).toBe('u1');
    expect(logAuthEvent.mock.calls.filter(([t]) => t === 'identity_unlinked')).toHaveLength(2);
  });

  it('logs nothing when none were removed', async () => {
    mocks.removeIdentities.mockResolvedValue([]);
    expect((await reset()).status).toBe(200);
    expect(logAuthEvent.mock.calls.filter(([t]) => t === 'identity_unlinked')).toEqual([]);
  });
});
