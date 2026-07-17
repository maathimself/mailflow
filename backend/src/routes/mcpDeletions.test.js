import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../mcp/engineAdapter.js', () => ({ executeDeletionBatch: vi.fn(), unstageDeletionBatch: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
import { executeDeletionBatch, unstageDeletionBatch } from '../mcp/engineAdapter.js';
import router from './mcpDeletions.js';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp-deletions', router);
  return app;
}
async function call(app, method, path) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + path, { method });
  const text = await res.text();
  server.close();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => { executeDeletionBatch.mockReset(); unstageDeletionBatch.mockReset(); });

describe('POST /api/mcp-deletions/:id/execute', () => {
  it('soft-deletes the owner batch and reports the count, scoped to the session user', async () => {
    executeDeletionBatch.mockResolvedValue(3);
    const { status, body } = await call(appWith(), 'POST', '/api/mcp-deletions/b1/execute');
    expect(status).toBe(200);
    expect(body).toEqual({ batch_id: 'b1', status: 'executed', deleted: 3 });
    expect(executeDeletionBatch).toHaveBeenCalledWith('b1', 'user-1');
  });

  it('404s a batch not owned / not found (cross-user isolation, no update)', async () => {
    executeDeletionBatch.mockResolvedValue(null);
    const { status } = await call(appWith(), 'POST', '/api/mcp-deletions/other/execute');
    expect(status).toBe(404);
  });
});

describe('DELETE /api/mcp-deletions/:id', () => {
  it('unstages only the owner batch', async () => {
    unstageDeletionBatch.mockResolvedValue(true);
    const { status } = await call(appWith(), 'DELETE', '/api/mcp-deletions/b1');
    expect(status).toBe(204);
    expect(unstageDeletionBatch).toHaveBeenCalledWith('b1', 'user-1');
  });

  it('404s when absent or not owned', async () => {
    unstageDeletionBatch.mockResolvedValue(false);
    const { status } = await call(appWith(), 'DELETE', '/api/mcp-deletions/nope');
    expect(status).toBe(404);
  });
});
