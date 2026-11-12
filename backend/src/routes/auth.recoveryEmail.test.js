import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => {
  const query = vi.fn();
  // The transaction client runs its statements through the same mock, so they are recorded in order.
  return { query, pool: {}, withTransaction: vi.fn(async fn => fn({ query })) };
});
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/pushNotifications.js', () => ({ pushConfigured: false }));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({
  authLimiterConfig: { maxRequests: 10, windowMs: 900000 },
}));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn(), SystemEmailNotConfigured: class SystemEmailNotConfigured extends Error {} }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/kvStore.js', () => ({ kv: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(async () => ({ limited: false })),
  release: vi.fn(),
  reset: vi.fn(),
}));

import express from 'express';
import bcrypt from 'bcryptjs';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { sendSystemEmail } from '../services/mailer.js';

// Changing your own recovery email (Settings → Security) cancels what was already sent to the
// old address, as an admin change does: a reset link there would still set a new password, and
// the address may be changing because someone else has it. The change is confirmed as an API
// token is (here, a user with a password: the password), and the old address is told.
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const PASSWORD_HASH = bcrypt.hashSync('right', 4);
let server;
let base;
let stored;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: USER }; next(); });
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  stored = 'old@example.com';
  query.mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT id, username, password_hash, totp_enabled, totp_secret FROM users')) {
      return { rows: [{ id: USER, username: 'alice', password_hash: PASSWORD_HASH, totp_enabled: false, totp_secret: null }] };
    }
    if (sql.startsWith('SELECT recovery_email FROM users')) return { rows: [{ recovery_email: stored }] };
    if (sql.startsWith('UPDATE users SET recovery_email')) stored = params[0];
    return { rows: [] };
  });
});

const set = (email, confirm = { password: 'right' }) => fetch(`${base}/api/auth/profile/recovery-email`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, ...confirm }),
});
const deletes = () => query.mock.calls.map(([sql, params]) => [sql, params]).filter(([sql]) => sql.startsWith('DELETE'));
const updates = () => query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE users SET recovery_email'));

describe('PATCH /api/auth/profile/recovery-email', () => {
  it('a new address cancels pending reset links and login codes, after saving it', async () => {
    const res = await set('New@Example.com ');
    expect(res.status).toBe(200);
    expect(stored).toBe('new@example.com');
    expect(deletes()).toEqual([
      ['DELETE FROM password_reset_tokens WHERE user_id = $1', [USER]],
      ['DELETE FROM email_otp_tokens WHERE user_id = $1', [USER]],
    ]);
    const order = query.mock.calls.map(([sql]) => sql.split(' ').slice(0, 3).join(' '));
    expect(order.indexOf('UPDATE users SET')).toBeLessThan(order.indexOf('DELETE FROM password_reset_tokens'));
  });

  it('so does removing the address, or adding one where there was none', async () => {
    await set('');
    expect(stored).toBe(null);
    expect(deletes()).toHaveLength(2);
    vi.clearAllMocks();
    await set('first@example.com');
    expect(deletes()).toHaveLength(2);
  });

  it('a change is refused without the password, or with a wrong one, and changes nothing', async () => {
    for (const confirm of [{}, { password: 'wrong' }]) {
      const res = await set('new@example.com', confirm);
      expect(res.status).toBe(400);
      expect((await res.json()).reauth).toBe('password');
    }
    expect(stored).toBe('old@example.com');
    expect(updates()).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('the old address is told where the recovery email went', async () => {
    await set('new@example.com');
    await vi.waitFor(() => expect(sendSystemEmail).toHaveBeenCalledTimes(1));
    const [{ to, text }] = sendSystemEmail.mock.calls[0];
    expect(to).toBe('old@example.com');
    expect(text).toContain('n*w@example.com');
  });

  it('the notice escapes the new address, so it cannot hide its own warning', async () => {
    await set('a@<div/style=display:none>.com');
    await vi.waitFor(() => expect(sendSystemEmail).toHaveBeenCalledTimes(1));
    const [{ html }] = sendSystemEmail.mock.calls[0];
    expect(html).not.toContain('<div/style');
    expect(html).toContain('&lt;div/style=display:none&gt;');
  });

  it('the same address, in any case or spacing, keeps them, and needs no confirmation', async () => {
    const res = await set(' OLD@example.com', {});
    expect(res.status).toBe(200);
    expect(deletes()).toEqual([]);
  });

  it('an invalid address changes nothing', async () => {
    const res = await set('not-an-email');
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
