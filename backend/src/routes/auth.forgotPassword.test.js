import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
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
vi.mock('../services/mailer.js', () => ({ sendSystemEmail: vi.fn() }));
vi.mock('./oidc.js', () => ({ buildEndSessionUrl: vi.fn() }));
vi.mock('../services/categorizer.js', () => ({
  invalidateGlobalCategorizationCache: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/rateLimiter.js', () => ({
  consume: vi.fn(),
  reset: vi.fn(),
}));

import express from 'express';
import authRoutes from './auth.js';
import { query } from '../services/db.js';
import { resolveForConnection } from '../services/hostValidation.js';
import { createSmtpTransport } from '../services/smtpTransport.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { consume } from '../services/rateLimiter.js';

const ACCOUNT = {
  name: 'Alice',
  email_address: 'alice@example.com',
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_tls: 'STARTTLS',
  auth_user: 'alice@example.com',
  auth_pass: 'account-password',
};

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

// No System Email is configured, so the reset link goes out through the account's own
// SMTP credentials, and anyone who knows the recovery address can make that happen.
describe('POST /api/auth/forgot-password account fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consume.mockResolvedValue({ limited: false });
    query.mockImplementation(async sql => {
      if (/FROM users WHERE recovery_email/.test(sql)) {
        return { rows: [{ id: 'user-1', password_hash: 'hash' }] };
      }
      if (/FROM email_accounts/.test(sql)) return { rows: [ACCOUNT] };
      return { rows: [] };
    });
    resolveForConnection.mockResolvedValue({ host: '203.0.113.10', addresses: ['203.0.113.10'] });
    createSmtpTransport.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}) });
  });

  async function requestReset() {
    const response = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    expect(response.status).toBe(200);
    expect(createSmtpTransport).toHaveBeenCalledTimes(1);
    return createSmtpTransport.mock.calls[0][1];
  }

  it('requires STARTTLS before the account password is sent', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });

    const options = await requestReset();

    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it('leaves STARTTLS opportunistic when the admin allows insecure TLS', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: true });

    const options = await requestReset();

    expect(options.requireTLS).toBeFalsy();
  });
});
