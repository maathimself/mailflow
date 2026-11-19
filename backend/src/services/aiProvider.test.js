import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDER_API_KEY,
  AI_PROVIDER_CHATGPT,
  MASKED_API_KEY,
  createAiProvider,
  normalizeAiConfig,
} from './aiProvider.js';

const encoder = new TextEncoder();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks, { status = 200, close = true, onCancel } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      if (close) controller.close();
    },
    cancel(reason) { onCancel?.(reason); },
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

function completionEvent(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

function memorySettings(initial) {
  const rows = new Map(initial == null ? [] : [['ai_config', JSON.stringify(initial)]]);
  // ai_config is named in the SQL; other keys (ai_new_users_enabled) come as the first parameter.
  const keyOf = (sql, params) => (sql.includes("'ai_config'") ? 'ai_config' : params[0]);
  const queryFn = vi.fn(async (sql, params = []) => {
    if (/SELECT value FROM system_settings/i.test(sql)) {
      const value = rows.get(keyOf(sql, params));
      return { rows: value == null ? [] : [{ value }] };
    }
    if (/INSERT INTO system_settings/i.test(sql)) {
      const key = keyOf(sql, params);
      rows.set(key, key === 'ai_config' ? params[0] : params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM system_settings WHERE key = 'ai_config'/i.test(sql)) {
      rows.delete('ai_config');
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return {
    queryFn,
    read: () => (rows.has('ai_config') ? JSON.parse(rows.get('ai_config')) : null),
    value: (key) => rows.get(key) ?? null,
  };
}

function factory({ initial, ...overrides } = {}) {
  const settings = memorySettings(initial);
  const deps = {
    queryFn: settings.queryFn,
    encryptFn: (value) => `encrypted:${value}`,
    decryptFn: (value) => value?.replace(/^encrypted:/, ''),
    validateHostFn: vi.fn().mockResolvedValue(null),
    getConnectionPolicyFn: vi.fn().mockResolvedValue({ allowPrivateHosts: false }),
    fetchFn: vi.fn(),
    getCodexAccessFn: vi.fn().mockResolvedValue({ accessToken: 'codex-access', accountId: 'acct_123' }),
    getCodexStatusFn: vi.fn().mockResolvedValue({ connected: true, state: 'connected' }),
    streamCodexResponsesFn: vi.fn(),
    completeCodexTextFn: vi.fn().mockResolvedValue('codex text'),
    ...overrides,
  };
  return { provider: createAiProvider(deps), settings, deps };
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('normalizeAiConfig', () => {
  it('normalizes legacy flat settings into API-key mode without changing values', () => {
    expect(normalizeAiConfig({
      enabled: true,
      baseUrl: 'http://ollama:11434/v1',
      apiKey: 'encrypted:key',
      model: 'llama3',
      features: { compose: false, summarize: true },
    })).toEqual({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: {
        baseUrl: 'http://ollama:11434/v1', apiKey: 'encrypted:key', model: 'llama3', extraHeaders: [],
      },
      chatgptConfig: { model: 'gpt-5.6-luna' },
      features: { compose: false, summarize: true },
    });
  });

  it('normalizes the new shape and defaults feature flags to enabled', () => {
    expect(normalizeAiConfig({
      enabled: false,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: 'https://api.example/v1/', apiKey: null, model: 'api-model' },
      chatgptConfig: { model: 'gpt-5.4' },
    })).toEqual({
      enabled: false,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: null, model: 'api-model', extraHeaders: [] },
      chatgptConfig: { model: 'gpt-5.4' },
      features: { compose: true, summarize: true },
    });
  });
});

// #644: "Allow AI for new users" has its own setting, so neither an older admin tab's save nor
// removing the AI configuration turns it back on.
describe('Allow AI for new users', () => {
  const API = {
    enabled: true,
    provider: AI_PROVIDER_API_KEY,
    apiKeyConfig: { baseUrl: 'https://api.example/v1', model: 'api-model' },
  };

  it('is on until saved off, and is returned with the configuration', async () => {
    const { provider, settings } = factory();
    expect(await provider.getAiNewUsersEnabled()).toBe(true);
    const saved = await provider.saveAiConfig({ ...API, newUsersEnabled: false });
    expect(saved.newUsersEnabled).toBe(false);
    expect(settings.value('ai_new_users_enabled')).toBe('false');
    expect(settings.read()).not.toHaveProperty('newUsersEnabled');
    expect((await provider.getAdminAiConfig()).newUsersEnabled).toBe(false);
    await provider.saveAiConfig({ ...API, newUsersEnabled: true });
    expect(await provider.getAiNewUsersEnabled()).toBe(true);
  });

  it('keeps the stored value when a save leaves it out or sends a non-boolean', async () => {
    const { provider } = factory();
    await provider.saveAiConfig({ ...API, newUsersEnabled: false });
    for (const newUsersEnabled of [undefined, 'true', 1, null]) {
      const saved = await provider.saveAiConfig({ ...API, newUsersEnabled });
      expect(saved.newUsersEnabled).toBe(false);
    }
    expect(await provider.getAiNewUsersEnabled()).toBe(false);
  });

  it('survives removing the AI configuration', async () => {
    const { provider } = factory();
    await provider.saveAiConfig({ ...API, newUsersEnabled: false });
    await provider.deleteAiConfig();
    expect(await provider.getAdminAiConfig()).toBeNull();
    expect(await provider.getAiNewUsersEnabled()).toBe(false);
  });

  it('is not changed by a save that fails validation', async () => {
    const { provider } = factory();
    await expect(provider.saveAiConfig({ ...API, apiKeyConfig: {}, newUsersEnabled: false })).rejects.toThrow(/required/);
    expect(await provider.getAiNewUsersEnabled()).toBe(true);
  });
});

describe('configuration persistence', () => {
  it.each([MASKED_API_KEY, ''])(
    'preserves the encrypted API key while switching to ChatGPT with input %j',
    async (apiKeyInput) => {
      const { provider, settings } = factory({
        initial: {
          enabled: true,
          provider: AI_PROVIDER_API_KEY,
          apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: 'encrypted:original-key', model: 'api-model' },
          chatgptConfig: { model: 'gpt-5.4-mini' },
          features: { compose: true, summarize: true },
        },
      });

      const saved = await provider.saveAiConfig({
        enabled: true,
        provider: AI_PROVIDER_CHATGPT,
        apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: apiKeyInput, model: 'api-model' },
        chatgptConfig: { model: 'gpt-5.4' },
        features: { compose: true, summarize: false },
      });

      expect(settings.read().apiKeyConfig.apiKey).toBe('encrypted:original-key');
      expect(saved.apiKeyConfig.apiKey).toBe(MASKED_API_KEY);
      expect(saved.provider).toBe(AI_PROVIDER_CHATGPT);
    },
  );

  it('encrypts a replacement API key and never returns it', async () => {
    const { provider, settings } = factory();
    const saved = await provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: { baseUrl: 'https://api.example/v1/', apiKey: 'new-secret', model: 'model' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    });
    expect(settings.read().apiKeyConfig.apiKey).toBe('encrypted:new-secret');
    expect(saved.apiKeyConfig.apiKey).toBe(MASKED_API_KEY);
    expect(JSON.stringify(saved)).not.toContain('new-secret');
  });

  it('rejects unknown providers and incomplete selected-provider settings', async () => {
    const { provider } = factory();
    await expect(provider.saveAiConfig({ enabled: true, provider: 'other' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: { baseUrl: '', model: '' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    })).rejects.toThrow(/base URL.*model/i);
    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: '', model: '' },
      chatgptConfig: { model: '' },
    })).rejects.toThrow(/model/i);
  });

  it('retains existing private-host policy validation for API-key URLs', async () => {
    const validateHostFn = vi.fn().mockResolvedValue('Host cannot be a private or reserved IP address');
    const getConnectionPolicyFn = vi.fn().mockResolvedValue({ allowPrivateHosts: false });
    const { provider } = factory({ validateHostFn, getConnectionPolicyFn });

    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      apiKeyConfig: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    })).rejects.toThrow(/private or reserved/i);
    expect(getConnectionPolicyFn).toHaveBeenCalledTimes(1);
    expect(validateHostFn).toHaveBeenCalledWith('127.0.0.1', { allowPrivate: false });
  });

  it('does not revalidate the inactive API-key URL when switching to ChatGPT', async () => {
    const validateHostFn = vi.fn().mockResolvedValue('Host cannot be a private or reserved IP address');
    const getConnectionPolicyFn = vi.fn().mockResolvedValue({ allowPrivateHosts: false });
    const { provider } = factory({ validateHostFn, getConnectionPolicyFn });

    await expect(provider.saveAiConfig({
      enabled: true,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'm' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    })).resolves.toMatchObject({ provider: AI_PROVIDER_CHATGPT });
    expect(getConnectionPolicyFn).not.toHaveBeenCalled();
    expect(validateHostFn).not.toHaveBeenCalled();
  });
});

