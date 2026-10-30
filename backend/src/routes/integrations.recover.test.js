import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ accounts: [] }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params = []) => {
    if (/FROM email_accounts WHERE oauth_provider = \$1/.test(sql)) return { rows: db.accounts.filter(a => a.oauth_provider === params[0]) };
    return { rows: [] };
  }),
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v, isEncrypted: () => true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'admin-1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));

import 'express-async-errors';
import express from 'express';
import integrationsRoutes from './integrations.js';
import { noteRefreshFailure, refreshFailureFor, clearRefreshFailure } from '../services/accountErrorCode.js';

// An expired or rotated secret, a disabled app: the admin fixes it under Email providers, and
// that provider's accounts recover then, not after a backoff that may be hours long (#674).
describe('changing a provider app resets its accounts', () => {
  let server;
  let base;
  const engine = { clearConnectCooldown: vi.fn(), connectAccount: vi.fn(async () => true) };
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.set('imapManager', engine);
    app.use('/api/integrations', integrationsRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/integrations`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const k of ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_BUILTIN_APP']) delete process.env[k];
  });
  beforeEach(() => {
    engine.clearConnectCooldown.mockClear();
    engine.connectAccount.mockClear();
    db.accounts = [
      { id: 'm-broken', oauth_provider: 'microsoft', enabled: true, sync_error: 'AADSTS7000222: expired' },
      { id: 'm-fine', oauth_provider: 'microsoft', enabled: true, sync_error: null },
      { id: 'm-off', oauth_provider: 'microsoft', enabled: false, sync_error: 'x' },
      { id: 'g-broken', oauth_provider: 'google', enabled: true, sync_error: 'x' },
    ];
    for (const a of db.accounts) noteRefreshFailure(a.id, { code: 'oauth_app_config', detail: 'x' });
  });
  const settle = () => new Promise(r => setTimeout(r, 20));

  it.each([
    ['saving the app', () => fetch(`${base}/microsoft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'id', tenantId: 'common', clientSecret: 'new' }) })],
    ['removing it', () => fetch(`${base}/microsoft`, { method: 'DELETE' })],
    ['switching the shared app', () => fetch(`${base}/microsoft/builtin-app`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })],
  ])('%s forgets refresh failures and backoffs and reconnects the broken accounts', async (_label, act) => {
    expect((await act()).status).toBe(200);
    await settle();
    for (const id of ['m-broken', 'm-fine', 'm-off']) {
      expect(refreshFailureFor(id)).toBeNull();
      expect(engine.clearConnectCooldown).toHaveBeenCalledWith(id);
    }
    expect(engine.connectAccount.mock.calls.map(([a]) => a.id)).toEqual(['m-broken']);
    // Another provider's accounts are left alone.
    expect(refreshFailureFor('g-broken')).not.toBeNull();
    clearRefreshFailure('g-broken');
  });
});
