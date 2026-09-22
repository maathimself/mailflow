import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('Jev key and test APIs use session-scoped same-origin requests without a key in URLs', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ configured: true }) };
  };
  await api.getJevStatus();
  await api.saveJevKey('private-key');
  await api.removeJevKey();
  await api.getJevSamples('account-a');
  await api.testJevCondition({ field: 'jev', question: 'Invoice?', threshold: 0.8 }, ['message-a']);
  assert.deepEqual(calls.map(c => [c.options.method, c.url]), [
    ['GET', '/api/jev'], ['PUT', '/api/jev'], ['DELETE', '/api/jev'],
    ['GET', '/api/rules/jev-samples?accountId=account-a'], ['POST', '/api/rules/test-jev'],
  ]);
  assert.ok(calls.every(c => c.options.credentials === 'include' && c.options.headers[CSRF_HEADER] === CSRF_VALUE));
  assert.equal(JSON.parse(calls[1].options.body).apiKey, 'private-key');
  assert.deepEqual(JSON.parse(calls[4].options.body), { condition: { field: 'jev', question: 'Invoice?', threshold: 0.8 }, messageIds: ['message-a'] });
  assert.ok(calls.every(c => !c.url.includes('private-key')));
});
