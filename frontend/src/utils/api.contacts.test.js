import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { api } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('contacts API', () => {
  it('passes a CardDAV source filter through the shared request client', async () => {
    let requestedUrl;
    globalThis.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ contacts: [] }) };
    };

    await api.getContacts({ q: 'casey', limit: 30, offset: 0, source: 'carddav' });
    assert.equal(requestedUrl, '/api/contacts?q=casey&limit=30&offset=0&source=carddav');
  });
});
