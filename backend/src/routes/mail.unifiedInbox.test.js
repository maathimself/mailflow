import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

describe('GET /api/mail/unread-counts unified total', () => {
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

  it('keeps per-account counts but omits opted-out accounts from the unified total', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { account_id: 'included', count: '2', include_in_unified_inbox: true },
        { account_id: 'excluded', count: '5', include_in_unified_inbox: false },
      ],
    });

    const response = await fetch(`${base}/api/mail/unread-counts`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      total: 2,
      byAccount: { included: 2, excluded: 5 },
    });
  });

  it('uses only opted-in accounts for unified category counts', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ category: 'primary', unread_count: 2 }],
      });

    const response = await fetch(`${base}/api/mail/category-counts`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1]).toEqual([['included']]);
  });

  it('uses only opted-in accounts when expanding a unified thread', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 'included', include_in_unified_inbox: true },
          { id: 'excluded', include_in_unified_inbox: false },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/mail/thread/thread-1?unified=true`);

    expect(response.status).toBe(200);
    expect(query.mock.calls[1][1][0]).toEqual(['included']);
  });
});