describe('API-key provider regression', () => {
  const legacy = {
    enabled: true,
    baseUrl: 'https://api.example/v1',
    apiKey: 'encrypted:api-secret',
    model: 'legacy-model',
    features: { compose: true, summarize: true },
  };

  it('completes text with the legacy OpenAI-compatible request contract', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'provider text' } }],
    }));
    const { provider } = factory({ initial: legacy, fetchFn });

    await expect(provider.completeText([{ role: 'user', content: 'Hi' }], { maxTokens: 12 }))
      .resolves.toBe('provider text');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer api-secret');
    expect(JSON.parse(init.body)).toEqual({
      model: 'legacy-model',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 12,
      stream: false,
    });
  });

  it('supports providers with no API key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const { provider } = factory({ initial: { ...legacy, apiKey: null }, fetchFn });
    await provider.completeText([{ role: 'user', content: 'Hi' }]);
    expect(fetchFn.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('surfaces the finish reason when a real completion returns null content', async () => {
    // Reasoning model: all output went to reasoning, content is null (#401).
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'thinking…' } }],
    }));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }], { maxTokens: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(502);
    expect(err.expose).toBe(true);
    expect(err.message).toMatch(/empty completion \(finish_reason: length\)/);
  });

  it('rejects a malformed completion with no choices', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ notChoices: true }));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
    expect(err.message).toMatch(/invalid completion/);
    expect(err.expose).toBe(true);
  });

  it('exposes provider HTTP errors with their status and detail', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad model' } }, 400));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.expose).toBe(true);
    expect(err.message).toMatch(/AI provider error \(400\).*bad model/);
  });

  it('passes the connection test when a reasoning model returns empty content', async () => {
    // The exact #401 case: null content + finish_reason "length" must not fail
    // the connection test, and the test must use the small allowEmpty budget.
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'reasoning…' } }],
    }));
    const { provider } = factory({ initial: legacy, fetchFn });
    await expect(provider.testAiProvider()).resolves.toEqual({ ok: true });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).max_tokens).toBe(16);
  });

  it('passes the connection test against a provider that rejects unknown fields', async () => {
    // OpenAI answers an unknown top-level field with a 400 instead of ignoring it.
    const known = new Set(['model', 'messages', 'max_tokens', 'stream']);
    const fetchFn = vi.fn(async (_url, init) => {
      const unknown = Object.keys(JSON.parse(init.body)).find((key) => !known.has(key));
      return unknown
        ? jsonResponse({ error: { message: `Unrecognized request argument supplied: ${unknown}` } }, 400)
        : jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    const { provider } = factory({ initial: legacy, fetchFn });
    await expect(provider.testAiProvider()).resolves.toEqual({ ok: true });
  });

  it('keeps the provider timeout active while reading the response body', async () => {
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
    const { provider } = factory({ initial: legacy, fetchFn });
    const completion = provider.completeText([{ role: 'user', content: 'Hi' }]);
    const rejection = expect(completion).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(requestSignal.aborted).toBe(true);
    await rejection;
  });

  it('normalizes split Chat Completions SSE into text deltas', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([
      completionEvent('Hel').slice(0, 15),
      completionEvent('Hel').slice(15),
      completionEvent('lo'),
      'data: [DONE]\n\n',
    ]));
    const { provider } = factory({ initial: legacy, fetchFn });
    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .resolves.toEqual(['Hel', 'lo']);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example/v1/chat/completions');
    expect(JSON.parse(init.body)).toEqual({
      model: 'legacy-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
  });

  it('cancels the upstream stream when the caller aborts', async () => {
    let cancelled = false;
    const fetchFn = vi.fn().mockResolvedValue(sseResponse(
      [completionEvent('first')],
      { close: false, onCancel: () => { cancelled = true; } },
    ));
    const { provider } = factory({ initial: legacy, fetchFn });
    const controller = new AbortController();
    const iterator = provider.streamChat([{ role: 'user', content: 'Hi' }], {
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow(/aborted/i);
    expect(cancelled).toBe(true);
  });

  // The base URL's host is checked when it is saved; a redirect would reach one never checked.
  it('does not follow a redirect from the provider', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { Location: 'http://10.0.0.5/v1/chat/completions' } }));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
    expect(fetchFn.mock.calls[0][1].redirect).toBe('manual');
    expect(err.status).toBe(502);
    expect(err.expose).toBe(true);
    expect(err.message).toMatch(/redirected the request \(307\)/);
    const streamFn = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://10.0.0.5/' } }));
    const streaming = factory({ initial: legacy, fetchFn: streamFn }).provider;
    await expect(collect(streaming.streamChat([{ role: 'user', content: 'Hi' }]))).rejects.toThrow(/redirected the request \(302\)/);
    expect(streamFn.mock.calls[0][1].redirect).toBe('manual');
  });

  it("never reaches a redirect's target with Node's own fetch", async () => {
    const http = await import('node:http');
    const hits = [];
    const target = http.createServer((req, res) => { hits.push(req.headers.authorization); res.end('{}'); });
    await new Promise(r => target.listen(0, '127.0.0.1', r));
    const origin = http.createServer((req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/v1/chat/completions` });
      res.end();
    });
    await new Promise(r => origin.listen(0, '127.0.0.1', r));
    try {
      const { provider } = factory({
        initial: { ...legacy, baseUrl: `http://127.0.0.1:${origin.address().port}/v1` },
        fetchFn: (...args) => fetch(...args),
      });
      const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
      expect(err.message).toMatch(/redirected the request \(307\)/);
      expect(hits).toEqual([]);
    } finally {
      origin.close();
      target.close();
    }
  });

  // #401: some providers redirect within their own API. Same origin, 307/308: followed.
  it('follows a 307 or 308 within the base URL\'s origin, keeping the method, body and key', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: '/v1/chat/completions/' } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Location: 'https://api.example/v2/chat/completions' } }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'after redirect' } }] }));
    const { provider } = factory({ initial: legacy, fetchFn });

    await expect(provider.completeText([{ role: 'user', content: 'Hi' }])).resolves.toBe('after redirect');
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example/v1/chat/completions',
      'https://api.example/v1/chat/completions/',
      'https://api.example/v2/chat/completions',
    ]);
    for (const [, init] of fetchFn.mock.calls) {
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      expect(init.headers.Authorization).toBe('Bearer api-secret');
      expect(JSON.parse(init.body).messages).toEqual([{ role: 'user', content: 'Hi' }]);
    }
  });

  it('names a redirect to another origin without following it or showing its query', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { Location: 'https://eu.api.example/v1/chat/completions?token=leaky' },
    }));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(err.message).toContain('redirected the request (307) to https://eu.api.example/v1/chat/completions;');
    expect(err.message).not.toContain('leaky');
  });

  it('does not follow a same-origin 301, 302 or 303, which would drop the body', async () => {
    for (const status of [301, 302, 303]) {
      const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status, headers: { Location: '/v2/chat/completions' } }));
      const { provider } = factory({ initial: legacy, fetchFn });
      const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(err.message).toContain(`(${status}) to https://api.example/v2/chat/completions, which MailFlow does not follow`);
    }
  });

  it('stops following same-origin redirects after three', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => new Response(null, { status: 307, headers: { Location: '/v1/loop' } }));
    const { provider } = factory({ initial: legacy, fetchFn });
    const err = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch((e) => e);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/redirected the request \(307\) to https:\/\/api\.example\/v1\/loop/);
  });

  it("follows a same-origin 307 with Node's own fetch and keeps the key", async () => {
    const http = await import('node:http');
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push([req.method, req.url, req.headers.authorization]);
      if (req.url === '/v1/chat/completions') {
        res.writeHead(307, { Location: '/v1/chat/completions/' });
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.parse(body).messages[0].content } }] }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const { provider } = factory({
        initial: { ...legacy, baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
        fetchFn: (...args) => fetch(...args),
      });
      await expect(provider.completeText([{ role: 'user', content: 'echo me' }])).resolves.toBe('echo me');
      expect(hits).toEqual([
        ['POST', '/v1/chat/completions', 'Bearer api-secret'],
        ['POST', '/v1/chat/completions/', 'Bearer api-secret'],
      ]);
    } finally {
      server.close();
    }
  });

  it('bounds non-2xx provider errors without exposing the configured key', async () => {
    let cancelled = false;
    const fetchFn = vi.fn().mockResolvedValue(sseResponse(
      [JSON.stringify({ error: { message: `api-secret ${'x'.repeat(20_000)}secret-tail` } })],
      { status: 503, close: false, onCancel: () => { cancelled = true; } },
    ));
    const { provider } = factory({ initial: legacy, fetchFn });
    const error = await collect(provider.streamChat([{ role: 'user', content: 'Hi' }])).catch((cause) => cause);
    expect(error.message).toMatch(/503/);
    expect(error.message.length).toBeLessThan(9000);
    expect(error.message).not.toMatch(/secret-tail|api-secret/);
    expect(cancelled).toBe(true);
  });
});

