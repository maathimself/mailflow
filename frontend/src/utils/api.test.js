import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

describe('compose session API', () => {
  let originalFetch;
  let requests;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the exact JSON contracts and safely encodes route identifiers', async () => {
    await api.composeSessions.list();
    await api.composeSessions.create({ requestedSlot: 2 });
    await api.composeSessions.claimDraft({ accountId: 'account-1', uid: 9 });
    await api.composeSessions.get('session/one');
    await api.composeSessions.patch('session/one', 3, { subject: 'Synthetic subject' }, 'client-1');
    await api.composeSessions.presentation('session/one', 4, 'minimized', 'client-1');
    const finalChanges = {
      subject: 'Synthetic final subject',
      body: 'Synthetic final body',
    };
    await api.composeSessions.close('session/one', 5, finalChanges);
    await api.composeSessions.discard('session/one', 6);
    await api.composeSessions.send(
      'session/one',
      7,
      { undoSendSeconds: 30 },
      { 'X-Idempotency-Key': 'synthetic-request-1' },
    );
    await api.composeSessions.restoreQueuedSend('outbox/one');
    await api.composeSessions.removeAttachment('session/one', 'attachment/one', 8);

    assert.deepEqual(requests.map(({ url, options }) => ({
      url,
      method: options.method,
      credentials: options.credentials,
      csrf: options.headers[CSRF_HEADER],
      contentType: options.headers['Content-Type'],
      idempotencyKey: options.headers['X-Idempotency-Key'],
      body: options.body,
    })), [
      { url: '/api/compose-sessions', method: 'GET', credentials: 'include', csrf: CSRF_VALUE, contentType: undefined, idempotencyKey: undefined, body: undefined },
      { url: '/api/compose-sessions', method: 'POST', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({ requestedSlot: 2 }) },
      { url: '/api/compose-sessions/claim-draft', method: 'POST', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({ accountId: 'account-1', uid: 9 }) },
      { url: '/api/compose-sessions/session%2Fone', method: 'GET', credentials: 'include', csrf: CSRF_VALUE, contentType: undefined, idempotencyKey: undefined, body: undefined },
      { url: '/api/compose-sessions/session%2Fone', method: 'PATCH', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({ expectedRevision: 3, changes: { subject: 'Synthetic subject' }, clientId: 'client-1' }) },
      { url: '/api/compose-sessions/session%2Fone/presentation', method: 'PUT', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({ expectedRevision: 4, state: 'minimized', clientId: 'client-1' }) },
      { url: '/api/compose-sessions/session%2Fone/close', method: 'POST', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({ expectedRevision: 5, changes: finalChanges }) },
      { url: '/api/compose-sessions/session%2Fone/discard', method: 'POST', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({ expectedRevision: 6 }) },
      { url: '/api/compose-sessions/session%2Fone/send', method: 'POST', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: 'synthetic-request-1', body: JSON.stringify({ expectedRevision: 7, undoSendSeconds: 30 }) },
      { url: '/api/compose-sessions/outbox/outbox%2Fone/restore', method: 'POST', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({}) },
      { url: '/api/compose-sessions/session%2Fone/attachments/attachment%2Fone', method: 'DELETE', credentials: 'include', csrf: CSRF_VALUE, contentType: 'application/json', idempotencyKey: undefined, body: JSON.stringify({ expectedRevision: 8 }) },
    ]);
  });

  it('uploads raw bytes with authentication and attachment metadata headers', async () => {
    const file = new File(
      [new Uint8Array([1, 2, 3])],
      'synthetic résumé.pdf',
      { type: 'application/pdf' },
    );

    await api.composeSessions.uploadAttachment('session/one', 9, file, 'client-1');

    assert.equal(requests.length, 1);
    const [{ url, options }] = requests;
    assert.equal(url, '/api/compose-sessions/session%2Fone/attachments');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'include');
    assert.equal(options.body, file);
    assert.equal(options.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(options.headers['X-Mailflow-Filename'], encodeURIComponent(file.name));
    assert.equal(options.headers['X-Mailflow-Content-Type'], 'application/pdf');
    assert.equal(options.headers['X-Mailflow-Expected-Revision'], '9');
    assert.equal(options.headers['X-Mailflow-Client-Id'], 'client-1');
  });

  it('uses the binary content-type fallback without leaking file content', async () => {
    const file = new File([new Uint8Array([4, 5])], 'synthetic.bin');

    await api.composeSessions.uploadAttachment('session-1', 1, file);

    assert.equal(requests[0].options.headers['X-Mailflow-Content-Type'], 'application/octet-stream');
    assert.equal(requests[0].options.headers['X-Mailflow-Client-Id'], undefined);
  });
});

describe('shared API errors', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retains the structured status, code, and complete response details', async () => {
    const details = {
      error: 'Revision conflict',
      code: 'compose_revision_conflict',
      currentRevision: 12,
      current: { id: 'synthetic-session', revision: 12 },
    };
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => details,
    });

    await assert.rejects(
      api.composeSessions.get('synthetic-session'),
      error => {
        assert.equal(error.message, 'Revision conflict');
        assert.equal(error.status, 409);
        assert.equal(error.code, 'compose_revision_conflict');
        assert.deepEqual(error.details, details);
        return true;
      },
    );
  });

  it('leaves network failures distinguishable from structured HTTP failures', async () => {
    const networkError = new TypeError('fetch failed');
    globalThis.fetch = async () => { throw networkError; };

    await assert.rejects(
      api.composeSessions.list(),
      error => error === networkError
        && error.status === undefined
        && error.code === undefined
        && error.details === undefined,
    );
  });
});
