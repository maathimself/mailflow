import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';

vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query } from '../services/db.js';
import { ALL_SCOPES, hashToken } from './auth.js';
import { createMcpRuntimeDependencies, mountMcp } from './server.js';

let server, base;

const COMPOSE_TOOL_NAMES = [
  'list_compose_sessions',
  'get_compose_session',
  'create_compose_session',
  'update_compose_session',
  'minimize_compose_session',
  'restore_compose_session',
  'add_compose_attachment',
  'remove_compose_attachment',
  'close_compose_session',
  'discard_compose_session',
  'send_compose_session',
];

const composeSessionService = {
  createComposeSession: vi.fn(),
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountMcp(app, { composeSessionService });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  composeSessionService.createComposeSession.mockReset().mockResolvedValue({
    id: 'session-1',
    slot: 1,
    revision: 1,
    presentationState: 'expanded',
  });
});

// Every authed request: token lookup -> last_used_at update -> resolveScope.
function primeAuth(
  userId = 'user-1',
  accountIds = ['acc-1'],
  scopes = ALL_SCOPES,
  tokenId = 'tok',
) {
  query
    .mockResolvedValueOnce({ rows: [{ id: tokenId, user_id: userId, scopes }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: accountIds.map((id) => ({ id })) });
}

async function rpc(method, params, {
  auth = true,
  scopes = ALL_SCOPES,
  tokenId = 'tok',
} = {}) {
  query.mockReset();
  if (auth) primeAuth('user-1', ['acc-1'], scopes, tokenId);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (auth) headers.Authorization = 'Bearer mcp_good';
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res;
}

async function rpcPayload(response) {
  const body = await response.text();
  const data = body.split(/\r?\n/).find(line => line.startsWith('data:'));
  return JSON.parse(data ? data.slice('data:'.length).trim() : body);
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

  it.each([
    ['read', ['read'], COMPOSE_TOOL_NAMES.slice(0, 2)],
    ['write', ['write'], COMPOSE_TOOL_NAMES.slice(0, 10)],
    ['send', ['send'], [
      'list_compose_sessions',
      'get_compose_session',
      'send_compose_session',
    ]],
  ])('lists only permitted compose-session tools for a %s token', async (
    _label,
    scopes,
    expected,
  ) => {
    const response = await rpc('tools/list', {}, { scopes });
    const payload = await rpcPayload(response);
    const listed = payload.result.tools
      .map(({ name }) => name)
      .filter(name => COMPOSE_TOOL_NAMES.includes(name));
    expect(listed).toEqual(expected);
  });

  it.each([
    ['read', ['read'], 'create_compose_session', {}, 'write'],
    ['write', ['write'], 'send_compose_session', {
      slot: 1,
      expected_revision: 1,
    }, 'send'],
    ['send', ['send'], 'update_compose_session', {
      slot: 1,
      expected_revision: 1,
    }, 'write'],
  ])('returns permission_denied for a %s token calling a forbidden compose tool', async (
    _label,
    scopes,
    name,
    args,
    required,
  ) => {
    const response = await rpc('tools/call', { name, arguments: args }, { scopes });
    const payload = await rpcPayload(response);
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text)
      .toContain(`permission_denied: tool "${name}" requires the "${required}" scope`);
  });

  it('returns stable unsupported when an authorized compose dependency is absent', async () => {
    const response = await rpc('tools/call', {
      name: 'list_compose_sessions',
      arguments: {},
    }, { scopes: ['read'] });
    const payload = await rpcPayload(response);
    expect(payload.result).toEqual({
      content: [{
        type: 'text',
        text: 'unsupported: compose session tools require composeSessionService',
      }],
      isError: true,
    });
  });

  it('returns stable unsupported when an authorized lifecycle dependency is absent', async () => {
    const response = await rpc('tools/call', {
      name: 'send_compose_session',
      arguments: { slot: 1, expected_revision: 1 },
    }, { scopes: ['send'] });
    const payload = await rpcPayload(response);
    expect(payload.result).toEqual({
      content: [{
        type: 'text',
        text: 'unsupported: compose session tools require composeSessionLifecycle',
      }],
      isError: true,
    });
  });

  it('propagates the authenticated token id into compose service client ids', async () => {
    const response = await rpc('tools/call', {
      name: 'create_compose_session',
      arguments: { slot: 1 },
    }, { scopes: ['write'], tokenId: 'tok-write' });
    const payload = await rpcPayload(response);
    expect(payload.result.isError).toBeUndefined();
    expect(composeSessionService.createComposeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        requestedSlot: 1,
        clientId: 'mcp:tok-write',
      }),
      expect.any(Object),
    );
  });

  it('keeps unexpected compose service details out of tool results', async () => {
    composeSessionService.createComposeSession.mockRejectedValueOnce(
      new Error('private database detail'),
    );
    const response = await rpc('tools/call', {
      name: 'create_compose_session',
      arguments: {},
    }, { scopes: ['write'] });
    const payload = await rpcPayload(response);
    expect(payload.result).toEqual({
      content: [{ type: 'text', text: 'internal error' }],
      isError: true,
    });
    expect(JSON.stringify(payload)).not.toContain('private database detail');
  });
});

describe('index MCP bootstrap', () => {
  it('supplies the real compose services and their complete runtime dependency graph', async () => {
    const [
      composeSessionService,
      composeSessionLifecycle,
      sendService,
      outboxService,
      draftService,
      db,
      redis,
    ] = await Promise.all([
      import('../services/composeSessionService.js'),
      import('../services/composeSessionLifecycle.js'),
      import('../services/sendService.js'),
      import('../services/outboxService.js'),
      import('../services/draftService.js'),
      vi.importActual('../services/db.js'),
      import('../services/redis.js'),
    ]);
    for (const method of [
      'listComposeSessions',
      'getComposeSession',
      'createComposeSession',
      'patchComposeSession',
      'setComposePresentation',
      'addComposeAttachment',
      'removeComposeAttachment',
    ]) {
      expect(composeSessionService[method], `composeSessionService.${method}`)
        .toBeTypeOf('function');
    }
    for (const method of [
      'closeComposeSession',
      'discardComposeSession',
      'sendComposeSession',
    ]) {
      expect(composeSessionLifecycle[method], `composeSessionLifecycle.${method}`)
        .toBeTypeOf('function');
    }

    const imapManager = { broadcast: vi.fn() };
    const refreshMicrosoftToken = vi.fn();
    const broadcast = (event, userId) => imapManager.broadcast(event, userId);
    const inputs = {
      imapManager,
      refreshMicrosoftToken,
      redisClient: redis.redisClient,
      sendService,
      outboxService,
      draftService,
      composeSessionService,
      composeSessionLifecycle,
      query: db.query,
      withTransaction: db.withTransaction,
      broadcast,
    };
    const dependencies = createMcpRuntimeDependencies(inputs);
    expect(dependencies).toEqual(inputs);

    const event = { type: 'compose_sessions_updated' };
    dependencies.broadcast(event, 'user-1');
    expect(imapManager.broadcast).toHaveBeenCalledWith(event, 'user-1');

    for (const name of Object.keys(inputs)) {
      const incomplete = { ...inputs };
      delete incomplete[name];
      expect(() => createMcpRuntimeDependencies(incomplete), name)
        .toThrow(`MCP runtime dependency missing: ${name}`);
    }
  });
});
