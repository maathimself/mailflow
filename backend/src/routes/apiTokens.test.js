import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
// Stub auth to inject a fixed session user.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
import { query } from '../services/db.js';
import router from './apiTokens.js';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/tokens', router);
  return app;
}
async function call(app, method, path, body) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => query.mockReset());

describe('POST /api/tokens', () => {
  it('mints a token, returns the plaintext once, and stores only the hash', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'tok-1', name: 'laptop' }] });
    const { status, body } = await call(appWith(), 'POST', '/api/tokens', { name: 'laptop' });
    expect(status).toBe(201);
    expect(body.token).toMatch(/^mcp_/);
    expect(body).toMatchObject({ id: 'tok-1', name: 'laptop' });
    // INSERT bound values: [user_id, token_hash, name] — never the plaintext.
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe('user-1');
    expect(params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[2]).toBe('laptop');
    expect(params).not.toContain(body.token);
  });
  it('rejects a missing name', async () => {
    const { status } = await call(appWith(), 'POST', '/api/tokens', {});
    expect(status).toBe(400);
  });
});

describe('GET /api/tokens', () => {
  it('lists tokens without hashes or plaintext', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'tok-1', name: 'laptop', created_at: 't', last_used_at: null }] });
    const { status, body } = await call(appWith(), 'GET', '/api/tokens');
    expect(status).toBe(200);
    expect(body.tokens[0]).toEqual({ id: 'tok-1', name: 'laptop', created_at: 't', last_used_at: null });
    expect(JSON.stringify(body)).not.toContain('token_hash');
  });
});

describe('DELETE /api/tokens/:id', () => {
  it('revokes only within the session user', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { status } = await call(appWith(), 'DELETE', '/api/tokens/tok-1');
    expect(status).toBe(204);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM api_tokens WHERE id = \$1 AND user_id = \$2/),
      ['tok-1', 'user-1'],
    );
  });
  it('404s when the token is absent or not owned', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const { status } = await call(appWith(), 'DELETE', '/api/tokens/nope');
    expect(status).toBe(404);
  });
});
