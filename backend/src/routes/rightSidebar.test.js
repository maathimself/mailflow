import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../services/rightSidebarSections.js', () => ({ getRightSidebarSections: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn().mockResolvedValue({ rows: [{ id: 'u1' }] }) }));

import express from 'express';
import { getRightSidebarSections } from '../services/rightSidebarSections.js';
import rightSidebarRoutes from './rightSidebar.js';

describe('right sidebar routes', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      if (req.headers.authorization === 'test') req.session = { userId: 'u1' };
      next();
    });
    app.use('/api/right-sidebar', rightSidebarRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('guards the endpoint behind authentication', async () => {
    const response = await fetch(`${base}/api/right-sidebar/sections`);
    expect(response.status).toBe(401);
  });

  it('rejects malformed account ids before querying', async () => {
    const response = await fetch(`${base}/api/right-sidebar/sections?accountId=nope`, {
      headers: { authorization: 'test' },
    });
    expect(response.status).toBe(400);
    expect(getRightSidebarSections).not.toHaveBeenCalled();
  });

  it('returns the caller-scoped section feed', async () => {
    getRightSidebarSections.mockResolvedValue({ sections: [] });
    const response = await fetch(`${base}/api/right-sidebar/sections?limit=5`, {
      headers: { authorization: 'test' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sections: [] });
    expect(getRightSidebarSections).toHaveBeenCalledWith({ userId: 'u1', accountId: null, limit: '5' });
  });
});
