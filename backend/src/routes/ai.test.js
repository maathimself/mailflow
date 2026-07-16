import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getAdminAiConfig: vi.fn(),
  saveAiConfig: vi.fn(),
  deleteAiConfig: vi.fn(),
  getAiStatus: vi.fn(),
  testAiProvider: vi.fn(),
  streamChat: vi.fn(),
  startDeviceFlow: vi.fn(),
  pollDeviceFlow: vi.fn(),
  cancelDeviceFlow: vi.fn(),
  getCodexStatus: vi.fn(),
  disconnectCodex: vi.fn(),
}));

vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../services/aiProvider.js', () => ({
  getAdminAiConfig: mocks.getAdminAiConfig,
  saveAiConfig: mocks.saveAiConfig,
  deleteAiConfig: mocks.deleteAiConfig,
  getAiStatus: mocks.getAiStatus,
  testAiProvider: mocks.testAiProvider,
  streamChat: mocks.streamChat,
}));
vi.mock('../services/openaiCodexAuth.js', () => ({
  startDeviceFlow: mocks.startDeviceFlow,
  pollDeviceFlow: mocks.pollDeviceFlow,
  cancelDeviceFlow: mocks.cancelDeviceFlow,
  getCodexStatus: mocks.getCodexStatus,
  disconnectCodex: mocks.disconnectCodex,
}));

import express from 'express';
import aiRoutes from './ai.js';

const ADMIN = 'admin-user';
const MEMBER = 'ordinary-user';
const FLOW_ID = '11111111-1111-4111-8111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    if (userId) {
      req.session = { userId, username: userId, destroy: vi.fn() };
      req.sessionID = `session-${userId}`;
    }
    next();
  });
  app.use('/api', aiRoutes);
  // Mirrors index.js without exposing internal exception messages.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error' });
  });
  return app;
}

function request(path, { method = 'GET', user = ADMIN, body } = {}) {
  const headers = {};
  if (user) headers['x-test-user'] = user;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function chat(body, options = {}) {
  return request('/api/ai/chat', { method: 'POST', user: MEMBER, body, ...options });
}

async function* deltas(...values) {
  yield* values;
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
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT is_admin FROM users/i.test(sql)) {
      return { rows: params[0] === ADMIN ? [{ is_admin: true }] : [{ is_admin: false }] };
    }
    if (/SELECT id FROM users/i.test(sql)) return { rows: params[0] ? [{ id: params[0] }] : [] };
    if (/system_settings/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  mocks.getAdminAiConfig.mockResolvedValue(null);
  mocks.saveAiConfig.mockImplementation(async (config) => config);
  mocks.deleteAiConfig.mockResolvedValue(undefined);
  mocks.getAiStatus.mockResolvedValue({ enabled: true, provider: 'api-key', features: { compose: true } });
  mocks.testAiProvider.mockResolvedValue({ ok: true });
  mocks.streamChat.mockImplementation(() => deltas('Hello'));
  mocks.startDeviceFlow.mockResolvedValue({
    flowId: FLOW_ID,
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: 2_000_000_000_000,
    intervalMs: 5000,
  });
  mocks.pollDeviceFlow.mockResolvedValue({ status: 'pending', retryAfterMs: 5000 });
  mocks.cancelDeviceFlow.mockResolvedValue({ status: 'cancelled' });
  mocks.getCodexStatus.mockResolvedValue({ connected: false, state: 'disconnected', reconnectRequired: false });
  mocks.disconnectCodex.mockResolvedValue({ status: 'disconnected' });
});

describe('admin authorization and configuration', () => {
  it.each([
    [null, 401],
    [MEMBER, 403],
    [ADMIN, 200],
  ])('guards device start for user %s with status %i', async (user, status) => {
    const response = await request('/api/admin/ai/codex/device', { method: 'POST', user });
    expect(response.status).toBe(status);
  });

  it('returns the adapter-normalized masked configuration', async () => {
    const config = {
      enabled: true,
      provider: 'chatgpt',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
      features: { compose: true, summarize: false },
    };
    mocks.getAdminAiConfig.mockResolvedValue(config);
    const response = await request('/api/admin/ai');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ config });
  });

  it('saves provider selection through the adapter without returning secrets', async () => {
    const input = {
      enabled: true,
      provider: 'chatgpt',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
      features: { compose: true, summarize: true },
    };
    mocks.saveAiConfig.mockResolvedValue(input);
    const response = await request('/api/admin/ai', { method: 'PATCH', body: input });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, config: input });
    expect(mocks.saveAiConfig).toHaveBeenCalledWith(input);
  });

  it('deletes only the provider configuration through the adapter', async () => {
    const response = await request('/api/admin/ai', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.deleteAiConfig).toHaveBeenCalledTimes(1);
    expect(mocks.disconnectCodex).not.toHaveBeenCalled();
  });

  it('tests the selected provider through the adapter', async () => {
    const response = await request('/api/admin/ai/test', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.testAiProvider).toHaveBeenCalledTimes(1);
  });

  it('does not expose upstream diagnostics when a provider test fails', async () => {
    mocks.testAiProvider.mockRejectedValue(Object.assign(
      new Error('access-token-secret and mailbox content'),
      { status: 502 },
    ));
    const response = await request('/api/admin/ai/test', { method: 'POST' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI provider test failed' });
  });
});

