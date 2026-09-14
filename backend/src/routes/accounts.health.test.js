import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: vi.fn(async () => []) } }));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';

const ROW = {
  id: 'a1', name: 'Mailbox', email_address: 'box@gmail.com', protocol: 'imap',
  oauth_provider: 'google', oauth_reconnect_required: false, enabled: true,
  sync_error: null, signature: null,
};

describe('GET /api/accounts health', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use('/api/accounts', accountRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  async function list(rows) {
    query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] });
    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    return res.json();
  }

  it('adds a stable health code to every account', async () => {
    const recent = new Date(Date.now() - 60 * 1000);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const accounts = await list([
      { ...ROW, id: 'healthy', last_sync: recent },
      { ...ROW, id: 'stale', last_sync: old },
      { ...ROW, id: 'failed', last_sync: recent, sync_error: 'Connection refused' },
      { ...ROW, id: 'reconnect', last_sync: recent, oauth_reconnect_required: true, sync_error: 'oauth_reconnect_required' },
      { ...ROW, id: 'disabled', last_sync: null, enabled: false },
    ]);
    expect(Object.fromEntries(accounts.map(a => [a.id, a.health]))).toEqual({
      healthy: 'healthy',
      stale: 'stale',
      failed: 'failed',
      reconnect: 'oauth_reconnect_required',
      disabled: 'disabled',
    });
  });

  it('adds only the health code and keeps sync_error as the sole error text', async () => {
    const row = { ...ROW, last_sync: new Date(), sync_error: 'Connection refused' };
    const [account] = await list([row]);
    expect(Object.keys(account).sort()).toEqual([...Object.keys(row), 'aliases', 'health'].sort());
    expect(account.sync_error).toBe('Connection refused');
    expect(account.health).toBe('failed');
  });

  it('still never selects token or password columns', async () => {
    await list([{ ...ROW, last_sync: new Date() }]);
    const listSql = query.mock.calls[0][0];
    expect(listSql).toMatch(/\blast_sync\b/);
    expect(listSql).toMatch(/\bsync_error\b/);
    expect(listSql).toMatch(/\benabled\b/);
    expect(listSql).not.toMatch(/oauth_access_token|oauth_refresh_token|auth_pass|\*/);
  });
});
