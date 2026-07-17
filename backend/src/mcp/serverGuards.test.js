import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
import { query } from '../services/db.js';
import {
  buildAllowedOrigins, mcpOriginGuard, countToolCalls, createMcpRateLimiter, mountMcp,
} from './server.js';

function mockReq({ origin, body, tokenId } = {}) {
  return {
    get: (h) => (h.toLowerCase() === 'origin' ? origin : undefined),
    body,
    mcpTokenId: tokenId,
  };
}

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('buildAllowedOrigins', () => {
  it('derives normalized origins from APP_URL, FRONTEND_URL, and MCP_ALLOWED_ORIGINS', () => {
    const allowed = buildAllowedOrigins({
      APP_URL: 'https://Mail.Example.com/', // trailing slash + case normalize away
      FRONTEND_URL: 'http://localhost:5173',
      MCP_ALLOWED_ORIGINS: 'https://lan-host:8087, http://mail.internal',
    });
    expect(allowed).toEqual(new Set([
      'https://mail.example.com',
      'http://localhost:5173',
      'https://lan-host:8087',
      'http://mail.internal',
    ]));
  });

  it('skips malformed and empty entries instead of throwing', () => {
    const allowed = buildAllowedOrigins({ APP_URL: 'not a url', MCP_ALLOWED_ORIGINS: ' ,, ' });
    expect(allowed.size).toBe(0);
  });
});

