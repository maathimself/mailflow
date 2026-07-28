import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('./accountAdapter.js', async (orig) => {
  const actual = await orig();
  return { ...actual, runRules: vi.fn() };
});
import { query } from '../services/db.js';
import { runRules } from './accountAdapter.js';
import { ALL_SCOPES } from './auth.js';
import {
  buildAllowedOrigins, buildServer, mcpBodyLimit, mcpOriginGuard,
  classifyToolCalls, countToolCalls, createMcpRateLimiter,
  entityTooLargeResponse, mountMcp,
} from './server.js';
import { HANDLERS, TOOL_DEFS, TOOL_SCOPES } from './tools.js';

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

async function withMcpClient(scope, callback, deps = {}) {
  const server = buildServer(scope, deps);
  const client = new Client({ name: 'scope-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

describe('MCP dependency injection', () => {
  it('passes the buildServer dependency bag to a three-argument tool handler', async () => {
    const scope = { userId: 'u', accountIds: ['acc-1'], scopes: ['read'] };
    const deps = { marker: Symbol('deps') };
    const handler = vi.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    }));
    HANDLERS.__dependency_probe = handler;
    TOOL_SCOPES.__dependency_probe = 'read';

    try {
      await withMcpClient(scope, async (client) => {
        await client.callTool({
          name: '__dependency_probe',
          arguments: { value: 42 },
        });
      }, deps);
      expect(handler).toHaveBeenCalledWith({ value: 42 }, scope, deps);
    } finally {
      delete HANDLERS.__dependency_probe;
      delete TOOL_SCOPES.__dependency_probe;
    }
  });

  it('mounts both with a dependency bag and without one', () => {
    expect(() => mountMcp(express(), { marker: true })).not.toThrow();
    expect(() => mountMcp(express())).not.toThrow();
  });
});

describe('tool scope classifications', () => {
  it('classifies every listed tool and handler', () => {
    const definedNames = TOOL_DEFS.map(({ name }) => name).sort();
    expect(Object.keys(HANDLERS).sort()).toEqual(definedNames);
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual(definedNames);
  });
});

