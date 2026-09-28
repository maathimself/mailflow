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
import accountRoutes, { ACCOUNT_UPDATE_FIELDS } from './accounts.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountRoutes);
  return app;
}

// Write-only credentials: the form sends them only when the user types a new one.
const WRITE_ONLY = new Set(['auth_pass', 'smtp_auth_pass']);

describe('GET /api/accounts columns', () => {
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

  // The settings form is filled from GET and sends fields like trusted_authserv_id back on every
  // save. A column PUT can write but GET does not return goes back as empty, clearing it.
  it('selects every non-secret column that PUT can write', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/accounts`);
    expect(response.status).toBe(200);

    const sql = query.mock.calls[0][0];
    const selected = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+email_accounts/i)[1]
      .split(',')
      .map(c => c.trim());
    const missing = ACCOUNT_UPDATE_FIELDS.filter(f => !WRITE_ONLY.has(f) && !selected.includes(f));
    expect(missing).toEqual([]);
  });
});