describe('mcpOriginGuard', () => {
  const guard = mcpOriginGuard(buildAllowedOrigins({ APP_URL: 'https://mail.example.com' }));

  it('passes requests with no Origin header (non-browser MCP clients)', () => {
    const next = vi.fn();
    guard(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes an allowlisted Origin', () => {
    const next = vi.fn();
    guard(mockReq({ origin: 'https://mail.example.com' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('normalizes Origin casing before comparing', () => {
    const next = vi.fn();
    guard(mockReq({ origin: 'HTTPS://MAIL.EXAMPLE.COM' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes localhost variants on any port', () => {
    for (const origin of ['http://localhost:8087', 'http://127.0.0.1:3000', 'http://[::1]:8087', 'https://localhost']) {
      const next = vi.fn();
      guard(mockReq({ origin }), mockRes(), next);
      expect(next, origin).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects a non-allowlisted Origin with a 403 JSON-RPC error', () => {
    const next = vi.fn();
    const res = mockRes();
    guard(mockReq({ origin: 'http://evil.example' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Origin not allowed: http://evil.example' },
      id: null,
    });
  });

  it('rejects an attacker hostname that merely resolves to this host (DNS rebinding)', () => {
    const res = mockRes();
    guard(mockReq({ origin: 'http://rebind.attacker.net:8087' }), res, vi.fn());
    expect(res.statusCode).toBe(403);
  });

  it('rejects unparseable Origins, including the literal "null"', () => {
    for (const origin of ['null', 'not a url']) {
      const res = mockRes();
      guard(mockReq({ origin }), res, vi.fn());
      expect(res.statusCode, origin).toBe(403);
    }
  });
});

describe('countToolCalls', () => {
  it('counts a single tools/call body as 1 and other methods as 0', () => {
    expect(countToolCalls({ jsonrpc: '2.0', method: 'tools/call', id: 1 })).toBe(1);
    expect(countToolCalls({ jsonrpc: '2.0', method: 'initialize', id: 1 })).toBe(0);
    expect(countToolCalls({ jsonrpc: '2.0', method: 'tools/list', id: 1 })).toBe(0);
    expect(countToolCalls(undefined)).toBe(0);
  });

  it('counts tools/call entries inside a batch array', () => {
    expect(countToolCalls([
      { method: 'tools/call' }, { method: 'notifications/initialized' }, { method: 'tools/call' },
    ])).toBe(2);
  });
});

describe('createMcpRateLimiter', () => {
  let clock;
  const now = () => clock;
  const call = (id = 1) => ({ jsonrpc: '2.0', method: 'tools/call', id });

  beforeEach(() => { clock = 1_000_000; });

  it('allows up to the limit then 429s with Retry-After and a JSON-RPC error', () => {
    const limiter = createMcpRateLimiter({ limit: 2, now });
    for (let i = 0; i < 2; i++) {
      const next = vi.fn();
      limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    const res = mockRes();
    const next = vi.fn();
    limiter(mockReq({ body: call(42), tokenId: 'tok-1' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe(60);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error.code).toBe(-32000);
    expect(res.body.error.message).toMatch(/rate limit/i);
    expect(res.body.id).toBe(42); // correlates with the throttled request
  });

  it('keys buckets per token, not globally', () => {
    const limiter = createMcpRateLimiter({ limit: 1, now });
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), vi.fn());
    const next = vi.fn();
    limiter(mockReq({ body: call(), tokenId: 'tok-2' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1); // a different token has its own budget
  });

  it('never throttles the initialize/tools-list handshake', () => {
    const limiter = createMcpRateLimiter({ limit: 1, now });
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']) {
      const next = vi.fn();
      limiter(mockReq({ body: { jsonrpc: '2.0', method, id: 1 }, tokenId: 'tok-1' }), mockRes(), next);
      expect(next, method).toHaveBeenCalledTimes(1);
    }
  });

  it('resets the budget after the window elapses', () => {
    const limiter = createMcpRateLimiter({ limit: 1, now });
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), vi.fn());
    const blocked = mockRes();
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), blocked, vi.fn());
    expect(blocked.statusCode).toBe(429);
    clock += 60_001;
    const next = vi.fn();
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('reads the default limit from MCP_RATE_LIMIT_PER_MIN', () => {
    vi.stubEnv('MCP_RATE_LIMIT_PER_MIN', '1');
    try {
      const limiter = createMcpRateLimiter({ now });
      limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), vi.fn());
      const res = mockRes();
      limiter(mockReq({ body: call(), tokenId: 'tok-1' }), res, vi.fn());
      expect(res.statusCode).toBe(429);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// --- End-to-end through the live Express mount (same harness as server.test.js) ---
describe('mounted /mcp guards', () => {
  const servers = [];
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });

  async function mountApp(env) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const app = express();
    app.use(express.json());
    mountMcp(app); // captures env-derived allowlist + limit at mount time
    vi.unstubAllEnvs();
    const server = createServer(app);
    servers.push(server);
    await new Promise((r) => server.listen(0, r));
    return `http://127.0.0.1:${server.address().port}`;
  }

  // Every authed request: token lookup -> last_used_at update -> resolveScope.
  function primeAuth() {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'tok', user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] });
  }

  async function rpc(base, method, params, { origin } = {}) {
    query.mockReset();
    primeAuth();
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer mcp_good',
    };
    if (origin) headers.Origin = origin;
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  it('403s a cross-origin browser request before auth, passes the app origin and no-Origin clients', async () => {
    const base = await mountApp({ APP_URL: 'https://mail.example.com' });

    query.mockReset();
    const evil = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe(-32000);
    expect(query).not.toHaveBeenCalled(); // rejected before the token ever hits the DB

    const sameOrigin = await rpc(base, 'tools/list', {}, { origin: 'https://mail.example.com' });
    expect(sameOrigin.status).toBe(200);

    const headless = await rpc(base, 'tools/list', {});
    expect(headless.status).toBe(200);
  });

  it('429s tool calls over the per-token budget but leaves tools/list untouched', async () => {
    const base = await mountApp({ MCP_RATE_LIMIT_PER_MIN: '1' });

    const first = await rpc(base, 'tools/call', { name: 'ping', arguments: {} });
    expect(first.status).toBe(200);

    const second = await rpc(base, 'tools/call', { name: 'ping', arguments: {} });
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toMatch(/^\d+$/);
    const body = await second.json();
    expect(body.error.message).toMatch(/rate limit/i);

    const list = await rpc(base, 'tools/list', {});
    expect(list.status).toBe(200);
  });
});
