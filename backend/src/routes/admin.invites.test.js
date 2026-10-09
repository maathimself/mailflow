import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAdmin: (req, _res, next) => {
    req.session = { userId: 'admin-1', username: 'admin' };
    next();
  },
}));
vi.mock('../services/encryption.js', () => ({
  decrypt: value => value,
  encrypt: value => value,
}));
vi.mock('../services/hostValidation.js', () => ({
  validateHost: vi.fn(),
  resolveForConnection: vi.fn(),
}));
vi.mock('../services/smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn(),
  invalidateConnectionPolicyCache: vi.fn(),
}));
vi.mock('../services/authLimiter.js', () => ({ reloadAuthSettings: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/carddavSync.js', () => ({ stopCardavUser: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: {} }));

import express from 'express';
import adminRoutes from './admin.js';
import { query } from '../services/db.js';
import { resolveForConnection } from '../services/hostValidation.js';
import { createSmtpTransport } from '../services/smtpTransport.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';

const ACCOUNT = {
  name: 'Admin',
  email_address: 'admin@example.com',
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_tls: 'STARTTLS',
  auth_user: 'admin@example.com',
  auth_pass: 'account-password',
};

let server;
let base;
let previousAppUrl;

beforeAll(async () => {
  previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://mail.example.com';
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
});

// No System Email is configured, so the invite goes out through the admin's own account.
describe('POST /api/admin/invites account fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async sql => (
      /FROM email_accounts/.test(sql) ? { rows: [ACCOUNT] } : { rows: [] }
    ));
    resolveForConnection.mockResolvedValue({ host: '203.0.113.10', addresses: ['203.0.113.10'] });
    createSmtpTransport.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}) });
  });

  async function sendInvite() {
    const response = await fetch(`${base}/api/admin/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new.user@example.com' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, emailSent: true });
    expect(createSmtpTransport).toHaveBeenCalledTimes(1);
    return createSmtpTransport.mock.calls[0][1];
  }

  it('requires STARTTLS before the account password is sent', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });

    const options = await sendInvite();

    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it('leaves STARTTLS opportunistic when the admin allows insecure TLS', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: true });

    const options = await sendInvite();

    expect(options.requireTLS).toBeFalsy();
  });
});