// #746: extra request headers for a gateway in front of the provider.
describe('extra request headers', () => {
  const base = {
    enabled: true,
    provider: AI_PROVIDER_API_KEY,
    apiKeyConfig: { baseUrl: 'https://gateway.example/v1', apiKey: 'encrypted:api-secret', model: 'model' },
    chatgptConfig: { model: 'gpt-5.4' },
    features: { compose: true, summarize: true },
  };
  const withHeaders = (extraHeaders) => ({ ...base, apiKeyConfig: { ...base.apiKeyConfig, extraHeaders } });
  const save = (provider, extraHeaders, overrides = {}) => provider.saveAiConfig({
    ...base,
    apiKeyConfig: { ...base.apiKeyConfig, apiKey: MASKED_API_KEY, ...(extraHeaders === undefined ? {} : { extraHeaders }) },
    ...overrides,
  });

  it('stores values encrypted and only ever returns them masked', async () => {
    const { provider, settings } = factory({ initial: base });
    const saved = await save(provider, [{ name: 'cf-aig-authorization', value: '  Bearer gw-secret ' }]);
    expect(settings.read().apiKeyConfig.extraHeaders).toEqual([{ name: 'cf-aig-authorization', value: 'encrypted:Bearer gw-secret' }]);
    expect(saved.apiKeyConfig.extraHeaders).toEqual([{ name: 'cf-aig-authorization', value: MASKED_API_KEY }]);
    expect(JSON.stringify(saved)).not.toContain('gw-secret');
    const loaded = await provider.getAdminAiConfig();
    expect(loaded.apiKeyConfig.extraHeaders).toEqual([{ name: 'cf-aig-authorization', value: MASKED_API_KEY }]);
    expect(JSON.stringify(loaded)).not.toContain('gw-secret');
  });

  it('keeps a stored value sent back masked, matching the name in any case', async () => {
    const { provider, settings } = factory({ initial: withHeaders([{ name: 'Helicone-Auth', value: 'encrypted:h-secret' }]) });
    await save(provider, [{ name: 'helicone-auth', value: MASKED_API_KEY }, { name: 'X-Team', value: 'mail' }]);
    expect(settings.read().apiKeyConfig.extraHeaders).toEqual([
      { name: 'helicone-auth', value: 'encrypted:h-secret' },
      { name: 'X-Team', value: 'encrypted:mail' },
    ]);
  });

  it('asks for the value again when a masked header was renamed or never stored', async () => {
    const { provider, settings } = factory({ initial: withHeaders([{ name: 'X-Old', value: 'encrypted:v' }]) });
    await expect(save(provider, [{ name: 'X-New', value: MASKED_API_KEY }]))
      .rejects.toMatchObject({ status: 400, message: 'Enter a value for the X-New header' });
    expect(settings.read().apiKeyConfig.extraHeaders).toEqual([{ name: 'X-Old', value: 'encrypted:v' }]);
  });

  it('keeps the headers when a save leaves the list out, and removes them with an empty list', async () => {
    const stored = [{ name: 'X-Gateway', value: 'encrypted:g' }];
    const { provider, settings } = factory({ initial: withHeaders(stored) });
    await save(provider, undefined);
    expect(settings.read().apiKeyConfig.extraHeaders).toEqual(stored);
    await save(provider, undefined, { provider: AI_PROVIDER_CHATGPT });
    expect(settings.read().apiKeyConfig.extraHeaders).toEqual(stored);
    await save(provider, []);
    expect(settings.read().apiKeyConfig.extraHeaders).toEqual([]);
  });

  it.each([
    [[{ name: '', value: 'v' }], 'Each extra header needs a name'],
    [[{ name: 'Bad Name', value: 'v' }], '"Bad Name" is not a valid header name'],
    [[{ name: 'X:Y', value: 'v' }], '"X:Y" is not a valid header name'],
    [[{ name: 'X-Ok', value: '' }], 'Enter a value for the X-Ok header'],
    [[{ name: 'X-Ok', value: 'a\r\nInjected: yes' }], 'The value of the X-Ok header can only hold printable ASCII on one line'],
    [[{ name: 'X-Ok', value: 'café' }], 'The value of the X-Ok header can only hold printable ASCII on one line'],
    [[{ name: 'X-Ok', value: 'x'.repeat(4097) }], 'The value of the X-Ok header can only hold printable ASCII on one line'],
    [[{ name: 'X-Ok', value: 'a' }, { name: 'x-ok', value: 'b' }], 'The x-ok header is listed twice'],
    [Array.from({ length: 11 }, (_, i) => ({ name: `X-H${i}`, value: 'v' })), 'At most 10 extra headers can be added'],
    ['X-Ok: v', 'Extra headers must be a list'],
    [[null], 'Each extra header needs a name and a value'],
  ])('rejects %j', async (extraHeaders, message) => {
    const { provider, settings } = factory({ initial: base });
    await expect(save(provider, extraHeaders)).rejects.toMatchObject({ status: 400, message });
    expect(settings.read().apiKeyConfig.extraHeaders).toBeUndefined();
  });

  it.each([
    'Authorization', 'content-type', 'Content-Length', 'Host', 'Cookie', 'Transfer-Encoding',
    'Connection', 'Keep-Alive', 'TE', 'Trailer', 'Upgrade', 'Expect', 'Proxy-Authorization', 'proxy-anything',
  ])('refuses the %s header, which MailFlow owns', async (name) => {
    const { provider } = factory({ initial: base });
    await expect(save(provider, [{ name, value: 'v' }]))
      .rejects.toMatchObject({ status: 400, message: `The ${name} header is set by MailFlow and cannot be added` });
  });

  it('sends them with a completion and a stream, beside the key MailFlow sets', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
      .mockResolvedValueOnce(sseResponse([completionEvent('hi'), 'data: [DONE]\n\n']));
    const { provider } = factory({
      initial: withHeaders([{ name: 'cf-aig-authorization', value: 'encrypted:Bearer gw' }, { name: 'X-Team', value: 'encrypted:mail' }]),
      fetchFn,
    });
    await provider.completeText([{ role: 'user', content: 'Hi' }]);
    await collect(provider.streamChat([{ role: 'user', content: 'Hi' }]));
    for (const [, init] of fetchFn.mock.calls) {
      expect(init.headers).toEqual({
        'cf-aig-authorization': 'Bearer gw',
        'X-Team': 'mail',
        'Content-Type': 'application/json',
        Authorization: 'Bearer api-secret',
      });
    }
  });

  it('leaves out a stored header the rules refuse, and never lets one replace the key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const { provider } = factory({
      initial: withHeaders([{ name: 'authorization', value: 'encrypted:Bearer other' }, { name: 'X-Fine', value: 'encrypted:f' }]),
      fetchFn,
    });
    await provider.completeText([{ role: 'user', content: 'Hi' }]);
    expect(fetchFn.mock.calls[0][1].headers).toEqual({
      'X-Fine': 'f', 'Content-Type': 'application/json', Authorization: 'Bearer api-secret',
    });
  });

  it('redacts header values from provider errors, as it does the key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'gateway rejected gw-secret-value for api-secret' } }, 401));
    const { provider } = factory({ initial: withHeaders([{ name: 'X-Gateway', value: 'encrypted:gw-secret-value' }]), fetchFn });
    const error = await provider.completeText([{ role: 'user', content: 'Hi' }]).catch(cause => cause);
    expect(error.message).toMatch(/401/);
    expect(error.message).not.toMatch(/gw-secret-value|api-secret/);
    const streamFetch = vi.fn().mockResolvedValue(sseResponse([JSON.stringify({ error: { message: 'bad gw-secret-value' } })], { status: 403 }));
    const streaming = factory({ initial: withHeaders([{ name: 'X-Gateway', value: 'encrypted:gw-secret-value' }]), fetchFn: streamFetch });
    const streamError = await collect(streaming.provider.streamChat([{ role: 'user', content: 'Hi' }])).catch(cause => cause);
    expect(streamError.message).not.toMatch(/gw-secret-value/);
  });

  it('is not used by the ChatGPT provider', async () => {
    const fetchFn = vi.fn();
    const { provider, deps } = factory({
      initial: { ...withHeaders([{ name: 'X-Gateway', value: 'encrypted:g' }]), provider: AI_PROVIDER_CHATGPT },
      fetchFn,
    });
    await provider.completeText([{ role: 'user', content: 'Hi' }]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.completeCodexTextFn.mock.calls)).not.toContain('X-Gateway');
  });
});

