import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-a';
const SERVER_REPLY = { ok: true, endSessionUrl: 'https://idp.example.com/end-session' };

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalCustomEvent = globalThis.CustomEvent;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

let requests;
let unsubscribeCalls;

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function browserWith(subscription) {
  return { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }) } };
}

function liveSubscription(unsubscribe = async () => true) {
  return {
    endpoint: ENDPOINT,
    unsubscribe: () => { unsubscribeCalls++; return unsubscribe(); },
  };
}

beforeEach(() => {
  requests = [];
  unsubscribeCalls = 0;
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = Event;
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, opts });
    return { ok: true, json: async () => SERVER_REPLY };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.CustomEvent = originalCustomEvent;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
});

describe('api.logout and this browser\'s push subscription', () => {
  it('sends the endpoint with the sign-out and ends the browser subscription', async () => {
    setNavigator(browserWith(liveSubscription()));

    assert.deepEqual(await api.logout(), SERVER_REPLY);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/auth/logout');
    assert.equal(requests[0].opts.method, 'POST');
    assert.equal(requests[0].opts.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(requests[0].opts.body, JSON.stringify({ pushEndpoint: ENDPOINT }));
    assert.equal(unsubscribeCalls, 1);
  });

  it('signs out with no body when this browser holds no subscription', async () => {
    const browsers = {
      'no service worker (plain http)': {},
      'worker never registered': { serviceWorker: { getRegistration: async () => undefined } },
      'no PushManager (Android WebView)': { serviceWorker: { getRegistration: async () => ({}) } },
      'push never enabled': browserWith(null),
    };
    for (const [name, browser] of Object.entries(browsers)) {
      requests = [];
      setNavigator(browser);
      assert.deepEqual(await api.logout(), SERVER_REPLY, name);
      assert.equal(requests.length, 1, name);
      assert.equal(requests[0].url, '/api/auth/logout', name);
      assert.equal(requests[0].opts.body, undefined, name);
    }
  });

  it('still signs out when the subscription cannot be read', async () => {
    const failing = {
      'getRegistration rejects': { serviceWorker: { getRegistration: async () => { throw new Error('SecurityError'); } } },
      'getSubscription rejects': { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => { throw new Error('AbortError'); } } }) } },
    };
    for (const [name, browser] of Object.entries(failing)) {
      requests = [];
      setNavigator(browser);
      assert.deepEqual(await api.logout(), SERVER_REPLY, name);
      assert.equal(requests.length, 1, name);
      assert.equal(requests[0].opts.body, undefined, name);
    }
  });

  it('does not wait for the push service to confirm the unsubscribe', async () => {
    setNavigator(browserWith(liveSubscription(() => new Promise(() => {}))));

    let timer;
    const outcome = await Promise.race([
      api.logout(),
      new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 1000); }),
    ]);
    clearTimeout(timer);
    assert.deepEqual(outcome, SERVER_REPLY);
    assert.equal(unsubscribeCalls, 1);
  });

  it('still rejects when the server refuses the sign-out, and the subscription is still ended', async () => {
    setNavigator(browserWith(liveSubscription(async () => { throw new Error('push service unreachable'); })));
    globalThis.fetch = async (url, opts) => {
      requests.push({ url, opts });
      return { ok: false, status: 500, json: async () => ({ error: 'Logout failed' }) };
    };

    await assert.rejects(api.logout(), /Logout failed/);
    assert.equal(requests.length, 1);
    assert.equal(unsubscribeCalls, 1);
  });
});

describe('api.unlock and this browser\'s push subscription', () => {
  const tick = () => new Promise(r => setTimeout(r, 0));

  it('ends the subscription after a PIN lockout, which signs out without api.logout()', async () => {
    setNavigator(browserWith(liveSubscription(() => new Promise(() => {}))));
    const events = [];
    globalThis.window = { dispatchEvent: event => events.push(event.type) };
    globalThis.fetch = async () => ({
      ok: false, status: 401, json: async () => ({ error: 'Too many attempts', signedOut: true }),
    });

    // unsubscribe() never settles here, and the lockout must still route to sign-in.
    let timer;
    const outcome = await Promise.race([
      api.unlock('0000').then(() => 'resolved', err => err),
      new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 1000); }),
    ]);
    clearTimeout(timer);
    assert.equal(outcome?.signedOut, true, `expected the signed-out rejection, got ${outcome}`);
    assert.deepEqual(events, ['mailflow:session_expired']);
    await tick();
    assert.equal(unsubscribeCalls, 1);
  });

  it('leaves the subscription alone after a wrong PIN or a successful unlock', async () => {
    setNavigator(browserWith(liveSubscription()));
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Incorrect PIN' }) });
    await assert.rejects(api.unlock('0000'), /Incorrect PIN/);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    assert.deepEqual(await api.unlock('1234'), { ok: true });
    await tick();
    assert.equal(unsubscribeCalls, 0);
  });
});
