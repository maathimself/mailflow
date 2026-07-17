import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '<shared@example.com>';

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

describe('GET /api/mail/resolve-message account scope', () => {
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

  it('scopes a durable Message-ID lookup to the requested owned account', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'current-row', account_id: ACCOUNT_ID }] });

    const url = new URL(`${base}/api/mail/resolve-message`);
    url.searchParams.set('ref', MESSAGE_ID);
    url.searchParams.set('accountId', ACCOUNT_ID);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.account_id = $3');
    expect(params).toEqual([MESSAGE_ID, 'user-1', ACCOUNT_ID]);
  });

  it('keeps unscoped deep-link resolution backward compatible', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'current-row', account_id: ACCOUNT_ID }] });

    const response = await fetch(`${base}/api/mail/resolve-message?ref=${encodeURIComponent(MESSAGE_ID)}`);

    expect(response.status).toBe(200);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([MESSAGE_ID, 'user-1', null]);
  });

  it('rejects a malformed account scope before querying', async () => {
    const response = await fetch(`${base}/api/mail/resolve-message?ref=${encodeURIComponent(MESSAGE_ID)}&accountId=not-a-uuid`);

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
