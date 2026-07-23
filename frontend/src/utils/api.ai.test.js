import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE, streamAiChat } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ChatGPT authorization API', () => {
  it('uses the admin Codex lifecycle routes with CSRF-aware requests', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await api.ai.codex.start();
    await api.ai.codex.poll('flow-123');
    await api.ai.codex.status();
    await api.ai.codex.cancel('flow-123');
    await api.ai.codex.disconnect();

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/admin/ai/codex/device', 'POST'],
      ['/api/admin/ai/codex/device/poll', 'POST'],
      ['/api/admin/ai/codex/status', 'GET'],
      ['/api/admin/ai/codex/device', 'DELETE'],
      ['/api/admin/ai/codex', 'DELETE'],
    ]);
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(calls[1][1].body, JSON.stringify({ flowId: 'flow-123' }));
    assert.equal(calls[3][1].body, JSON.stringify({ flowId: 'flow-123' }));
  });

  it('streams AI text deltas through the shared API client', async () => {
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return new Response([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const updates = [];

    await assert.doesNotReject(async () => {
      const text = await streamAiChat([{ role: 'user', content: 'Draft a reply' }], {
        onDelta: (value) => updates.push(value),
      });
      assert.equal(text, 'Hello world');
    });
    assert.equal(request.url, '/api/ai/chat');
    assert.equal(request.init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(request.init.body, JSON.stringify({
      messages: [{ role: 'user', content: 'Draft a reply' }],
    }));
    assert.deepEqual(updates, ['Hello ', 'Hello world']);
  });

  it('rejects streamed error frames instead of completing partial output', async () => {
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
      'data: {"error":"AI request failed"}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    const updates = [];

    await assert.rejects(
      streamAiChat([{ role: 'user', content: 'Draft a reply' }], {
        onDelta: (text) => updates.push(text),
      }),
      /AI request failed/,
    );
    assert.deepEqual(updates, ['Partial']);
  });
});
