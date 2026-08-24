import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
    allowNonstandardPorts: false,
  }),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

describe('PUT /api/accounts/:id unified inbox preference', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
  });

  it('persists and returns an opt-out without reconnecting the account', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: '44444444-4444-4444-4444-444444444444', gtd_folders: {} }] })
      .mockResolvedValueOnce({
        rows: [{
          id: '44444444-4444-4444-4444-444444444444',
          include_in_unified_inbox: false,
          enabled: true,
          protocol: 'imap',
        }],
      });

    const response = await fetch(`${base}/api/accounts/44444444-4444-4444-4444-444444444444`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_in_unified_inbox: false }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).include_in_unified_inbox).toBe(false);
    expect(query.mock.calls[1][0]).toContain('include_in_unified_inbox = $1');
    expect(query.mock.calls[1][1]).toEqual([false, '44444444-4444-4444-4444-444444444444']);
  });

  it('rejects a malformed account id with 400 before touching the DB (not a 500)', async () => {
    const response = await fetch(`${base}/api/accounts/not-a-uuid`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_in_unified_inbox: false }),
    });
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
