import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('personal API tokens API (#617)', () => {
  it('lists, creates and revokes through the session routes, with the CSRF header', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const body = { name: 'MCP server', scopes: ['read', 'draft'], expiresInDays: 90, totpCode: '123456' };

    await api.apiTokens.list();
    await api.apiTokens.create(body);
    await api.apiTokens.revoke('7f3c5a52-2f1e-4f0e-9c1a-3b2d4e5f6a7b');

    assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
      ['/api/api-tokens', 'GET'],
      ['/api/api-tokens', 'POST'],
      ['/api/api-tokens/7f3c5a52-2f1e-4f0e-9c1a-3b2d4e5f6a7b', 'DELETE'],
    ]);
    for (const [, init] of calls) assert.equal(init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(calls[0][1].body, undefined);
    assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
    assert.equal(calls[1][1].body, JSON.stringify(body));
  });

  it('keeps an id inside its own path segment', async () => {
    let requested;
    globalThis.fetch = async (url) => { requested = url; return { ok: true, json: async () => ({ ok: true }) }; };
    await api.apiTokens.revoke('../admin/users');
    assert.equal(requested, '/api/api-tokens/..%2Fadmin%2Fusers');
  });

  it('a refused creation rejects with the server error text and status', async () => {
    globalThis.fetch = async () => ({
      ok: false, status: 400, json: async () => ({ error: 'Confirm with your current two-factor code', reauth: 'totp' }),
    });
    await assert.rejects(
      api.apiTokens.create({ name: 'x', scopes: ['read'], expiresInDays: 30 }),
      (err) => err.message === 'Confirm with your current two-factor code' && err.status === 400,
    );
  });
});
