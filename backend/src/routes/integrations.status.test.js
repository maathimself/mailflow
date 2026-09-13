import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

// The /status capability endpoint (#315) must be reachable by any authenticated user,
// NOT just admins: a non-admin needs to learn that Microsoft OAuth is configured so the
// connect buttons enable, without ever seeing the credentials. These tests mount the real
// integrations router with a requireAdmin stub that ALWAYS rejects, proving /status does
// not sit behind the admin gate while GET / still does. db/encryption are stubbed since the
// status route touches neither.
import { vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => `enc:${v}`,
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
  isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:'),
}));
// Authenticated, but NOT an admin by default — requireAdmin 403s unless a test opts in.
const authState = vi.hoisted(() => ({ admin: false }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
  requireAdmin: (_req, res, next) => (authState.admin ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

import express from 'express';
import integrationsRoutes, { loadIntegrationConfigs } from './integrations.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationsRoutes);
  app.use((err, _req, res, next) => { void err; void next; res.status(500).json({ error: 'Internal server error' }); });
  return app;
}

let server;
let base;
const GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
const savedEnv = Object.fromEntries(['MS_CLIENT_ID', ...GOOGLE_VARS].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterEach(() => {
  delete process.env.MS_CLIENT_ID;
  for (const k of GOOGLE_VARS) delete process.env[k];
  authState.admin = false;
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [] }));
});

describe('GET /api/integrations/status (non-admin capability check)', () => {
  it('is reachable by a non-admin (not behind requireAdmin) and reports configured=true when MS_CLIENT_ID is set', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ microsoft: { configured: true }, google: { configured: false } });
  });

  it('reports configured=false when MS_CLIENT_ID is unset', async () => {
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ microsoft: { configured: false }, google: { configured: false } });
  });

  it('never leaks credentials in the response', async () => {
    process.env.MS_CLIENT_ID = 'super-secret-client-id';
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
    const res = await fetch(`${base}/api/integrations/status`);
    const body = await res.text();
    expect(body).not.toContain('super-secret-client-id');
    expect(body).not.toContain('google-client-id');
    expect(body).not.toContain('google-client-secret');
    expect(body).not.toContain('mail.example.com');
  });

  it('reports google configured only when client id, secret and redirect uri are all set', async () => {
    process.env.GOOGLE_CLIENT_ID = 'gid';
    process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
    let res = await fetch(`${base}/api/integrations/status`);
    expect((await res.json()).google).toEqual({ configured: false });

    process.env.GOOGLE_REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
    res = await fetch(`${base}/api/integrations/status`);
    expect((await res.json()).google).toEqual({ configured: true });
  });
});

describe('GET /api/integrations (config read) stays admin-only', () => {
  it('is rejected with 403 for a non-admin', async () => {
    const res = await fetch(`${base}/api/integrations`);
    expect(res.status).toBe(403);
  });
});


describe('Google integration config (admin)', () => {
  const post = (body) => fetch(`${base}/api/integrations/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects non-admin writes', async () => {
    const res = await post({ clientId: 'gid', clientSecret: 's', redirectUri: 'https://x/cb' });
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('saves only the known fields, encrypts the secret at rest and applies env vars', async () => {
    authState.admin = true;
    const res = await post({ clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'https://mail.example.com/oauth/google/callback', tenantId: 'ignored' });
    expect(res.status).toBe(200);

    const [sql, params] = query.mock.calls.find(([q]) => /INSERT INTO integration_config/.test(q));
    expect(sql).toMatch(/ON CONFLICT \(provider\)/);
    expect(params).toEqual(['google', { clientId: 'gid', clientSecret: 'enc:gsecret', redirectUri: 'https://mail.example.com/oauth/google/callback' }]);
    expect(process.env.GOOGLE_CLIENT_ID).toBe('gid');
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('gsecret');
    expect(process.env.GOOGLE_REDIRECT_URI).toBe('https://mail.example.com/oauth/google/callback');
  });

  it('keeps the stored secret when the redacted placeholder is posted', async () => {
    authState.admin = true;
    query.mockImplementation(async (sql) => (/SELECT config FROM integration_config/.test(sql)
      ? { rows: [{ config: { clientId: 'old', clientSecret: 'enc:stored-secret', redirectUri: 'https://old/cb' } }] }
      : { rows: [] }));

    const res = await post({ clientId: 'gid2', clientSecret: '••••••••', redirectUri: 'https://new/cb' });
    expect(res.status).toBe(200);
    const [, params] = query.mock.calls.find(([q]) => /INSERT INTO integration_config/.test(q));
    expect(params[1]).toEqual({ clientId: 'gid2', clientSecret: 'enc:stored-secret', redirectUri: 'https://new/cb' });
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('stored-secret');
  });

  it('clears env vars for fields removed from the saved config', async () => {
    authState.admin = true;
    process.env.GOOGLE_REDIRECT_URI = 'https://stale/cb';
    const res = await post({ clientId: 'gid', clientSecret: 'gsecret', redirectUri: '' });
    expect(res.status).toBe(200);
    expect(process.env.GOOGLE_REDIRECT_URI).toBeUndefined();
    const status = await fetch(`${base}/api/integrations/status`);
    expect((await status.json()).google).toEqual({ configured: false });
  });

  it('returns the google config with the secret redacted', async () => {
    authState.admin = true;
    const updatedAt = '2026-09-14T00:00:00.000Z';
    query.mockResolvedValue({ rows: [{ provider: 'google', config: { clientId: 'gid', clientSecret: 'enc:real-secret', redirectUri: 'https://x/cb' }, updated_at: updatedAt }] });

    const res = await fetch(`${base}/api/integrations`);
    const text = await res.text();
    expect(text).not.toContain('real-secret');
    expect(JSON.parse(text).google).toEqual({ clientId: 'gid', clientSecret: '••••••••', redirectUri: 'https://x/cb', updated_at: updatedAt });
  });

  it('deletes the config and clears the env vars', async () => {
    authState.admin = true;
    process.env.GOOGLE_CLIENT_ID = 'gid';
    process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
    process.env.GOOGLE_REDIRECT_URI = 'https://x/cb';

    const res = await fetch(`${base}/api/integrations/google`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(query.mock.calls[0]).toEqual(['DELETE FROM integration_config WHERE provider = $1', ['google']]);
    for (const k of GOOGLE_VARS) expect(process.env[k]).toBeUndefined();
  });

  it('loads the google config into env vars on startup', async () => {
    query.mockResolvedValue({ rows: [{ provider: 'google', config: { clientId: 'gid', clientSecret: 'enc:loaded-secret', redirectUri: 'https://x/cb' } }] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await loadIntegrationConfigs();
    logSpy.mockRestore();
    expect(process.env.GOOGLE_CLIENT_ID).toBe('gid');
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe('loaded-secret');
    expect(process.env.GOOGLE_REDIRECT_URI).toBe('https://x/cb');
  });
});
