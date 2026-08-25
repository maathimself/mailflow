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
    expect(query.mock.calls[0][0]).toContain('m.metadata_complete = true');
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
    expect(query.mock.calls[1][0]).toContain('m.metadata_complete = true');
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
    expect(query.mock.calls[1][0]).toContain('m.metadata_complete = true');
  });

  it('hides an unverified row from the direct message endpoint', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/mail/messages/11111111-1111-4111-8111-111111111111`);
    expect(response.status).toBe(404);
    expect(query.mock.calls[0][0]).toContain('m.metadata_complete = true');
  });

  it.each([
    ['single attachment', '/attachments/2'],
    ['attachment ZIP', '/attachments.zip'],
  ])('hides an incomplete or deleted row from the %s endpoint', async (_name, suffix) => {
    query.mockResolvedValueOnce({ rows: [] });
    const response = await fetch(
      `${base}/api/mail/messages/11111111-1111-4111-8111-111111111111${suffix}`
    );

    expect(response.status).toBe(404);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('m.is_deleted = false');
    expect(sql).toContain('m.metadata_complete = true');
  });
});
