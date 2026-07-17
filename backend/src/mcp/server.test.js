import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
import { query } from '../services/db.js';
import { hashToken } from './auth.js';
import { mountMcp } from './server.js';

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountMcp(app);
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

// Every authed request: token lookup -> last_used_at update -> resolveScope.
function primeAuth(userId = 'user-1', accountIds = ['acc-1']) {
  query
    .mockResolvedValueOnce({ rows: [{ id: 'tok', user_id: userId }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: accountIds.map((id) => ({ id })) });
}

async function rpc(method, params, { auth = true } = {}) {
  query.mockReset();
  if (auth) primeAuth();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (auth) headers.Authorization = 'Bearer mcp_good';
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res;
}

describe('/mcp transport', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await rpc('tools/list', {}, { auth: false });
    expect(res.status).toBe(401);
  });

  it('completes initialize', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"serverInfo"');
    expect(text).toContain('mailflow');
  });

  it('lists the ping tool', async () => {
    const res = await rpc('tools/list', {});
    const text = await res.text();
    expect(text).toContain('"ping"');
  });

  it('calls ping and returns pong', async () => {
    const res = await rpc('tools/call', { name: 'ping', arguments: {} });
    const text = await res.text();
    expect(text).toContain('{\\"pong\\":true}');
  });

  it('verifies the token by hash, not plaintext', async () => {
    await rpc('tools/list', {});
    expect(query.mock.calls[0][1]).toEqual([hashToken('mcp_good')]);
  });
});
