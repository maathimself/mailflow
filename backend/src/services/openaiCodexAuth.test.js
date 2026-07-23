import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import {
  OPENAI_CODEX_DEVICE_URL,
  createOpenAiCodexAuth,
  createPostgresCodexStore,
  decodeJwtClaims,
  extractChatGptAccount,
  hashSessionId,
} from './openaiCodexAuth.js';
import { decrypt, encrypt } from './encryption.js';
import { withTransaction } from './db.js';

const KEY = '11'.repeat(32);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accessToken({ accountId = 'acct_123', email = 'owner@example.com', expiresIn = 3600 } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expiresIn,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    'https://api.openai.com/profile': { email },
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

class MemoryStore {
  constructor() {
    this.flows = new Map();
    this.credential = null;
    this.nextId = 1;
    this.lock = Promise.resolve();
  }

  async createFlow(flow) {
    for (const current of this.flows.values()) {
      if (current.adminUserId === flow.adminUserId && current.sessionHash === flow.sessionHash
          && ['pending', 'polling', 'authorized'].includes(current.state)) {
        current.state = 'cancelled';
      }
    }
    const record = { ...flow, id: `flow-${this.nextId++}`, updatedAt: flow.createdAt };
    this.flows.set(record.id, record);
    return { ...record };
  }

  owned(flow, owner) {
    return flow && flow.adminUserId === owner.adminUserId && flow.sessionHash === owner.sessionHash;
  }

  async claimFlow({ id, adminUserId, sessionHash, now, staleBefore }) {
    const flow = this.flows.get(id);
    if (!this.owned(flow, { adminUserId, sessionHash })) return { kind: 'not_found' };
    if (['pending', 'polling', 'authorized'].includes(flow.state) && flow.expiresAt <= now) {
      flow.state = 'expired';
      flow.updatedAt = now;
    }
    if (['completed', 'cancelled', 'expired', 'failed'].includes(flow.state)) {
      return { kind: 'terminal', state: flow.state, failureCode: flow.failureCode };
    }
    if (flow.state === 'pending' && flow.nextPollAt > now) {
      return { kind: 'waiting', retryAfterMs: flow.nextPollAt - now };
    }
    if (flow.state === 'polling' && flow.updatedAt > staleBefore) {
      return { kind: 'waiting', retryAfterMs: 1000 };
    }
    flow.state = 'polling';
    flow.updatedAt = now;
    return { kind: 'claimed', flow: { ...flow } };
  }

  async releaseFlow({ id, state, intervalMs, nextPollAt, failureCode, clearSecrets = false }) {
    const flow = this.flows.get(id);
    if (!['polling', 'authorized'].includes(flow.state)) return;
    flow.state = state;
    if (intervalMs !== undefined) flow.intervalMs = intervalMs;
    if (nextPollAt !== undefined) flow.nextPollAt = nextPollAt;
    if (failureCode !== undefined) flow.failureCode = failureCode;
    if (clearSecrets) {
      flow.deviceAuthIdEnc = null;
      flow.userCodeEnc = null;
      flow.authorizationCodeEnc = null;
      flow.codeVerifierEnc = null;
    }
    flow.updatedAt = Date.now();
  }

  async authorizeFlow({ id, authorizationCodeEnc, codeVerifierEnc }) {
    const flow = this.flows.get(id);
    if (flow.state !== 'polling') return false;
    flow.authorizationCodeEnc = authorizationCodeEnc;
    flow.codeVerifierEnc = codeVerifierEnc;
    flow.state = 'authorized';
    return true;
  }

  async completeFlow({ id, encryptedCredential }) {
    const flow = this.flows.get(id);
    if (flow.state !== 'authorized' && flow.state !== 'polling') return false;
    this.credential = encryptedCredential;
    Object.assign(flow, {
      state: 'completed',
      deviceAuthIdEnc: null,
      userCodeEnc: null,
      authorizationCodeEnc: null,
      codeVerifierEnc: null,
      completedAt: Date.now(),
    });
    return true;
  }

  async cancelFlow({ id, adminUserId, sessionHash }) {
    const flow = this.flows.get(id);
    if (!this.owned(flow, { adminUserId, sessionHash })
        || !['pending', 'polling', 'authorized'].includes(flow.state)) return false;
    Object.assign(flow, {
      state: 'cancelled',
      deviceAuthIdEnc: null,
      userCodeEnc: null,
      authorizationCodeEnc: null,
      codeVerifierEnc: null,
    });
    return true;
  }

  async latestOwnedFlow({ adminUserId, sessionHash }) {
    return [...this.flows.values()].reverse()
      .find((flow) => this.owned(flow, { adminUserId, sessionHash })) || null;
  }

  async getCredential() {
    return this.credential;
  }

  async disconnect() {
    this.credential = null;
    for (const flow of this.flows.values()) {
      if (['pending', 'polling', 'authorized'].includes(flow.state)) flow.state = 'cancelled';
    }
  }

  async withCredentialLock(callback) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback({
        encryptedCredential: this.credential,
        save: async (value) => { this.credential = value; },
      });
    } finally {
      release();
    }
  }
}

