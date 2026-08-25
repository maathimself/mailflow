import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/categorizer.js', () => ({
  invalidateSocialDomainCache: vi.fn(),
  backfillCategories: vi.fn(),
  aiClassifyMessage: vi.fn(),
  BUILTIN_SETS: {},
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn() }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));

import express from 'express';
import categoryRoutes from './categories.js';
import { query } from '../services/db.js';
import { aiClassifyMessage } from '../services/categorizer.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

describe('POST /api/mail/categories/ai-classify/:messageId integrity boundary', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', categoryRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    aiClassifyMessage.mockReset();
  });

  it('does not classify a deleted or metadata-incomplete row', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const response = await fetch(`${base}/api/mail/categories/ai-classify/${MESSAGE_ID}`, { method: 'POST' });

    expect(response.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/m\.is_deleted = false/);
    expect(query.mock.calls[0][0]).toMatch(/m\.metadata_complete = true/);
    expect(query.mock.calls[0][0]).toMatch(/JOIN folders live_folder/);
    expect(query.mock.calls[0][0]).toMatch(/live_folder\.is_present = true/);
    expect(query.mock.calls[0][0]).toMatch(/live_folder\.uid_validity IS NOT NULL/);
    expect(aiClassifyMessage).not.toHaveBeenCalled();
  });

  it('fails closed if the row becomes hidden before the category update', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ subject: 'Subject', from_email: 'sender@example.com', snippet: 'Snippet' }] })
      .mockResolvedValueOnce({ rows: [] });
    aiClassifyMessage.mockResolvedValueOnce('promotion');

    const response = await fetch(`${base}/api/mail/categories/ai-classify/${MESSAGE_ID}`, { method: 'POST' });

    expect(response.status).toBe(404);
    const updateSql = query.mock.calls[1][0];
    expect(updateSql).toMatch(/messages\.is_deleted = false/);
    expect(updateSql).toMatch(/messages\.metadata_complete = true/);
    expect(updateSql).toMatch(/RETURNING messages\.id/);
  });
});
