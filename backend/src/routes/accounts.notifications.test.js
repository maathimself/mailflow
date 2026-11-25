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

const ID = '55555555-5555-4555-8555-555555555555';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('PUT /api/accounts/:id notifications_enabled', () => {
  let server;
  let base;
  let provider;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/accounts`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    provider = null;
    imapManager.connectAccount.mockClear();
    imapManager.disconnectAccount.mockClear();
    query.mockReset().mockImplementation(async (sql) => {
      if (/^SELECT id, oauth_provider/.test(sql)) return { rows: [{ id: ID, oauth_provider: provider }] };
      if (/^UPDATE email_accounts/.test(sql)) return { rows: [{ id: ID, protocol: 'imap', enabled: true, notifications_enabled: false }] };
      if (/^SELECT \* FROM email_accounts/.test(sql)) return { rows: [{ id: ID, protocol: 'imap', enabled: true, notifications_enabled: false }] };
      return { rows: [] };
    });
  });

  const put = (body) => fetch(`${base}/${ID}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('writes the column and returns it', async () => {
    const res = await put({ notifications_enabled: false });
    expect(res.status).toBe(200);
    expect((await res.json()).notifications_enabled).toBe(false);
    const sql = query.mock.calls.find(([q]) => /^UPDATE email_accounts/.test(q))?.[0] || '';
    expect(sql).toContain('notifications_enabled = $1');
  });

  // The toggle is applied by the sync loop reading the column fresh (see imapManager), not by a
  // reconnect: changing only notifications_enabled must NOT churn the IMAP connection, which some
  // providers throttle. (The connection fields that do trigger a reconnect are stripped for OAuth.)
  it.each(['microsoft', null])('does not reconnect the account (provider=%s)', async (p) => {
    provider = p;
    expect((await put({ notifications_enabled: false })).status).toBe(200);
    await tick();
    expect(imapManager.disconnectAccount).not.toHaveBeenCalled();
    expect(imapManager.connectAccount).not.toHaveBeenCalled();
  });
});
