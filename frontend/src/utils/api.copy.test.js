import test from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

test('copy uses the shared request client and emits the lock event on 423', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalCustomEvent = globalThis.CustomEvent;
  const events = [];
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  globalThis.CustomEvent = Event;
  try {
    let call;
    globalThis.fetch = async (url, opts) => {
      call = { url, opts };
      return { ok: true, json: async () => ({ copied: true }) };
    };
    assert.deepEqual(await api.copyMessage('m/1', 'Projects'), { copied: true });
    assert.equal(call.url, '/api/mail/messages/m%2F1/copy');
    assert.equal(call.opts.method, 'POST');
    assert.equal(call.opts.headers[CSRF_HEADER], CSRF_VALUE);
    assert.deepEqual(JSON.parse(call.opts.body), { folder: 'Projects' });

    globalThis.fetch = async () => ({ ok: false, status: 423, json: async () => ({ error: 'Locked' }) });
    await assert.rejects(api.copyMessage('m/1', 'Projects'), /Locked/);
    assert.deepEqual(events, ['mailflow:locked']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    globalThis.CustomEvent = originalCustomEvent;
  }
});
