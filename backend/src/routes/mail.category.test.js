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

const ID = '00000000-0000-4000-8000-000000000001';

describe('PATCH /api/mail/messages/:id/category (#489)', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  const patch = category => fetch(`${base}/api/mail/messages/${ID}/category`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category }),
  });

  it('stores a chosen Primary as primary, not as no category', async () => {
    // NULL means "not chosen": Recategorize and a re-sync fill it in, which moved a message the
    // user had put in Primary back to Newsletter.
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    const response = await patch('primary');
    expect(response.status).toBe(200);
    expect(query.mock.calls[0][1]).toEqual(['primary', ID, 'user-1']);
  });

  it('stores the other categories as before and rejects unknown ones', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    expect((await patch('automated')).status).toBe(200);
    expect(query.mock.calls[0][1][0]).toBe('automated');
    expect((await patch('spam')).status).toBe(400);
  });
});
