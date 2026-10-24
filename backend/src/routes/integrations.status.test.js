import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

// The /status capability endpoint (#315) must be reachable by any authenticated user,
// NOT just admins: a non-admin needs to learn that Microsoft OAuth is configured so the
// connect buttons enable, without ever seeing the credentials. These tests mount the real
// integrations router with a requireAdmin stub that ALWAYS rejects, proving /status does
// not sit behind the admin gate while GET / still does. db/encryption are stubbed since the
// status route touches neither.
import { vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
// These cases describe an instance without the shared app; the shipped app is covered in
// integrations.builtinApp.test.js (#674).
vi.mock('../services/microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: '00000000-0000-0000-0000-000000000000' }));
vi.mock('../services/encryption.js', () => ({
  encrypt: (v) => v,
  decrypt: (v) => v,
  isEncrypted: () => false,
}));
vi.mock('../middleware/auth.js', () => ({
  // Authenticated, but deliberately NOT an admin — requireAdmin always 403s here.
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
  requireAdmin: (_req, res) => res.status(403).json({ error: 'Admin access required' }),
}));

import 'express-async-errors';
import express from 'express';
import integrationsRoutes from './integrations.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', integrationsRoutes);
  app.use((err, _req, res, next) => { void err; void next; res.status(500).json({ error: 'Internal server error' }); });
  return app;
}

let server;
let base;
const savedClientId = process.env.MS_CLIENT_ID;
const savedGoogleClientId = process.env.GOOGLE_CLIENT_ID;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (savedClientId === undefined) delete process.env.MS_CLIENT_ID;
  else process.env.MS_CLIENT_ID = savedClientId;
  if (savedGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = savedGoogleClientId;
});

afterEach(() => {
  delete process.env.MS_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
});

describe('GET /api/integrations/status (non-admin capability check)', () => {
  it('is reachable by a non-admin (not behind requireAdmin) and reports configured=true when MS_CLIENT_ID is set', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      microsoft: { configured: true, builtinApp: false, builtinAppShipped: false, personalAccounts: true, personalVia: 'own', workAccounts: true, workRedirect: false, personalRedirect: false },
      google: { configured: false, signIn: false },
    });
  });

  // This build still carries the built-in app's placeholder ID (#674), so nothing changes
  // for personal accounts either.
  it('reports configured=false when MS_CLIENT_ID is unset', async () => {
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      microsoft: { configured: false, builtinApp: false, builtinAppShipped: false, personalAccounts: false, personalVia: null, workAccounts: false, workRedirect: false, personalRedirect: false },
      google: { configured: false, signIn: false },
    });
  });

  it('reports google configured=true when GOOGLE_CLIENT_ID is set, independently of Microsoft', async () => {
    process.env.GOOGLE_CLIENT_ID = 'some-google-client-id';
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      microsoft: { configured: false, builtinApp: false, builtinAppShipped: false, personalAccounts: false, personalVia: null, workAccounts: false, workRedirect: false, personalRedirect: false },
      google: { configured: true, signIn: false },
    });
  });

  it('reports personal accounts unavailable for an own app on the organizations tenant (#674)', async () => {
    process.env.MS_CLIENT_ID = 'some-client-id';
    process.env.MS_TENANT_ID = 'organizations';
    try {
      const res = await fetch(`${base}/api/integrations/status`);
      expect((await res.json()).microsoft).toEqual({ configured: true, builtinApp: false, builtinAppShipped: false, personalAccounts: false, personalVia: null, workAccounts: true, workRedirect: false, personalRedirect: false });
    } finally {
      delete process.env.MS_TENANT_ID;
    }
  });

  // Work accounts need an own app that is not limited to personal accounts; the redirect
  // sign-in also needs its secret and redirect URI (#674).
  it.each([
    [{ MS_CLIENT_ID: 'id', MS_TENANT_ID: 'consumers' }, { workAccounts: false, workRedirect: false }],
    [{ MS_CLIENT_ID: 'id', MS_TENANT_ID: 'contoso.example' }, { workAccounts: true, workRedirect: false }],
    [{ MS_CLIENT_ID: 'id', MS_CLIENT_SECRET: 's', MS_REDIRECT_URI: 'https://mail.example/oauth/microsoft/callback' }, { workAccounts: true, workRedirect: true }],
  ])('reports work accounts for %o as %o', async (env, expected) => {
    Object.assign(process.env, env);
    try {
      const res = await fetch(`${base}/api/integrations/status`);
      expect((await res.json()).microsoft).toMatchObject(expected);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  // Add account offers Google sign-in only when the whole client is configured (#674).
  it('reports Google sign-in only with client ID, secret and redirect URI', async () => {
    Object.assign(process.env, { GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' });
    try {
      expect((await (await fetch(`${base}/api/integrations/status`)).json()).google).toEqual({ configured: true, signIn: false });
      process.env.GOOGLE_REDIRECT_URI = 'https://mail.example/oauth/google/callback';
      expect((await (await fetch(`${base}/api/integrations/status`)).json()).google).toEqual({ configured: true, signIn: true });
    } finally {
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REDIRECT_URI;
    }
  });

  // An own app that signs personal accounts in with a secret and redirect URI offers its page to
  // them too: it may not allow the device code (#674).
  it.each([
    [{ MS_CLIENT_ID: 'id', MS_TENANT_ID: 'common', MS_CLIENT_SECRET: 's', MS_REDIRECT_URI: 'https://m.example/cb' }, { personalRedirect: true, workRedirect: true }],
    [{ MS_CLIENT_ID: 'id', MS_TENANT_ID: 'consumers', MS_CLIENT_SECRET: 's', MS_REDIRECT_URI: 'https://m.example/cb' }, { personalRedirect: true, workRedirect: false }],
    [{ MS_CLIENT_ID: 'id', MS_TENANT_ID: 'organizations', MS_CLIENT_SECRET: 's', MS_REDIRECT_URI: 'https://m.example/cb' }, { personalRedirect: false, workRedirect: true }],
    [{ MS_CLIENT_ID: 'id', MS_TENANT_ID: 'common' }, { personalRedirect: false, workRedirect: false }],
  ])('reports the redirect for personal accounts for %o as %o', async (env, expected) => {
    Object.assign(process.env, env);
    try {
      expect((await (await fetch(`${base}/api/integrations/status`)).json()).microsoft).toMatchObject(expected);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it('never leaks credentials in the response', async () => {
    process.env.MS_CLIENT_ID = 'super-secret-client-id';
    const res = await fetch(`${base}/api/integrations/status`);
    const body = await res.text();
    expect(body).not.toContain('super-secret-client-id');
  });
});

describe('GET /api/integrations (config read) stays admin-only', () => {
  it('is rejected with 403 for a non-admin', async () => {
    const res = await fetch(`${base}/api/integrations`);
    expect(res.status).toBe(403);
  });
});