function service({ store = new MemoryStore(), fetchFn = vi.fn(), now = () => Date.now() } = {}) {
  return { auth: createOpenAiCodexAuth({ store, fetchFn, now }), store, fetchFn };
}

function seedCredential(store, overrides = {}) {
  store.credential = encrypt(JSON.stringify({
    state: 'connected',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 3600_000,
    accountId: 'acct_old',
    accountLabel: 'owner@example.com',
    failureCode: null,
    ...overrides,
  }));
}

function readCredential(store) {
  return JSON.parse(decrypt(store.credential));
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
  withTransaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JWT helpers', () => {
  it('decodes base64url claims and extracts the namespaced account and profile email', () => {
    const claims = decodeJwtClaims(accessToken());
    expect(extractChatGptAccount(claims)).toEqual({ accountId: 'acct_123', email: 'owner@example.com' });
  });

  it.each(['', 'not-a-jwt', 'a.invalid-json.c', 'a.e30.c'])(
    'rejects malformed or account-less access token %j',
    (token) => expect(() => extractChatGptAccount(decodeJwtClaims(token))).toThrow(/account/i),
  );

  it('hashes rather than stores a raw session id', () => {
    const hash = hashSessionId('session-secret');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('session-secret');
  });
});

describe('Postgres credential lifecycle', () => {
  it('cancels active device flows before deleting the shared credential', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation((callback) => callback(client));

    await createPostgresCodexStore().disconnect();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[0][0]).toMatch(/UPDATE ai_codex_device_flows/);
    expect(client.query.mock.calls[1][0]).toMatch(/DELETE FROM ai_codex_credentials/);
  });

  it('locks the admin row before replacing an active device flow', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation((callback) => callback(client));

    await createPostgresCodexStore().createFlow({
      adminUserId: 'admin-1',
      sessionHash: 'session-hash',
      deviceAuthIdEnc: 'encrypted-device',
      userCodeEnc: 'encrypted-code',
      intervalMs: 2000,
      expiresAt: 901000,
      nextPollAt: 3000,
      createdAt: 1000,
    });

    expect(client.query.mock.calls[0][0]).toMatch(/SELECT id FROM users.*FOR UPDATE/s);
    expect(client.query.mock.calls[0][1]).toEqual(['admin-1']);
    expect(client.query.mock.calls[1][0]).toMatch(/UPDATE ai_codex_device_flows/);
  });
});