describe('ChatGPT provider dispatch', () => {
  const chatgpt = {
    enabled: true,
    provider: AI_PROVIDER_CHATGPT,
    apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: 'encrypted:fallback-key', model: 'api-model' },
    chatgptConfig: { model: 'gpt-5.4' },
    features: { compose: true, summarize: true },
  };

  it('uses subscription credentials for completed text and never falls back to fetch', async () => {
    const completeCodexTextFn = vi.fn().mockResolvedValue('subscription text');
    const fetchFn = vi.fn();
    const { provider, deps } = factory({ initial: chatgpt, completeCodexTextFn, fetchFn });

    await expect(provider.completeText([{ role: 'user', content: 'Hi' }]))
      .resolves.toBe('subscription text');
    expect(deps.getCodexAccessFn).toHaveBeenCalledTimes(1);
    expect(completeCodexTextFn).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'codex-access', accountId: 'acct_123', model: 'gpt-5.4',
    }));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('force-refreshes and retries once when Codex rejects a cached access token', async () => {
    const unauthorized = Object.assign(new Error('rejected token'), { status: 401 });
    const completeCodexTextFn = vi.fn()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce('refreshed text');
    const getCodexAccessFn = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'stale', accountId: 'acct_123' })
      .mockResolvedValueOnce({ accessToken: 'fresh', accountId: 'acct_123' });
    const { provider } = factory({
      initial: chatgpt,
      completeCodexTextFn,
      getCodexAccessFn,
    });

    await expect(provider.completeText([{ role: 'user', content: 'Hi' }]))
      .resolves.toBe('refreshed text');
    expect(getCodexAccessFn).toHaveBeenNthCalledWith(1);
    expect(getCodexAccessFn).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(completeCodexTextFn).toHaveBeenCalledTimes(2);
    expect(completeCodexTextFn.mock.calls[1][0]).toMatchObject({ accessToken: 'fresh' });
  });

  it('force-refreshes a rejected Codex stream before any text is emitted', async () => {
    const unauthorized = Object.assign(new Error('rejected token'), { status: 401 });
    const streamCodexResponsesFn = vi.fn()
      .mockImplementationOnce(async function* rejected() { yield await Promise.reject(unauthorized); })
      .mockImplementationOnce(async function* refreshed() { yield 'fresh text'; });
    const getCodexAccessFn = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'stale', accountId: 'acct_123' })
      .mockResolvedValueOnce({ accessToken: 'fresh', accountId: 'acct_123' });
    const { provider } = factory({
      initial: chatgpt,
      streamCodexResponsesFn,
      getCodexAccessFn,
    });

    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .resolves.toEqual(['fresh text']);
    expect(getCodexAccessFn).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(streamCodexResponsesFn.mock.calls[1][0]).toMatchObject({ accessToken: 'fresh' });
  });

  it('does not replay a Codex stream after text has already been emitted', async () => {
    const unauthorized = Object.assign(new Error('late rejection'), { status: 401 });
    const streamCodexResponsesFn = vi.fn(async function* partial() {
      yield 'partial';
      throw unauthorized;
    });
    const getCodexAccessFn = vi.fn()
      .mockResolvedValue({ accessToken: 'stale', accountId: 'acct_123' });
    const { provider } = factory({
      initial: chatgpt,
      streamCodexResponsesFn,
      getCodexAccessFn,
    });

    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .rejects.toThrow(/late rejection/i);
    expect(getCodexAccessFn).toHaveBeenCalledTimes(1);
    expect(streamCodexResponsesFn).toHaveBeenCalledTimes(1);
  });

  it('streams only through Codex and propagates reconnect errors without fallback', async () => {
    async function* codexStream() { yield 'one'; yield 'two'; }
    const streamCodexResponsesFn = vi.fn(() => codexStream());
    const fetchFn = vi.fn();
    const { provider } = factory({ initial: chatgpt, streamCodexResponsesFn, fetchFn });
    await expect(collect(provider.streamChat([{ role: 'user', content: 'Hi' }])))
      .resolves.toEqual(['one', 'two']);
    expect(fetchFn).not.toHaveBeenCalled();

    const reconnect = factory({
      initial: chatgpt,
      fetchFn,
      getCodexAccessFn: vi.fn().mockRejectedValue(new Error('reconnect required')),
    }).provider;
    await expect(collect(reconnect.streamChat([{ role: 'user', content: 'Hi' }])))
      .rejects.toThrow(/reconnect/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('status and provider test', () => {
  it('reports a valid legacy API-key provider as enabled', async () => {
    const { provider } = factory({ initial: {
      enabled: true, baseUrl: 'https://api.example/v1', model: 'm', features: { compose: true },
    } });
    await expect(provider.getAiStatus()).resolves.toEqual({
      enabled: true,
      provider: AI_PROVIDER_API_KEY,
      features: { compose: true, summarize: true },
      reconnectRequired: false,
    });
  });

  it.each([
    [{ connected: false, state: 'disconnected', reconnectRequired: false }, false],
    [{ connected: false, state: 'reconnect_required', reconnectRequired: true }, true],
  ])('reflects masked ChatGPT connection state %j', async (codexStatus, reconnectRequired) => {
    const { provider } = factory({
      initial: {
        enabled: true,
        provider: AI_PROVIDER_CHATGPT,
        apiKeyConfig: { baseUrl: '', apiKey: null, model: '' },
        chatgptConfig: { model: 'gpt-5.4' },
      },
      getCodexStatusFn: vi.fn().mockResolvedValue(codexStatus),
    });
    await expect(provider.getAiStatus()).resolves.toMatchObject({
      enabled: false,
      provider: AI_PROVIDER_CHATGPT,
      reconnectRequired,
      connection: codexStatus,
    });
  });

  it('tests whichever provider is selected through completeText', async () => {
    const { provider } = factory({ initial: {
      enabled: true,
      provider: AI_PROVIDER_CHATGPT,
      apiKeyConfig: { baseUrl: '', apiKey: null, model: '' },
      chatgptConfig: { model: 'gpt-5.4' },
    } });
    await expect(provider.testAiProvider()).resolves.toEqual({ ok: true });
  });
});
