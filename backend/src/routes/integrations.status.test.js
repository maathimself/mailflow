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
      microsoft: { configured: true },
      google: { configured: false },
    });
  });

  it('reports configured=false when MS_CLIENT_ID is unset', async () => {
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      microsoft: { configured: false },
      google: { configured: false },
    });
  });

  it('reports google configured=true when GOOGLE_CLIENT_ID is set, independently of Microsoft', async () => {
    process.env.GOOGLE_CLIENT_ID = 'some-google-client-id';
    const res = await fetch(`${base}/api/integrations/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      microsoft: { configured: false },
      google: { configured: true },
    });
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