describe('device authorization lifecycle', () => {
  it('requests a device code and persists only encrypted codes plus a session hash', async () => {
    const { auth, store, fetchFn } = service({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({
        device_auth_id: 'device-secret', user_code: 'ABCD-EFGH', interval: '2',
      })),
    });

    const result = await auth.startDeviceFlow({ userId: 'admin-1', sessionId: 'session-secret' });

    expect(result).toMatchObject({
      flowId: 'flow-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: OPENAI_CODEX_DEVICE_URL,
      intervalMs: 2000,
      status: 'pending',
    });
    expect(result).not.toHaveProperty('deviceAuthId');
    const stored = store.flows.get('flow-1');
    expect(stored.deviceAuthIdEnc).toMatch(/^enc:v1:/);
    expect(stored.userCodeEnc).toMatch(/^enc:v1:/);
    expect(stored.sessionHash).toBe(hashSessionId('session-secret'));
    expect(JSON.stringify(stored)).not.toContain('device-secret');
    expect(JSON.stringify(stored)).not.toContain('ABCD-EFGH');
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'POST', headers: { 'Content-Type': 'application/json', originator: 'mailflow' },
    });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  });

  it('keeps the authorization timeout active while reading a response body', async () => {
    vi.useFakeTimers();
    let requestSignal;
    const fetchFn = vi.fn((_url, init) => {
      requestSignal = init.signal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        },
      })));
    });
    const auth = createOpenAiCodexAuth({ store: new MemoryStore(), fetchFn });
    const pending = auth.startDeviceFlow({ userId: 'admin-1', sessionId: 'session-secret' });
    const assertion = expect(pending).rejects.toMatchObject({ transient: true });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(requestSignal.aborted).toBe(true);
    await assertion;
  });

  it('resumes a pending replacement flow ahead of stale reconnect status', async () => {
    const store = new MemoryStore();
    seedCredential(store, {
      state: 'reconnect_required',
      accessToken: null,
      refreshToken: null,
      failureCode: 'invalid_grant',
    });
    const auth = createOpenAiCodexAuth({
      store,
      now: () => 1000,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({
        device_auth_id: 'device-secret', user_code: 'ABCD-EFGH', interval: 2,
      })),
    });

    await auth.startDeviceFlow({ userId: 'admin-1', sessionId: 'session-secret' });

    await expect(auth.getStatus({ userId: 'admin-1', sessionId: 'session-secret' })).resolves.toEqual({
      connected: false,
      state: 'pending',
      device: {
        flowId: 'flow-1',
        userCode: 'ABCD-EFGH',
        verificationUrl: OPENAI_CODEX_DEVICE_URL,
        expiresAt: 901000,
        intervalMs: 2000,
      },
    });
  });

  it('rejects malformed device responses without reflecting raw payloads', async () => {
    const { auth } = service({ fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'secret-only' })) });
    const error = await auth.startDeviceFlow({ userId: 'a', sessionId: 's' }).catch((cause) => cause);
    expect(error.message).toMatch(/invalid device code response/i);
    expect(error.message).not.toContain('secret-only');
  });

  it.each([
    [new Response(null, { status: 404 })],
    [jsonResponse({ error: { code: 'deviceauth_authorization_pending' } }, 400)],
  ])('keeps pending responses restart-safe across service instances', async (pendingResponse) => {
    const store = new MemoryStore();
    const first = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const started = await first.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(started.flowId).nextPollAt = 0;

    const fetchFn = vi.fn().mockResolvedValue(pendingResponse);
    const afterRestart = createOpenAiCodexAuth({ store, fetchFn });
    const result = await afterRestart.pollDeviceFlow({
      flowId: started.flowId, userId: 'admin', sessionId: 'session',
    });

    expect(result).toMatchObject({ status: 'pending', retryAfterMs: 1000 });
    expect(store.flows.get(started.flowId).state).toBe('pending');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('honors slow_down by increasing the persisted polling interval', async () => {
    const store = new MemoryStore();
    const start = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await start.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    const poll = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ error: 'slow_down' }, 400)),
    });

    await expect(poll.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .resolves.toMatchObject({ status: 'pending', retryAfterMs: 6000 });
    expect(store.flows.get(flowId).intervalMs).toBe(6000);
  });

  it('recovers a stale polling claim after a backend restart', async () => {
    const now = 100_000;
    const store = new MemoryStore();
    const starter = createOpenAiCodexAuth({
      store,
      now: () => now,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await starter.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    Object.assign(store.flows.get(flowId), { state: 'polling', updatedAt: 0, nextPollAt: 0 });
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const restarted = createOpenAiCodexAuth({ store, fetchFn, now: () => now });

    await expect(restarted.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .resolves.toEqual({ status: 'pending', retryAfterMs: 1000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('allows only one in-flight poll claim across service instances', async () => {
    const now = 100_000;
    const store = new MemoryStore();
    const starter = createOpenAiCodexAuth({
      store,
      now: () => now,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await starter.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    let resolvePoll;
    const fetchFn = vi.fn(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const one = createOpenAiCodexAuth({ store, fetchFn, now: () => now });
    const two = createOpenAiCodexAuth({ store, fetchFn, now: () => now });

    const first = one.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await expect(two.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .resolves.toEqual({ status: 'pending', retryAfterMs: 1000 });
    resolvePoll(new Response(null, { status: 404 }));
    await expect(first).resolves.toEqual({ status: 'pending', retryAfterMs: 1000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('prevents a different session from polling or cancelling a flow', async () => {
    const { auth, store, fetchFn } = service({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await auth.startDeviceFlow({ userId: 'admin', sessionId: 'owner' });
    fetchFn.mockClear();
    store.flows.get(flowId).nextPollAt = 0;

    await expect(auth.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'intruder' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(auth.cancelDeviceFlow({ flowId, userId: 'admin', sessionId: 'intruder' }))
      .rejects.toMatchObject({ status: 404 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('cancels and expires pending flows without another upstream request', async () => {
    let now = 1000;
    const store = new MemoryStore();
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }));
    const auth = createOpenAiCodexAuth({ store, fetchFn, now: () => now });
    const cancelled = await auth.startDeviceFlow({ userId: 'admin', sessionId: 'one' });
    const expired = await auth.startDeviceFlow({ userId: 'admin', sessionId: 'two' });
    fetchFn.mockClear();

    await expect(auth.cancelDeviceFlow({ flowId: cancelled.flowId, userId: 'admin', sessionId: 'one' }))
      .resolves.toEqual({ status: 'cancelled' });
    now += 15 * 60_000 + 1;
    await expect(auth.pollDeviceFlow({ flowId: expired.flowId, userId: 'admin', sessionId: 'two' }))
      .resolves.toMatchObject({ status: 'expired' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects cancellation after a device flow has completed', async () => {
    const store = new MemoryStore();
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 }));
    const auth = createOpenAiCodexAuth({ store, fetchFn });
    const { flowId } = await auth.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).state = 'completed';

    await expect(auth.cancelDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('does not exchange credentials when cancellation wins an in-flight device poll', async () => {
    const store = new MemoryStore();
    const starter = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await starter.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    let resolvePoll;
    const fetchFn = vi.fn(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    const polling = auth.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await auth.cancelDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    resolvePoll(jsonResponse({ authorization_code: 'code', code_verifier: 'verifier' }));

    await expect(polling).resolves.toEqual({ status: 'cancelled' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.credential).toBeNull();
  });

  it('does not resurrect a cancelled flow when an in-flight poll fails', async () => {
    const store = new MemoryStore();
    const starter = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await starter.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    let rejectPoll;
    const fetchFn = vi.fn(() => new Promise((_resolve, reject) => { rejectPoll = reject; }));
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    const polling = auth.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    const assertion = expect(polling).rejects.toThrow(/network error/i);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await auth.cancelDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    rejectPoll(new Error('network down'));

    await assertion;
    expect(store.flows.get(flowId).state).toBe('cancelled');
  });

  it('does not persist credentials when cancellation wins an in-flight token exchange', async () => {
    const store = new MemoryStore();
    const starter = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await starter.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    let resolveExchange;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ authorization_code: 'code', code_verifier: 'verifier' }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveExchange = resolve; }));
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    const polling = auth.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await auth.cancelDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    resolveExchange(jsonResponse({
      access_token: accessToken(), refresh_token: 'refresh', expires_in: 3600,
    }));

    await expect(polling).resolves.toEqual({ status: 'cancelled' });
    expect(store.credential).toBeNull();
  });

  it('exchanges an authorization code, masks status, clears codes, and completes once', async () => {
    const store = new MemoryStore();
    const start = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await start.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    const token = accessToken();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ authorization_code: 'auth-code', code_verifier: 'verifier' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: token, refresh_token: 'refresh-secret', expires_in: 3600 }));
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    const connected = await auth.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' });
    expect(connected).toEqual({ status: 'connected' });
    expect(fetchFn.mock.calls[1][0]).toBe('https://auth.openai.com/oauth/token');
    const exchangeBody = fetchFn.mock.calls[1][1].body;
    expect(exchangeBody.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    expect(exchangeBody.get('code_verifier')).toBe('verifier');
    expect(store.credential).toMatch(/^enc:v1:/);
    expect(readCredential(store).accountLabel).toBe('o***@example.com');
    expect(JSON.stringify(store.flows.get(flowId))).not.toMatch(/auth-code|verifier|refresh-secret/);

    await expect(auth.getStatus({ userId: 'admin', sessionId: 'session' })).resolves.toMatchObject({
      connected: true,
      state: 'connected',
      accountLabel: 'o***@example.com',
    });
    const serialized = JSON.stringify(await auth.getStatus({ userId: 'admin', sessionId: 'session' }));
    expect(serialized).not.toMatch(/access|refresh|acct_123|device_auth|userCode/i);

    fetchFn.mockClear();
    await expect(auth.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .resolves.toEqual({ status: 'connected' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('persists an authorized exchange across a transient failure and restart', async () => {
    const store = new MemoryStore();
    const starter = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await starter.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    const firstFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ authorization_code: 'auth-code', code_verifier: 'verifier' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'server_error' }, 503));
    const firstPoll = createOpenAiCodexAuth({ store, fetchFn: firstFetch });

    await expect(firstPoll.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .rejects.toMatchObject({ transient: true });
    expect(store.flows.get(flowId).state).toBe('authorized');
    expect(store.flows.get(flowId).authorizationCodeEnc).toMatch(/^enc:v1:/);

    const retryFetch = vi.fn().mockResolvedValue(jsonResponse({
      access_token: accessToken(), refresh_token: 'new-refresh', expires_in: 3600,
    }));
    const afterRestart = createOpenAiCodexAuth({ store, fetchFn: retryFetch });
    await expect(afterRestart.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .resolves.toEqual({ status: 'connected' });
    expect(retryFetch).toHaveBeenCalledTimes(1);
    expect(retryFetch.mock.calls[0][0]).toBe('https://auth.openai.com/oauth/token');
  });

  it('fails closed on a token without a ChatGPT account id', async () => {
    const store = new MemoryStore();
    const starter = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await starter.startDeviceFlow({ userId: 'admin', sessionId: 'session' });
    store.flows.get(flowId).nextPollAt = 0;
    const badToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`;
    const auth = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn()
        .mockResolvedValueOnce(jsonResponse({ authorization_code: 'code', code_verifier: 'verifier' }))
        .mockResolvedValueOnce(jsonResponse({ access_token: badToken, refresh_token: 'refresh', expires_in: 3600 })),
    });

    await expect(auth.pollDeviceFlow({ flowId, userId: 'admin', sessionId: 'session' }))
      .rejects.toThrow(/account/i);
    expect(store.credential).toBeNull();
    expect(store.flows.get(flowId).state).toBe('failed');
  });
});

describe('credential refresh and disconnect', () => {
  it('reuses a token that is valid beyond the refresh skew', async () => {
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: Date.now() + 120_000 });
    const fetchFn = vi.fn();
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    await expect(auth.getAccess()).resolves.toEqual({ accessToken: 'old-access', accountId: 'acct_old' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes before expiry and atomically stores the rotating refresh token', async () => {
    const now = Date.now();
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: now + 30_000 });
    const nextAccess = accessToken({ accountId: 'acct_new', email: 'new@example.com' });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      access_token: nextAccess,
      refresh_token: 'rotated-refresh',
      expires_in: 7200,
    }));
    const auth = createOpenAiCodexAuth({ store, fetchFn, now: () => now });

    await expect(auth.getAccess()).resolves.toEqual({ accessToken: nextAccess, accountId: 'acct_new' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect(init.body.get('grant_type')).toBe('refresh_token');
    expect(init.body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(init.body.get('refresh_token')).toBe('old-refresh');
    expect(readCredential(store)).toMatchObject({
      state: 'connected',
      accessToken: nextAccess,
      refreshToken: 'rotated-refresh',
      expiresAt: now + 7200_000,
      accountId: 'acct_new',
      accountLabel: 'n***@example.com',
    });
  });

  it('single-flights concurrent refreshes in one service instance', async () => {
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: 0 });
    let resolveFetch;
    const fetchFn = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    const first = auth.getAccess();
    const second = auth.getAccess();
    const third = auth.getAccess();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const nextAccess = accessToken({ accountId: 'acct_single' });
    resolveFetch(jsonResponse({ access_token: nextAccess, refresh_token: 'rotated', expires_in: 3600 }));

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { accessToken: nextAccess, accountId: 'acct_single' },
      { accessToken: nextAccess, accountId: 'acct_single' },
      { accessToken: nextAccess, accountId: 'acct_single' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rechecks under the shared store lock across service instances', async () => {
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: 0 });
    const nextAccess = accessToken({ accountId: 'acct_locked' });
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse({
      access_token: nextAccess, refresh_token: 'rotated', expires_in: 3600,
    }));
    const one = createOpenAiCodexAuth({ store, fetchFn });
    const two = createOpenAiCodexAuth({ store, fetchFn });

    await expect(Promise.all([one.getAccess(), two.getAccess()])).resolves.toEqual([
      { accessToken: nextAccess, accountId: 'acct_locked' },
      { accessToken: nextAccess, accountId: 'acct_locked' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('quarantines terminal refresh failures and never replays the token', async () => {
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: 0 });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    await expect(auth.getAccess()).rejects.toMatchObject({
      status: 401,
      code: 'invalid_grant',
      transient: false,
    });
    expect(readCredential(store)).toMatchObject({
      state: 'reconnect_required',
      accessToken: null,
      refreshToken: null,
      failureCode: 'invalid_grant',
    });
    await expect(auth.getStatus()).resolves.toEqual({
      connected: false,
      state: 'reconnect_required',
      reconnectRequired: true,
      reason: 'invalid_grant',
    });
    await expect(auth.getAccess()).rejects.toMatchObject({ status: 401 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 5xx response', () => jsonResponse({ error: 'server_error' }, 503)],
    ['a rate-limit response', () => jsonResponse({ error: 'rate_limit_exceeded' }, 429)],
    ['a temporary OAuth response', () => jsonResponse({ error: 'temporarily_unavailable' }, 400)],
    ['a network error', () => Promise.reject(new Error('offline'))],
    ['a malformed success response', () => jsonResponse({ refresh_token: 'missing-access' })],
  ])('preserves credentials after transient refresh failure from %s', async (_label, responseFactory) => {
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: 0 });
    const before = store.credential;
    const fetchFn = vi.fn().mockImplementation(responseFactory);
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    await expect(auth.getAccess()).rejects.toMatchObject({ transient: true });
    expect(store.credential).toBe(before);
    expect(readCredential(store)).toMatchObject({ refreshToken: 'old-refresh', state: 'connected' });
  });

  it('supports an explicit forced refresh for local verification', async () => {
    const store = new MemoryStore();
    seedCredential(store, { expiresAt: Date.now() + 3600_000 });
    const nextAccess = accessToken({ accountId: 'acct_forced' });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      access_token: nextAccess, refresh_token: 'forced-refresh', expires_in: 3600,
    }));
    const auth = createOpenAiCodexAuth({ store, fetchFn });

    await expect(auth.getAccess({ forceRefresh: true }))
      .resolves.toEqual({ accessToken: nextAccess, accountId: 'acct_forced' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('disconnect removes credentials and cancels pending flows', async () => {
    const store = new MemoryStore();
    seedCredential(store);
    const auth = createOpenAiCodexAuth({
      store,
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ device_auth_id: 'd', user_code: 'U', interval: 1 })),
    });
    const { flowId } = await auth.startDeviceFlow({ userId: 'admin', sessionId: 'session' });

    await expect(auth.disconnectCodex()).resolves.toEqual({ status: 'disconnected' });
    expect(store.credential).toBeNull();
    expect(store.flows.get(flowId).state).toBe('cancelled');
    await expect(auth.getStatus()).resolves.toEqual({
      connected: false, state: 'disconnected', reconnectRequired: false,
    });
  });
});