describe('tool scope enforcement', () => {
  it('omits tools from tools/list when the token lacks their scope', async () => {
    await withMcpClient({ userId: 'u', accountIds: [], scopes: ['read'] }, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toContain('ping');
      expect(tools.map(({ name }) => name)).not.toContain('stage_deletion');
    });
  });

  it('refuses tools/call when the token lacks the required scope', async () => {
    await withMcpClient({ userId: 'u', accountIds: [], scopes: ['read'] }, async (client) => {
      const result = await client.callTool({
        name: 'stage_deletion',
        arguments: { from: 'sender@example.com' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        'permission_denied: tool "stage_deletion" requires the "write" scope; this token has [read]',
      );
    });
  });

  it('refuses tools/call when the tool has no scope classification', async () => {
    const requiredScope = TOOL_SCOPES.ping;
    delete TOOL_SCOPES.ping;
    try {
      await withMcpClient({ userId: 'u', accountIds: [], scopes: ['read'] }, async (client) => {
        const result = await client.callTool({ name: 'ping', arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          'permission_denied: tool "ping" has no scope classification',
        );
      });
    } finally {
      TOOL_SCOPES.ping = requiredScope;
    }
  });

  it('allows tools/call when the token has the required scope', async () => {
    await withMcpClient({ userId: 'u', accountIds: [], scopes: ['read'] }, async (client) => {
      const result = await client.callTool({ name: 'ping', arguments: {} });
      expect(JSON.parse(result.content[0].text)).toEqual({ pong: true });
    });
  });

  it('requires both settings and write before run_rules reaches its adapter', async () => {
    const deps = { imapManager: { marker: 'injected' } };
    runRules.mockReset().mockResolvedValue({ processed: 0, matched: 0 });

    await withMcpClient({
      userId: 'u',
      accountIds: ['acc-1'],
      scopes: ['settings'],
    }, async (client) => {
      const result = await client.callTool({
        name: 'run_rules',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('permission_denied');
      expect(runRules).not.toHaveBeenCalled();
    }, deps);

    await withMcpClient({
      userId: 'u',
      accountIds: ['acc-1'],
      scopes: ['settings', 'write', 'read'],
    }, async (client) => {
      const result = await client.callTool({
        name: 'run_rules',
        arguments: {},
      });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        processed: 0,
        matched: 0,
      });
      expect(runRules).toHaveBeenCalledTimes(1);
      expect(runRules).toHaveBeenCalledWith({
        userId: 'u',
        accountIds: ['acc-1'],
        imapManager: deps.imapManager,
      });
    }, deps);
  });
});

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

describe('mcpBodyLimit', () => {
  it('parses a 2 MB MCP body before the global 1 MB parser', async () => {
    const app = express();
    app.use('/mcp', mcpBodyLimit());
    app.use(express.json({ limit: '1mb' }));
    app.post('/mcp', (req, res) => res.json({ size: req.body.payload.length }));
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));

    try {
      const payload = 'x'.repeat(2 * 1024 * 1024);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ size: payload.length });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('entityTooLargeResponse', () => {
  it('returns a JSON-RPC-shaped MCP 413 response', () => {
    expect(entityTooLargeResponse(
      { type: 'entity.too.large' },
      '/mcp',
    )).toEqual({
      status: 413,
      body: {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Request too large (max 35 MB).' },
        id: null,
      },
    });
  });

  it('preserves the existing REST attachment 413 response', () => {
    expect(entityTooLargeResponse(
      { type: 'entity.too.large' },
      '/api/mail/send',
    )).toEqual({
      status: 413,
      body: {
        error: 'Request too large. Total attachment size must not exceed 25 MB.',
      },
    });
  });

  it('returns null for other errors so Express can forward them', () => {
    expect(entityTooLargeResponse(new Error('boom'), '/mcp')).toBeNull();
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

describe('classifyToolCalls', () => {
  it('counts tool calls by the tool scope class and ignores handshake methods', () => {
    TOOL_SCOPES.__send_probe = 'send';
    TOOL_SCOPES.__settings_probe = 'settings';
    try {
      expect(classifyToolCalls([
        { method: 'initialize' },
        { method: 'tools/call', params: { name: 'ping' } },
        { method: 'tools/call', params: { name: 'stage_deletion' } },
        { method: 'tools/call', params: { name: '__send_probe' } },
        { method: 'tools/call', params: { name: '__settings_probe' } },
      ])).toEqual({ read: 1, write: 1, send: 1, settings: 1 });
    } finally {
      delete TOOL_SCOPES.__send_probe;
      delete TOOL_SCOPES.__settings_probe;
    }
  });

  it('uses the first listed scope as an array-scoped tool primary class', () => {
    TOOL_SCOPES.__array_probe = ['send', 'write'];
    try {
      expect(classifyToolCalls({
        method: 'tools/call',
        params: { name: '__array_probe' },
      })).toEqual({ read: 0, write: 0, send: 1, settings: 0 });
    } finally {
      delete TOOL_SCOPES.__array_probe;
    }
  });

  it('charges unknown tool names to read and returns zeros for non-call bodies', () => {
    expect(classifyToolCalls({
      method: 'tools/call',
      params: { name: 'typo_tool' },
    })).toEqual({ read: 1, write: 0, send: 0, settings: 0 });
    expect(classifyToolCalls({ method: 'tools/list' }))
      .toEqual({ read: 0, write: 0, send: 0, settings: 0 });
    expect(classifyToolCalls(undefined))
      .toEqual({ read: 0, write: 0, send: 0, settings: 0 });
  });
});

describe('createMcpRateLimiter', () => {
  let clock;
  const now = () => clock;
  const call = (name = 'ping', id = 1) => ({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name },
    id,
  });
  const limits = { read: 1, write: 1, send: 1, settings: 1 };

  beforeEach(() => {
    clock = 1_000_000;
    TOOL_SCOPES.__send_probe = 'send';
    TOOL_SCOPES.__settings_probe = 'settings';
  });
  afterEach(() => {
    delete TOOL_SCOPES.__send_probe;
    delete TOOL_SCOPES.__settings_probe;
    vi.unstubAllEnvs();
  });

  it.each([
    ['read', 'ping'],
    ['write', 'stage_deletion'],
    ['send', '__send_probe'],
    ['settings', '__settings_probe'],
  ])('enforces the %s per-minute bucket independently', (rateClass, toolName) => {
    const limiter = createMcpRateLimiter({ limits, now });
    const first = vi.fn();
    limiter(mockReq({ body: call(toolName), tokenId: 'tok-1' }), mockRes(), first);
    expect(first).toHaveBeenCalledTimes(1);

    const res = mockRes();
    limiter(mockReq({ body: call(toolName, 42), tokenId: 'tok-1' }), res, vi.fn());
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe(60);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Rate limit exceeded: at most 1 ${rateClass} tool calls per minute per token`,
      },
      id: 42,
    });
  });

  it('keys buckets per token, not globally', () => {
    const limiter = createMcpRateLimiter({ limits, now });
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), vi.fn());
    const next = vi.fn();
    limiter(mockReq({ body: call(), tokenId: 'tok-2' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1); // a different token has its own budget
  });

  it('never throttles the initialize/tools-list handshake', () => {
    const limiter = createMcpRateLimiter({ limits, now });
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']) {
      const next = vi.fn();
      limiter(mockReq({ body: { jsonrpc: '2.0', method, id: 1 }, tokenId: 'tok-1' }), mockRes(), next);
      expect(next, method).toHaveBeenCalledTimes(1);
    }
  });

  it('resets the budget after the window elapses', () => {
    const limiter = createMcpRateLimiter({ limits, now });
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), vi.fn());
    const blocked = mockRes();
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), blocked, vi.fn());
    expect(blocked.statusCode).toBe(429);
    clock += 60_001;
    const next = vi.fn();
    limiter(mockReq({ body: call(), tokenId: 'tok-1' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('reads every default class limit from its environment variable', () => {
    vi.stubEnv('MCP_RATE_LIMIT_PER_MIN', '1');
    vi.stubEnv('MCP_WRITE_RATE_LIMIT_PER_MIN', '1');
    vi.stubEnv('MCP_SEND_RATE_LIMIT_PER_MIN', '1');
    vi.stubEnv('MCP_SETTINGS_RATE_LIMIT_PER_MIN', '1');
    const limiter = createMcpRateLimiter({ now });
    for (const toolName of ['ping', 'stage_deletion', '__send_probe', '__settings_probe']) {
      limiter(mockReq({ body: call(toolName), tokenId: 'tok-1' }), mockRes(), vi.fn());
      const res = mockRes();
      limiter(mockReq({ body: call(toolName), tokenId: 'tok-1' }), res, vi.fn());
      expect(res.statusCode).toBe(429);
    }
  });

  it('rejects an over-budget batch atomically with a null JSON-RPC id', () => {
    const limiter = createMcpRateLimiter({ limits, now });
    const batch = [
      call('ping', 1),
      call('stage_deletion', 2),
      call('stage_deletion', 3),
    ];
    const res = mockRes();
    limiter(mockReq({ body: batch, tokenId: 'tok-1' }), res, vi.fn());
    expect(res.statusCode).toBe(429);
    expect(res.body.id).toBeNull();
    expect(res.body.error.message).toContain('write tool calls');

    // Rejection admitted none of the batch, including its otherwise-valid read.
    const next = vi.fn();
    limiter(mockReq({ body: call('ping'), tokenId: 'tok-1' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('enforces and resets the 24-hour send cap alongside the minute bucket', () => {
    vi.stubEnv('MCP_SEND_DAILY_CAP', '2');
    const limiter = createMcpRateLimiter({
      limits: { ...limits, send: 10 },
      now,
    });
    for (let i = 0; i < 2; i++) {
      const next = vi.fn();
      limiter(mockReq({ body: call('__send_probe'), tokenId: 'tok-1' }), mockRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    const blocked = mockRes();
    limiter(mockReq({ body: call('__send_probe', 9), tokenId: 'tok-1' }), blocked, vi.fn());
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['Retry-After']).toBe(86_400);
    expect(blocked.body.error.message)
      .toBe('Rate limit exceeded: at most 2 send tool calls per day per token');

    clock += 86_400_001;
    const next = vi.fn();
    limiter(mockReq({ body: call('__send_probe'), tokenId: 'tok-1' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce({ rows: [{ id: 'tok', user_id: 'user-1', scopes: ALL_SCOPES }] })
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
