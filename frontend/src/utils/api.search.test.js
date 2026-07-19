import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

test('search sends lexical pagination and folder parameters', async () => {
  let seen;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { seen = url; return { ok: true, json: async () => ({ messages: [] }) }; };
  try {
    await api.search('quarterly report', 'a1', { offset: 50, limit: 25, folder: 'INBOX' });
  } finally { globalThis.fetch = orig; }
  const url = new URL(seen, 'http://localhost');
  assert.equal(url.searchParams.get('q'), 'quarterly report');
  assert.equal(url.searchParams.get('accountId'), 'a1');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('folder'), 'INBOX');
});
