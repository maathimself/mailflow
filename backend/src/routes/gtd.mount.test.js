import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// The gtd router pulls imapManager from the app entrypoint and query from the DB
// layer at import time; stub both so importing the real router never boots index.js
// or opens a pg pool. requireAuth is deliberately NOT mocked — this test exercises the
// real middleware to prove the mounting keeps it off the public probes.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: { broadcast: vi.fn() } }));

import express from 'express';
import gtdRoutes from './gtd.js';

// Mirrors index.js's route registration: the gtd router (whose router.use(requireAuth)
// guards its whole subtree) lives under /api/gtd, while /api/health and /api/version are
// unauthenticated and registered separately. Pins the regression where mounting the gtd
// router at bare /api let its auth guard 401 the health/version probes that the docker
// healthcheck hits.
function buildApp() {
  const app = express();
  app.use('/api/gtd', gtdRoutes);
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/version', (_req, res) => res.json({ version: 'test', sha: 'dev' }));
  return app;
}

describe('GTD route mounting vs unauthenticated probes', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise((resolve) => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves /api/health with 200 and no session', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('serves /api/version with 200 and no session', async () => {
    const res = await fetch(`${base}/api/version`);
    expect(res.status).toBe(200);
  });

  it('still guards /api/gtd/* behind auth (401 without a session)', async () => {
    const res = await fetch(`${base}/api/gtd/sections`);
    expect(res.status).toBe(401);
  });
});
