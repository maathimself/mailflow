import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// GET /messages/:id/reply-sender end-to-end — the HTTP-layer contract the pure
// resolveReplySender test (services/replySender.test.js) can't reach: route mounting,
// invalid-id validation, ownership 404 propagation, the rate limit, and the response
// shape. Matching precedence itself (delivered-to/wildcard/alias-skip/stale-sync) is
// exercised there against a mocked db, not re-derived here — this file mocks
// resolveReplySender directly and checks how the route wraps it.
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../services/replySender.js', () => ({ resolveReplySender: vi.fn() }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn().mockResolvedValue({ limited: false, resetMs: 0 }) }));

import express from 'express';
import { resolveReplySender } from '../services/replySender.js';
import { consume } from '../services/rateLimiter.js';
import mailRoutes from './mail.js';

const MESSAGE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  resolveReplySender.mockReset();
  consume.mockReset().mockResolvedValue({ limited: false, resetMs: 0 });
});

const getReplySender = (id) => fetch(`${base}/api/mail/messages/${id}/reply-sender`);

describe('GET /messages/:id/reply-sender', () => {
  it('rejects a non-UUID message id with 400 before touching the resolver', async () => {
    const res = await getReplySender('not-a-uuid');
    expect(res.status).toBe(400);
    expect(resolveReplySender).not.toHaveBeenCalled();
  });

  it('returns the resolved sender for a delivered-to hit', async () => {
    resolveReplySender.mockResolvedValue({ sender: { fromEmail: 'sales@example.com', name: 'Sales' } });

    const res = await getReplySender(MESSAGE_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sender: { fromEmail: 'sales@example.com', name: 'Sales' } });
    expect(resolveReplySender).toHaveBeenCalledWith({ messageId: MESSAGE_ID, userId: 'u1' });
  });

  it('returns a null sender on a miss — never an address list', async () => {
    resolveReplySender.mockResolvedValue({ sender: null });

    const res = await getReplySender(MESSAGE_ID);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ sender: null });
  });

  it('maps a resolver 404 (message not owned / not found) to a 404 response', async () => {
    resolveReplySender.mockRejectedValue(Object.assign(new Error('Message not found'), { status: 404 }));

    const res = await getReplySender(MESSAGE_ID);

    expect(res.status).toBe(404);
  });

  it('maps an unexpected resolver failure to a generic 500 (no internal detail leaked)', async () => {
    resolveReplySender.mockRejectedValue(new Error('db exploded: password=hunter2'));

    const res = await getReplySender(MESSAGE_ID);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('is rate-limited per user, with a Retry-After header on 429', async () => {
    consume.mockResolvedValue({ limited: true, resetMs: 5000 });

    const res = await getReplySender(MESSAGE_ID);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(resolveReplySender).not.toHaveBeenCalled();
    expect(consume.mock.calls[0][0]).toContain('u1');
  });
});
