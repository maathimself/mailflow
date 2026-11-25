import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: {
  connectAccount: vi.fn().mockResolvedValue(undefined),
  disconnectAccount: vi.fn().mockResolvedValue(undefined),
  clearConnectCooldown: vi.fn(),
} }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false, allowNonstandardPorts: false }),
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ID = '66666666-6666-4666-8666-666666666666';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

// The stored account, as the ownership lookup now returns it (connection columns included).
const STORED = {
  id: ID, oauth_provider: null, enabled: true, auth_user: 'me',
  imap_host: 'imap.web.de', imap_port: 993, imap_tls: true, imap_skip_tls_verify: false,
};
// What the settings form posts: the whole account. Server fields equal to what is stored.
const FORM = {
  name: 'Inbox', sender_name: null, color: '#123456', icon: null,
  imap_host: 'imap.web.de', imap_port: 993, imap_skip_tls_verify: false,
  smtp_host: 'smtp.web.de', smtp_port: 587, smtp_tls: 'STARTTLS',
  include_in_unified_inbox: true, signature: null, signature_enabled: true,
};

describe('PUT /api/accounts/:id reconnects only when a connection field changes', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/accounts`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    imapManager.connectAccount.mockClear();
    imapManager.disconnectAccount.mockClear();
    query.mockReset().mockImplementation(async (sql) => {
      if (/^SELECT id, oauth_provider/.test(sql)) return { rows: [STORED] };
      if (/^UPDATE email_accounts/.test(sql)) return { rows: [{ id: ID, protocol: 'imap', enabled: true }] };
      if (/^SELECT \* FROM email_accounts/.test(sql)) return { rows: [STORED] };
      return { rows: [] };
    });
  });

  const put = (body) => fetch(`${base}/${ID}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('does not reconnect when the form re-sends unchanged server fields (plus a cosmetic + notifications change)', async () => {
    const res = await put({ ...FORM, notifications_enabled: false });
    expect(res.status).toBe(200);
    await tick();
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });

  it('reconnects when imap_host actually changes', async () => {
    const res = await put({ ...FORM, imap_host: 'imap.gmx.net' });
    expect(res.status).toBe(200);
    await tick();
    expect(imapManager.disconnectAccount).toHaveBeenCalled();
    expect(imapManager.connectAccount).toHaveBeenCalled();
  });

  it('reconnects when a new password is entered', async () => {
    const res = await put({ ...FORM, auth_pass: 'new-secret' });
    expect(res.status).toBe(200);
    await tick();
    expect(imapManager.connectAccount).toHaveBeenCalled();
  });
});
