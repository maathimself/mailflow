import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A small stand-in for the two tables the router touches: integration_config rows by
// provider, and system_settings rows by key.
const db = vi.hoisted(() => ({ configs: new Map(), settings: new Map() }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params = []) => {
    if (/FROM integration_config WHERE provider/.test(sql)) {
      return { rows: db.configs.has(params[0]) ? [{ config: db.configs.get(params[0]) }] : [] };
    }
    if (/SELECT provider, config(, updated_at)? FROM integration_config/.test(sql)) {
      return { rows: [...db.configs].map(([provider, config]) => ({ provider, config })) };
    }
    if (/INSERT INTO integration_config/.test(sql)) { db.configs.set(params[0], params[1]); return { rows: [] }; }
    if (/DELETE FROM integration_config/.test(sql)) { db.configs.delete(params[0]); return { rows: [] }; }
    if (/INSERT INTO system_settings/.test(sql)) { db.settings.set(params[0], params[1]); return { rows: [] }; }
    if (/SELECT value FROM system_settings WHERE key/.test(sql)) {
      return { rows: db.settings.has(params[0]) ? [{ value: db.settings.get(params[0]) }] : [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }),
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v, isEncrypted: () => true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'admin-1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
// A stand-in for MailFlow's registered app, so the tests never depend on the shipped ID.
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));

import 'express-async-errors';
import express from 'express';
import integrationsRoutes, { loadIntegrationConfigs } from './integrations.js';

const ENV_KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI', 'MS_BUILTIN_APP'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

// Personal accounts through MailFlow's built-in Microsoft app (#674): what the status
// endpoint reports, and the admin's opt-out from .env or Settings > Integrations.
describe('Microsoft built-in app status and opt-out', () => {
  let server;
  let base;

  beforeEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    db.configs.clear();
    db.settings.clear();
    const app = express();
    app.use(express.json());
    app.use('/api/integrations', integrationsRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/integrations`;
  });
  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const status = async () => (await (await fetch(`${base}/status`)).json()).microsoft;
  const saveApp = (config) => fetch(`${base}/microsoft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  const setBuiltin = (body) => fetch(`${base}/microsoft/builtin-app`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const removeApp = () => fetch(`${base}/microsoft`, { method: 'DELETE' });

  it('reports personal accounts available through the built-in app when no Client ID is set', async () => {
    expect(await status()).toEqual({ configured: false, builtinApp: true, builtinAppShipped: true, personalAccounts: true });
  });

  it('MS_BUILTIN_APP=false in .env withdraws it', async () => {
    process.env.MS_BUILTIN_APP = 'false';
    expect(await status()).toEqual({ configured: false, builtinApp: false, builtinAppShipped: true, personalAccounts: false });
  });

  // With its own app the instance signs personal accounts in through that app, which can
  // only do so if its tenant admits them.
  it.each([
    [undefined, true],
    ['common', true],
    ['consumers', true],
    ['Consumers', true],
    ['organizations', false],
    ['3f1c6c2e-0000-4000-8000-000000000001', false],
  ])('with an own app on tenant %s, personal accounts are %s', async (tenant, expected) => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    if (tenant !== undefined) process.env.MS_TENANT_ID = tenant;
    expect(await status()).toMatchObject({ configured: true, personalAccounts: expected });
  });

  it('turning the switch off survives removing the own app', async () => {
    expect((await saveApp({ clientId: 'own-app-id', tenantId: 'common' })).status).toBe(200);
    expect((await setBuiltin({ enabled: false })).status).toBe(200);
    expect((await removeApp()).status).toBe(200);

    expect(await status()).toEqual({ configured: false, builtinApp: false, builtinAppShipped: true, personalAccounts: false });
    expect(db.settings.get('ms_builtin_app')).toBe('false');
  });

  it('the switch overrides .env and turns the shared app back on', async () => {
    process.env.MS_BUILTIN_APP = 'false';
    expect((await setBuiltin({ enabled: true })).status).toBe(200);
    expect(await status()).toMatchObject({ builtinApp: true, personalAccounts: true });
  });

  it('rejects a switch value that is not a boolean', async () => {
    const res = await setBuiltin({ enabled: 'false' });
    expect(res.status).toBe(400);
    expect(db.settings.has('ms_builtin_app')).toBe(false);
  });

  it('a stored setting is applied at startup over .env, and without one .env stays in force', async () => {
    process.env.MS_BUILTIN_APP = 'false';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await loadIntegrationConfigs();
    expect(process.env.MS_BUILTIN_APP).toBe('false');

    db.settings.set('ms_builtin_app', 'true');
    await loadIntegrationConfigs();
    expect(process.env.MS_BUILTIN_APP).toBe('true');
  });
});
