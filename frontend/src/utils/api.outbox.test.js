import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

test('outbox API clients use the authenticated mail endpoints', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => url.endsWith('/outbox')
        ? { pending: [{ id: 'outbox-1' }] }
        : { ok: true },
    };
  };

  try {
    assert.deepEqual(await api.cancelOutbox('outbox/1'), { ok: true });
    assert.deepEqual(await api.getOutbox(), { pending: [{ id: 'outbox-1' }] });
    assert.deepEqual(await api.listOutbox(), { pending: [{ id: 'outbox-1' }] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ url, options }) => ({
    url,
    method: options.method,
    credentials: options.credentials,
    csrf: options.headers[CSRF_HEADER],
  })), [
    {
      url: '/api/mail/outbox/outbox%2F1/cancel',
      method: 'POST',
      credentials: 'include',
      csrf: CSRF_VALUE,
    },
    {
      url: '/api/mail/outbox',
      method: 'GET',
      credentials: 'include',
      csrf: CSRF_VALUE,
    },
    {
      url: '/api/mail/outbox',
      method: 'GET',
      credentials: 'include',
      csrf: CSRF_VALUE,
    },
  ]);
});

test('API errors retain HTTP status for too-late undo handling', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'already_sent' }),
  });

  try {
    await assert.rejects(
      api.cancelOutbox('outbox-1'),
      error => error.message === 'already_sent' && error.status === 409,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
