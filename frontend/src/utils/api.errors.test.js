import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('API error propagation', () => {
  it('attaches the stable error code from the response body', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'This message is already being sent', code: 'send_in_progress' }),
    });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.message, 'This message is already being sent');
      assert.equal(err.code, 'send_in_progress');
      return true;
    });
  });

  it('leaves code unset when the response has none', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Boom' }) });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.message, 'Boom');
      assert.equal(Object.hasOwn(err, 'code'), false);
      return true;
    });
  });

  it('falls back to a generic message for a non-JSON body', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json'); } });

    await assert.rejects(api.getIntegrationsStatus(), (err) => {
      assert.equal(err.message, 'Request failed');
      assert.equal(err.code, undefined);
      return true;
    });
  });
});
