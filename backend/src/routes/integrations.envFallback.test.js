import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// integration_config rows by provider; system_settings is empty.
const db = vi.hoisted(() => ({ configs: new Map() }));
vi.mock('../services/db.js', () => ({
  query: vi.fn(async (sql, params = []) => {
    if (/FROM integration_config WHERE provider/.test(sql)) {
      return { rows: db.configs.has(params[0]) ? [{ config: db.configs.get(params[0]) }] : [] };
    }
    if (/SELECT provider, config FROM integration_config/.test(sql)) {
      return { rows: [...db.configs].map(([provider, config]) => ({ provider, config })) };
    }
    if (/INSERT INTO integration_config/.test(sql)) { db.configs.set(params[0], params[1]); return { rows: [] }; }
    if (/DELETE FROM integration_config/.test(sql)) { db.configs.delete(params[0]); return { rows: [] }; }
    if (/SELECT value FROM system_settings WHERE key/.test(sql)) return { rows: [] };
    if (/FROM email_accounts WHERE oauth_provider/.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  }),
}));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v, isEncrypted: () => true }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'admin-1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));

const KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI', 'MS_BUILTIN_APP',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
const savedEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
afterAll(() => {
  for (const k of KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

// What the compose files hand the backend (#676): every setting present, the ones left out of
// .env as empty strings.
const COMPOSE_ENV = {
  MS_CLIENT_ID: 'env-ms-id', MS_CLIENT_SECRET: '', MS_TENANT_ID: 'organizations', MS_REDIRECT_URI: '', MS_BUILTIN_APP: '',
  GOOGLE_CLIENT_ID: 'env-g-id', GOOGLE_CLIENT_SECRET: 'env-g-secret', GOOGLE_REDIRECT_URI: '',
};

// The router reads what .env gave it when it loads, so each test loads a fresh copy.
async function startRouter(env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { default: express } = await import('express');
  await import('express-async-errors');
  const { default: routes, loadIntegrationConfigs } = await import('./integrations.js');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await loadIntegrationConfigs();
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', routes);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/integrations`;
  return {
    base,
    close: () => new Promise(resolve => server.close(resolve)),
    status: async () => (await (await fetch(`${base}/status`)).json()),
    save: (provider, config) => fetch(`${base}/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }),
    remove: (provider) => fetch(`${base}/${provider}`, { method: 'DELETE' }),
  };
}

describe('OAuth settings from .env alongside Settings > Email providers (#676)', () => {
  beforeEach(() => { db.configs.clear(); });

  it('reports an empty setting as not set, exactly like a missing one', async () => {
    const empty = await startRouter(Object.fromEntries(KEYS.map(k => [k, ''])));
    const emptyStatus = await empty.status();
    await empty.close();
    const missing = await startRouter({});
    expect(await missing.status()).toEqual(emptyStatus);
    await missing.close();
    expect(emptyStatus.microsoft).toMatchObject({ configured: false, builtinApp: true, personalVia: 'shared', workAccounts: false });
    expect(emptyStatus.google).toEqual({ configured: false, signIn: false, envRedirectUri: false });
  });

  it('uses the .env values when nothing is stored', async () => {
    const r = await startRouter(COMPOSE_ENV);
    const { microsoft, google } = await r.status();
    expect(microsoft).toMatchObject({ configured: true, workAccounts: true, workRedirect: false, personalVia: 'shared' });
    expect(google).toEqual({ configured: true, signIn: false, envRedirectUri: false });
    await r.close();
  });

  it('stored values win field by field at startup, and an empty stored field keeps .env', async () => {
    db.configs.set('microsoft', { clientId: 'stored-ms-id', tenantId: '', clientSecret: 'stored-secret', redirectUri: 'https://m.example/oauth/microsoft/callback' });
    const r = await startRouter(COMPOSE_ENV);
    expect(process.env.MS_CLIENT_ID).toBe('stored-ms-id');
    expect(process.env.MS_TENANT_ID).toBe('organizations');
    expect((await r.status()).microsoft).toMatchObject({ configured: true, workRedirect: true });
    await r.close();
  });

  it('saving and removing in Settings falls back to .env, as a restart would', async () => {
    const r = await startRouter(COMPOSE_ENV);
    expect((await r.save('google', { clientId: 'stored-g-id', clientSecret: 'stored-g-secret', redirectUri: 'https://m.example/oauth/google/callback' })).status).toBe(200);
    expect(process.env.GOOGLE_CLIENT_ID).toBe('stored-g-id');
    expect((await r.status()).google).toEqual({ configured: true, signIn: true, envRedirectUri: false });

    // A field cleared in Settings goes back to .env.
    expect((await r.save('google', { clientId: 'stored-g-id', clientSecret: '', redirectUri: 'https://m.example/oauth/google/callback' })).status).toBe(200);
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('env-g-secret');
    expect((await r.status()).google).toEqual({ configured: true, signIn: true, envRedirectUri: false });

    expect((await r.remove('google')).status).toBe(200);
    expect(process.env.GOOGLE_CLIENT_ID).toBe('env-g-id');
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('env-g-secret');
    expect((await r.status()).google).toEqual({ configured: true, signIn: false, envRedirectUri: false });

    expect((await r.remove('microsoft')).status).toBe(200);
    expect(process.env.MS_CLIENT_ID).toBe('env-ms-id');
    await r.close();
  });

  it('a blank stored field keeps the .env value, as the routes read it', async () => {
    db.configs.set('microsoft', { clientId: 'stored-ms-id', tenantId: '  ' });
    await startRouter({ MS_TENANT_ID: 'organizations' }).then(r => r.close());
    expect(process.env.MS_TENANT_ID).toBe('organizations');
    expect(process.env.MS_CLIENT_ID).toBe('stored-ms-id');
  });

  // .env.example shipped GOOGLE_REDIRECT_URI=https://your-domain/oauth/google/callback
  // uncommented, and many .env files still carry it.
  describe('the old .env.example placeholder', () => {
    const OLD_ENV = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: 'https://your-domain/oauth/google/callback' };

    it('does not count as a redirect URI', async () => {
      const r = await startRouter({ ...OLD_ENV, GOOGLE_CLIENT_ID: 'env-g-id', GOOGLE_CLIENT_SECRET: 'env-g-secret' });
      expect((await r.status()).google).toEqual({ configured: true, signIn: false, envRedirectUri: false });
      await r.close();
    });

    it('cannot stand in for a redirect URI left out of Settings: the save is refused', async () => {
      const r = await startRouter(OLD_ENV);
      const res = await r.save('google', { clientId: 'g-id', clientSecret: 'g-secret', redirectUri: '' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'redirect_uri_required' });
      expect(db.configs.has('google')).toBe(false);
      expect((await r.status()).google).toEqual({ configured: false, signIn: false, envRedirectUri: false });
      const blank = await r.save('google', { clientId: 'g-id', clientSecret: 'g-secret', redirectUri: '   ' });
      expect(blank.status).toBe(400);
      await r.close();
    });

    it('a real redirect URI in .env lets Settings leave the field empty', async () => {
      const r = await startRouter({ GOOGLE_REDIRECT_URI: 'https://mail.example/oauth/google/callback' });
      expect((await r.status()).google.envRedirectUri).toBe(true);
      expect((await r.save('google', { clientId: 'g-id', clientSecret: 'g-secret', redirectUri: '' })).status).toBe(200);
      expect((await r.status()).google).toEqual({ configured: true, signIn: true, envRedirectUri: true });
      await r.close();
    });

    it('Microsoft saves without a redirect URI, for the device-code flow', async () => {
      const r = await startRouter({ MS_REDIRECT_URI: 'https://your-domain/oauth/microsoft/callback' });
      expect((await r.save('microsoft', { clientId: 'ms-id', tenantId: 'organizations', clientSecret: 's', redirectUri: '' })).status).toBe(200);
      expect((await r.status()).microsoft).toMatchObject({ configured: true, workAccounts: true, workRedirect: false });
      await r.close();
    });
  });
});
