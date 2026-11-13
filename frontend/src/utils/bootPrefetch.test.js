import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { api } from './api.js';
import {
  startBootPrefetch, takeBootPrefetch, discardBootPrefetch, prefetchedOr, resetBootPrefetchForTests,
} from './bootPrefetch.js';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalCustomEvent = globalThis.CustomEvent;
const originalNow = Date.now;

let requests;
let events;
let replies; // path -> { status, body }

beforeEach(() => {
  resetBootPrefetchForTests();
  requests = [];
  events = [];
  replies = {
    '/api/auth/preferences': { status: 200, body: { theme: 'gruvbox' } },
    '/api/accounts': { status: 200, body: [{ id: 'a1' }] },
  };
  globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
  globalThis.CustomEvent = Event;
  globalThis.fetch = async (url) => {
    requests.push(url);
    const { status, body } = replies[url] ?? { status: 404, body: { error: 'not found' } };
    return { ok: status < 400, status, json: async () => body };
  };
});

afterEach(() => {
  resetBootPrefetchForTests();
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.CustomEvent = originalCustomEvent;
  Date.now = originalNow;
});

describe('boot prefetch', () => {
  it('asks for the preferences and the accounts at once, and only once per launch', async () => {
    startBootPrefetch();
    startBootPrefetch();
    // Both are sent before anything is awaited: neither waits for the other or for the session.
    assert.deepEqual(requests.sort(), ['/api/accounts', '/api/auth/preferences']);
    assert.deepEqual(await takeBootPrefetch('preferences'), { theme: 'gruvbox' });
    assert.deepEqual(await takeBootPrefetch('accounts'), [{ id: 'a1' }]);
    assert.equal(requests.length, 2);
  });

  it('hands each answer out once', async () => {
    startBootPrefetch();
    assert.ok(takeBootPrefetch('accounts'));
    assert.equal(takeBootPrefetch('accounts'), null);
    let loads = 0;
    assert.equal(await prefetchedOr('accounts', async () => { loads++; return ['fresh']; }).then(a => a[0]), 'fresh');
    assert.equal(loads, 1);
  });

  it('uses the prefetched answer instead of asking again', async () => {
    startBootPrefetch();
    let loads = 0;
    const accounts = await prefetchedOr('accounts', async () => { loads++; return []; });
    assert.deepEqual(accounts, [{ id: 'a1' }]);
    assert.equal(loads, 0);
  });

  it('a refusal raises no session or lock event, and the caller asks again the usual way', async () => {
    replies['/api/accounts'] = { status: 401, body: { error: 'Not signed in' } };
    replies['/api/auth/preferences'] = { status: 423, body: { error: 'Locked' } };
    startBootPrefetch();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(events, [], 'the prefetch itself is quiet');

    // The usual request still raises its event, as before.
    await assert.rejects(prefetchedOr('accounts', () => api.getAccounts()), { status: 401 });
    assert.deepEqual(events, ['mailflow:session_expired']);
    await assert.rejects(prefetchedOr('preferences', () => api.getPreferences()), { status: 423 });
    assert.deepEqual(events, ['mailflow:session_expired', 'mailflow:locked']);
    assert.equal(requests.filter(u => u === '/api/accounts').length, 2);
  });

  it('a failed prefetch leaves no unhandled rejection behind', async () => {
    replies['/api/accounts'] = { status: 500, body: { error: 'down' } };
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    try {
      startBootPrefetch();
      await new Promise(r => setTimeout(r, 10));
      assert.equal(unhandled, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('an answer from more than 15 seconds ago is not used', async () => {
    const t0 = originalNow();
    Date.now = () => t0;
    startBootPrefetch();
    Date.now = () => t0 + 15_001;
    assert.equal(takeBootPrefetch('preferences'), null);
    Date.now = () => t0 + 15_000;
    assert.ok(takeBootPrefetch('accounts'), 'still fresh at exactly 15 seconds');
  });

  it('nothing is used once the session was not confirmed', async () => {
    startBootPrefetch();
    discardBootPrefetch();
    assert.equal(takeBootPrefetch('preferences'), null);
    assert.equal(takeBootPrefetch('accounts'), null);
    // And a later launch step does not start a second round.
    startBootPrefetch();
    assert.equal(requests.length, 2);
  });

  it('nothing is handed out before a prefetch was started', () => {
    assert.equal(takeBootPrefetch('accounts'), null);
  });
});
