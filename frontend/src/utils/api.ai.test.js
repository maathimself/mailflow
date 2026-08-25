import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE, streamAiChat } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ChatGPT authorization API', () => {
  it('persists exact per-row keys across mixed bulk retries and clears only completed rows', async () => {
    const calls = [];
    const responses = [
      { archived: ['done-row'] },
      { archived: ['old-row', 'new-row'] },
      { archived: ['done-row'] },
    ];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => responses.shift() };
    };

    await api.bulkArchive(['old-row', 'done-row']);
    await api.bulkArchive(['old-row', 'new-row']);
    await api.bulkArchive(['done-row']);

    const bodies = calls.map(([, init]) => JSON.parse(init.body));
    assert.equal(bodies[1].operationKeys['old-row'], bodies[0].operationKeys['old-row']);
    assert.notEqual(bodies[1].operationKeys['new-row'], bodies[0].operationKeys['old-row']);
    assert.notEqual(bodies[2].operationKeys['done-row'], bodies[0].operationKeys['done-row']);
  });

  it('sends per-row operation maps for bulk delete and move', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      const body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => (url.endsWith('bulk-delete')
          ? { deleted: body.ids }
          : { moved: body.ids }),
      };
    };

    await api.bulkDelete(['delete-row']);
    await api.bulkMove(['move-row'], 'Archive');

    const bodies = calls.map(([, init]) => JSON.parse(init.body));
    assert.equal(typeof bodies[0].operationKeys['delete-row'], 'string');
    assert.equal(typeof bodies[1].operationKeys['move-row'], 'string');
  });

  it('uses the durable per-row delete map for MessageList unload keepalive', async () => {
    let call;
    globalThis.fetch = async (url, init) => {
      call = { url, init };
      return { ok: true };
    };

    await api.bulkDeleteKeepalive(['unload-row']);

    assert.equal(call.url, '/api/mail/messages/bulk-delete');
    assert.equal(call.init.keepalive, true);
    assert.equal(typeof JSON.parse(call.init.body).operationKeys['unload-row'], 'string');
  });

  it('canonicalizes uppercase UUIDs in requests and clears their durable key after success', async () => {
    const calls = [];
    const upper = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
    const lower = upper.toLowerCase();
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ archived: [lower] }) };
    };

    await api.bulkArchive([upper]);
    await api.bulkArchive([upper]);

    const bodies = calls.map(([, init]) => JSON.parse(init.body));
    assert.deepEqual(bodies[0].ids, [lower]);
    assert.deepEqual(Object.keys(bodies[0].operationKeys), [lower]);
    assert.notEqual(bodies[1].operationKeys[lower], bodies[0].operationKeys[lower]);
  });

  it('rejects case-variant duplicate UUIDs before any bulk request', async () => {
    let calls = 0;
    const upper = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => ({ moved: [] }) };
    };

    await assert.rejects(
      api.bulkMove([upper, upper.toLowerCase()], 'Archive'),
      /duplicate row ids/i,
    );
    assert.equal(calls, 0);
  });

  it('sends the caller\'s durable key with each logical draft save', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ uid: 1, folder: 'Drafts' }) };
    };

    await api.saveDraft({ subject: 'same' }, 'draft-save-1');
    await api.saveDraft({ subject: 'same' }, 'draft-save-2');

    assert.deepEqual(calls.map(([, init]) => init.headers['X-Idempotency-Key']), [
      'draft-save-1', 'draft-save-2',
    ]);
  });

  it('reuses one classify lifecycle key after failure and rotates it after success', async () => {
    const keys = [];
    let fail = true;
    globalThis.fetch = async (_url, init) => {
      keys.push(init.headers['X-Idempotency-Key']);
      if (fail) {
        fail = false;
        return { ok: false, status: 500, json: async () => ({ error: 'retry' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await assert.rejects(api.gtdClassify('row-1', 'todo'), /retry/);
    await api.gtdClassify('row-1', 'todo');
    await api.gtdClassify('row-1', 'todo');

    assert.equal(keys[1], keys[0]);
    assert.notEqual(keys[2], keys[1]);
  });

  it('reuses a Done lifecycle key through incomplete and failed retries, then rotates after completion', async () => {
    const keys = [];
    const responses = [
      { ok: true, json: async () => ({ ok: false, phase: 'archive', inboxCleared: false }) },
      { ok: false, status: 500, json: async () => ({ error: 'label failed', phase: 'labels', inboxCleared: true }) },
      { ok: true, json: async () => ({ ok: true, phase: 'completed', inboxCleared: true }) },
      { ok: true, json: async () => ({ ok: true, phase: 'completed', inboxCleared: true }) },
    ];
    globalThis.fetch = async (_url, init) => {
      keys.push(init.headers['X-Idempotency-Key']);
      return responses.shift();
    };

    await api.gtdDone('row-1', ['watch']);
    const error = await api.gtdDone('row-1', ['watch']).catch(value => value);
    assert.equal(error.phase, 'labels');
    assert.equal(error.inboxCleared, true);
    await api.gtdDone('row-1', ['watch']);
    await api.gtdDone('row-1', ['watch']);

    assert.equal(keys[1], keys[0]);
    assert.equal(keys[2], keys[1]);
    assert.notEqual(keys[3], keys[2]);
  });

  it('rotates a Done lifecycle after a terminal missing-Archive configuration error', async () => {
    const keys = [];
    const responses = [
      {
        ok: false,
        status: 409,
        json: async () => ({
          error: 'Archive unavailable', code: 'GTD_DONE_ARCHIVE_UNAVAILABLE', retryable: false,
        }),
      },
      { ok: true, json: async () => ({ ok: true, phase: 'completed', inboxCleared: true }) },
    ];
    globalThis.fetch = async (_url, init) => {
      keys.push(init.headers['X-Idempotency-Key']);
      return responses.shift();
    };

    await assert.rejects(api.gtdDone('row-missing-archive'), /Archive unavailable/);
    await api.gtdDone('row-missing-archive');

    assert.notEqual(keys[1], keys[0]);
  });

  it('rotates Done lifecycles for terminal frozen-provider capability failures', async () => {
    for (const [index, code] of [
      'FOLDER_OBSERVATION_UNSAFE',
      'FOLDER_OBSERVATION_SUPERSEDED',
      'PROVIDER_NATIVE_MOVE_UNSUPPORTED',
      'PROVIDER_RECOVERY_MARKER_UNSUPPORTED',
    ].entries()) {
      const keys = [];
      const responses = [
        { ok: false, status: 500, json: async () => ({ error: code, code, retryable: false }) },
        { ok: true, json: async () => ({ ok: true, phase: 'completed' }) },
      ];
      globalThis.fetch = async (_url, init) => {
        keys.push(init.headers['X-Idempotency-Key']);
        return responses.shift();
      };
      const rowId = `provider-terminal-${index}`;
      await assert.rejects(api.gtdDone(rowId), new RegExp(code));
      await api.gtdDone(rowId);
      assert.notEqual(keys[1], keys[0]);
    }
  });

  it('retains the Done lifecycle for a transient provider transport failure', async () => {
    const keys = [];
    const responses = [
      { ok: false, status: 500, json: async () => ({ error: 'timeout', code: 'ETIMEDOUT', retryable: true }) },
      { ok: true, json: async () => ({ ok: true, phase: 'completed' }) },
    ];
    globalThis.fetch = async (_url, init) => {
      keys.push(init.headers['X-Idempotency-Key']);
      return responses.shift();
    };

    await assert.rejects(api.gtdDone('provider-transient'), /timeout/);
    await api.gtdDone('provider-transient');
    assert.equal(keys[1], keys[0]);
  });

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