describe('admin ChatGPT device lifecycle', () => {
  it('binds device start to the initiating admin session', async () => {
    const response = await request('/api/admin/ai/codex/device', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ flowId: FLOW_ID, userCode: 'ABCD-EFGH' });
    expect(mocks.startDeviceFlow).toHaveBeenCalledWith({
      userId: ADMIN,
      sessionId: `session-${ADMIN}`,
    });
  });

  it('polls and cancels only through the initiating admin session', async () => {
    const pollResponse = await request('/api/admin/ai/codex/device/poll', {
      method: 'POST', body: { flowId: FLOW_ID },
    });
    expect(pollResponse.status).toBe(200);
    expect(await pollResponse.json()).toEqual({ status: 'pending', retryAfterMs: 5000 });
    expect(mocks.pollDeviceFlow).toHaveBeenCalledWith({
      flowId: FLOW_ID, userId: ADMIN, sessionId: `session-${ADMIN}`,
    });

    const cancelResponse = await request('/api/admin/ai/codex/device', {
      method: 'DELETE', body: { flowId: FLOW_ID },
    });
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toEqual({ status: 'cancelled' });
    expect(mocks.cancelDeviceFlow).toHaveBeenCalledWith({
      flowId: FLOW_ID, userId: ADMIN, sessionId: `session-${ADMIN}`,
    });
  });

  it('returns masked status and disconnects credentials plus pending flows', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      connected: true, state: 'connected', expiresAt: 2_000_000_000_000, accountLabel: 'v•••@example.com',
    });
    const statusResponse = await request('/api/admin/ai/codex/status');
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toEqual({
      connected: true, state: 'connected', expiresAt: 2_000_000_000_000, accountLabel: 'v•••@example.com',
    });
    expect(mocks.getCodexStatus).toHaveBeenCalledWith({
      userId: ADMIN, sessionId: `session-${ADMIN}`,
    });

    const disconnectResponse = await request('/api/admin/ai/codex', { method: 'DELETE' });
    expect(disconnectResponse.status).toBe(200);
    expect(await disconnectResponse.json()).toEqual({ status: 'disconnected' });
    expect(mocks.disconnectCodex).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['POST', '/api/admin/ai/codex/device/poll', mocks.pollDeviceFlow],
    ['DELETE', '/api/admin/ai/codex/device', mocks.cancelDeviceFlow],
  ])('rejects malformed flow IDs before %s dispatch', async (method, path, service) => {
    const response = await request(path, { method, body: { flowId: 'not-a-uuid' } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid flowId' });
    expect(service).not.toHaveBeenCalled();
  });

  it('preserves sanitized service status codes for missing or wrong-session flows', async () => {
    mocks.pollDeviceFlow.mockRejectedValue(Object.assign(new Error('Device authorization not found'), { status: 404 }));
    const response = await request('/api/admin/ai/codex/device/poll', {
      method: 'POST', body: { flowId: FLOW_ID },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Device authorization not found' });
  });
});

describe('authenticated AI status and streaming', () => {
  it('requires authentication for status and returns provider-aware state', async () => {
    const unauthenticated = await request('/api/ai/status', { user: null });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await request('/api/ai/status', { user: MEMBER });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({
      enabled: true, provider: 'api-key', features: { compose: true },
    });
  });

  it.each([
    [{}, /messages array is required/i],
    [{ messages: [{ role: 'tool', content: 'x' }] }, /invalid message role/i],
    [{ messages: [{ role: 'user', content: 42 }] }, /role and content/i],
    [{ messages: [{ role: 'user', content: 'x'.repeat(32_001) }] }, /maximum length/i],
  ])('rejects invalid chat input %# before calling a provider', async (body, errorPattern) => {
    const response = await chat(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(errorPattern);
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });

  it('preserves the Chat Completions SSE contract for normalized provider deltas', async () => {
    mocks.streamChat.mockImplementation(() => deltas('Hel', 'lo'));
    const messages = [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Hi' }];
    const response = await chat({ messages });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(await response.text()).toBe(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
      + 'data: [DONE]\n\n',
    );
    expect(mocks.streamChat).toHaveBeenCalledWith(messages, { signal: expect.any(AbortSignal) });
  });

  it('returns 503 before streaming when the selected provider is unavailable', async () => {
    mocks.getAiStatus.mockResolvedValue({
      enabled: false,
      provider: 'chatgpt',
      reconnectRequired: true,
      features: { compose: true },
    });
    const response = await chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AI provider requires reconnection' });
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });

  it('aborts the provider stream when the HTTP client disconnects', async () => {
    let providerSignal;
    let resolveAbort;
    const aborted = new Promise((resolve) => { resolveAbort = resolve; });
    mocks.streamChat.mockImplementation(async function* stream(_messages, { signal }) {
      providerSignal = signal;
      yield 'first';
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolveAbort();
          resolve();
        }, { once: true });
      });
    });

    const controller = new AbortController();
    const response = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': MEMBER },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await aborted;
    expect(providerSignal.aborted).toBe(true);
  });

  it('emits a generic SSE error after headers without exposing upstream credentials', async () => {
    mocks.streamChat.mockImplementation(async function* stream() {
      yield 'first';
      throw new Error('access-token-secret');
    });
    const response = await chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('data: {"error":"AI request failed"}\n\n');
    expect(text).toContain('data: [DONE]\n\n');
    expect(text).not.toContain('access-token-secret');
  });
});
