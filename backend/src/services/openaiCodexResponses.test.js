import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_RESPONSES_URL,
  buildCodexRequest,
  completeCodexText,
  parseCodexSse,
  streamCodexResponses,
} from './openaiCodexResponses.js';

const encoder = new TextEncoder();

function streamResponse(chunks, { status = 200, close = true, onCancel } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' },
  });
}

function event(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('buildCodexRequest', () => {
  it('converts Chat Completions messages into stateless Responses input', () => {
    const body = buildCodexRequest({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Draft a reply.' },
        { role: 'assistant', content: 'Certainly.' },
      ],
    });

    expect(body).toEqual({
      model: 'gpt-5.4-mini',
      instructions: 'You are Mailflow, a helpful email assistant.',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Be concise.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Draft a reply.' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Certainly.' }] },
      ],
      store: false,
      stream: true,
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('rejects unsupported roles and non-string content', () => {
    expect(() => buildCodexRequest({ model: 'm', messages: [{ role: 'tool', content: 'x' }] }))
      .toThrow(/role/i);
    expect(() => buildCodexRequest({ model: 'm', messages: [{ role: 'user', content: {} }] }))
      .toThrow(/content/i);
  });
});

describe('streamCodexResponses', () => {
  it('uses the Codex endpoint and required subscription headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      event({ type: 'response.output_text.delta', delta: 'Hello' }),
      event({ type: 'response.completed', response: { status: 'completed' } }),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(collect(streamCodexResponses({
      accessToken: 'access-secret',
      accountId: 'acct_123',
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Hi' }],
    }))).resolves.toEqual(['Hello']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CODEX_RESPONSES_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer access-secret',
      'chatgpt-account-id': 'acct_123',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'mailflow',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual(buildCodexRequest({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Hi' }],
    }));
  });

  it('parses split CRLF and multi-line SSE data fields', async () => {
    const response = streamResponse([
      'data: {"type":\r\n',
      'data: "response.output_text.delta","delta":"Hel"}\r\n\r\n',
      'data: {"type":"response.output_text.delta",',
      '"delta":"lo"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]);

    await expect(collect(parseCodexSse(response))).resolves.toEqual(['Hel', 'lo']);
  });

  it('stops and cancels an upstream body that stays open after completion', async () => {
    let cancelled = false;
    const response = streamResponse([
      event({ type: 'response.output_text.delta', delta: 'done' }),
      event({ type: 'response.completed', response: { status: 'completed' } }),
    ], { close: false, onCancel: () => { cancelled = true; } });

    await expect(collect(parseCodexSse(response))).resolves.toEqual(['done']);
    expect(cancelled).toBe(true);
  });

  it.each([
    [{ type: 'response.failed', response: { error: { message: 'model unavailable' } } }, /response failed/i],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, /incomplete/i],
    [{ type: 'error', error: { message: 'rate limited' } }, /stream error/i],
  ])('turns terminal failure event %j into a sanitized error', async (terminal, message) => {
    const response = streamResponse([event(terminal)]);
    await expect(collect(parseCodexSse(response))).rejects.toThrow(message);
  });

  it('rejects malformed SSE JSON without reflecting the raw payload', async () => {
    const response = streamResponse(['data: {"access_token":"do-not-reflect"\n\n']);
    const error = await collect(parseCodexSse(response)).catch((cause) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/malformed/i);
    expect(error.message).not.toContain('do-not-reflect');
  });

  it('bounds individual SSE events', async () => {
    const response = streamResponse([`data: ${'x'.repeat(256 * 1024 + 1)}\n\n`]);
    await expect(collect(parseCodexSse(response))).rejects.toThrow(/event.*large/i);
  });

  it('bounds accumulated output text', async () => {
    const chunk = 'x'.repeat(240 * 1024);
    const response = streamResponse(Array.from(
      { length: 9 },
      () => event({ type: 'response.output_text.delta', delta: chunk }),
    ));
    await expect(collect(parseCodexSse(response))).rejects.toThrow(/output.*large/i);
  });

  it('bounds and sanitizes non-2xx response bodies', async () => {
    let cancelled = false;
    const response = streamResponse([
      JSON.stringify({ error: { message: `temporary outage ${'x'.repeat(20_000)} secret-tail` } }),
    ], { status: 503, close: false, onCancel: () => { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const error = await collect(streamCodexResponses({
      accessToken: 'access-secret',
      accountId: 'acct_123',
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
    })).catch((cause) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/503/);
    expect(error.message.length).toBeLessThan(9_000);
    expect(error.message).not.toContain('secret-tail');
    expect(error.message).not.toContain('access-secret');
    expect(cancelled).toBe(true);
  });

  it('propagates caller aborts and cancels the response reader', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(event({ type: 'response.output_text.delta', delta: 'one' })));
      },
      cancel() { cancelled = true; },
    });
    const abort = new AbortController();
    const iterable = parseCodexSse(new Response(body), { signal: abort.signal });
    const iterator = iterable[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: 'one', done: false });
    abort.abort();
    await expect(iterator.next()).rejects.toThrow(/aborted/i);
    expect(cancelled).toBe(true);
  });

  it('aborts the fetch when the response-header timeout elapses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = collect(streamCodexResponses({
      accessToken: 'token',
      accountId: 'account',
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      timeoutMs: 25,
    }));
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it('keeps the timeout active while reading the streamed response body', async () => {
    vi.useFakeTimers();
    let requestSignal;
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      requestSignal = init.signal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        },
      })));
    }));
    const pending = collect(streamCodexResponses({
      accessToken: 'token',
      accountId: 'account',
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
      timeoutMs: 25,
    }));
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(25);

    expect(requestSignal.aborted).toBe(true);
    await assertion;
  });
});

describe('completeCodexText', () => {
  it('reduces streamed text into one result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      event({ type: 'response.output_text.delta', delta: 'Hello ' }),
      event({ type: 'response.output_text.delta', delta: 'world' }),
      event({ type: 'response.completed', response: { status: 'completed' } }),
    ])));

    await expect(completeCodexText({
      accessToken: 'token',
      accountId: 'account',
      model: 'm',
      messages: [{ role: 'user', content: 'Hi' }],
    })).resolves.toBe('Hello world');
  });
});
