import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

test('search adds mode only for a non-default semantic mode', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(url); return { ok: true, json: async () => ({ messages: [] }) }; };
  try {
    await api.search('hi', undefined, {});
    await api.search('hi', undefined, { mode: 'lexical' });
    await api.search('hi', undefined, { mode: 'hybrid' });
  } finally { globalThis.fetch = orig; }
  assert.ok(!seen[0].includes('mode='), 'no mode when absent');
  assert.ok(!seen[1].includes('mode='), 'no mode when lexical');
  assert.ok(seen[2].includes('mode=hybrid'), 'mode=hybrid present');
});
