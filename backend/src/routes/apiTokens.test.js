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

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function callRoute(method, { body = {}, params = {} } = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === '/' && entry.route.methods[method]);
  const req = { body, params, session: { userId: 'user-1' } };
  const res = mockRes();
  await layer.route.stack[0].handle(req, res);
  return { status: res.statusCode, body: res.body };
}

beforeEach(() => query.mockReset());

describe('POST /api/tokens', () => {
  it('defaults a token with no requested scopes to read', async () => {
    for (const scopes of [undefined, []]) {
      query.mockResolvedValueOnce({
        rows: [{ id: 'tok-1', name: 'laptop', scopes: ['read'] }],
      });
      const { status, body } = await callRoute('post', { body: { name: 'laptop', scopes } });
      expect(status).toBe(201);
      expect(body.scopes).toEqual(['read']);
      expect(query.mock.calls.at(-1)[0]).toMatch(/api_tokens \(user_id, token_hash, name, scopes\)/);
      expect(query.mock.calls.at(-1)[1][3]).toEqual(['read']);
    }
  });

  it('rejects unknown requested scopes', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 'tok-1', name: 'laptop', scopes: ['read', 'admin'] }],
    });
    const { status, body } = await callRoute('post', {
      body: { name: 'laptop', scopes: ['read', 'admin'] },
    });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'unknown scope(s): admin' });
    expect(query).not.toHaveBeenCalled();
  });

  it('mints a token with expanded requested scopes', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 'tok-2', name: 'sender', scopes: ['send', 'read'] }],
    });
    const { status, body } = await callRoute('post', {
      body: { name: 'sender', scopes: ['send'] },
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      id: 'tok-2',
      name: 'sender',
      scopes: ['send', 'read'],
    });
    expect(body.token).toMatch(/^mcp_/);
    expect(query.mock.calls[0][1][3]).toEqual(['send', 'read']);
    expect(query.mock.calls[0][1]).not.toContain(body.token);
  });

  it('mints a token, returns the plaintext once, and stores only the hash', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'tok-1', name: 'laptop', scopes: ['read'] }] });
    const { status, body } = await call(appWith(), 'POST', '/api/tokens', { name: 'laptop' });
    expect(status).toBe(201);
    expect(body.token).toMatch(/^mcp_/);
    expect(body).toMatchObject({ id: 'tok-1', name: 'laptop' });
    // INSERT bound values: [user_id, token_hash, name, scopes] — never the plaintext.
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
  it('selects and returns each token scopes', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'tok-1',
        name: 'laptop',
        scopes: ['read', 'write'],
        created_at: 't',
        last_used_at: null,
      }],
    });
    const { status, body } = await callRoute('get');
    expect(status).toBe(200);
    expect(body.tokens[0].scopes).toEqual(['read', 'write']);
    expect(query.mock.calls[0][0]).toMatch(/SELECT id, name, scopes, created_at, last_used_at/);
  });

  it('lists tokens without hashes or plaintext', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'tok-1', name: 'laptop', scopes: ['read'], created_at: 't', last_used_at: null }] });
    const { status, body } = await call(appWith(), 'GET', '/api/tokens');
    expect(status).toBe(200);
    expect(body.tokens[0]).toEqual({ id: 'tok-1', name: 'laptop', scopes: ['read'], created_at: 't', last_used_at: null });
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
