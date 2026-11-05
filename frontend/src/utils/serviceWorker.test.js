// #689: a push about one message gets Mark as read / Archive buttons, which run without opening
// the app and fall back to opening it at the message when they can't.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';

// Load sw.js against a fake service worker scope. `respond(path, init)` answers fetch.
function loadWorker(respond = () => ({ ok: true, json: async () => ({}) })) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const fetches = [];
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: async (title, options) => { shown.push(JSON.parse(JSON.stringify({ title, options }))); } },
    clients: { matchAll: async () => [], openWindow: async url => { opened.push(url); } },
    location: { origin: 'https://mail.example' },
  };
  const fetch = async (path, init) => {
    fetches.push({ path, ...init, body: JSON.parse(init.body) });
    const res = respond(path, init);
    if (res instanceof Error) throw res;
    return res;
  };
  // No indexedDB: storePendingDeepLink's guard resolves at once. What the fakes record is copied
  // through JSON, so it compares as plain objects of this realm.
  vm.runInNewContext(SOURCE, { self, fetch, URL, JSON, Promise, Array, encodeURIComponent });
  const run = async (type, event) => {
    let done = Promise.resolve();
    listeners[type]({ ...event, waitUntil: p => { done = p; } });
    await done;
  };
  return { run, shown, opened, fetches };
}

const push = payload => ({ data: { json: () => payload } });
const click = (action, data) => ({ action, notification: { data, close() {} } });

test('a push about one message offers the two actions; a summary card offers none', async () => {
  const sw = loadWorker();
  await sw.run('push', push({ title: 'Ann', body: 'Hi', url: `/?m=${ID}`, messageId: ID }));
  await sw.run('push', push({ title: 'Bob', body: '2 new messages', url: `/?m=${ID}` }));
  assert.deepEqual(sw.shown[0].options.actions.map(a => a.action), ['read', 'archive']);
  assert.deepEqual(sw.shown[0].options.data, { url: `/?m=${ID}`, messageId: ID });
  assert.equal(sw.shown[1].options.actions, undefined);
});

test('Mark as read marks the message read without opening the app', async () => {
  const sw = loadWorker();
  await sw.run('notificationclick', click('read', { url: `/?m=${ID}`, messageId: ID }));
  assert.equal(sw.fetches.length, 1);
  assert.deepEqual(
    { path: sw.fetches[0].path, method: sw.fetches[0].method, body: sw.fetches[0].body },
    { path: `/api/mail/messages/${ID}/read`, method: 'PATCH', body: { read: true } },
  );
  assert.equal(sw.fetches[0].credentials, 'include');
  assert.equal(sw.fetches[0].headers['X-Requested-With'], 'MailFlow');
  assert.deepEqual(sw.opened, []);
});

test('Archive archives the message without opening the app', async () => {
  const sw = loadWorker(() => ({ ok: true, json: async () => ({ ok: true, archived: [ID], noArchiveFolder: [] }) }));
  await sw.run('notificationclick', click('archive', { url: `/?m=${ID}`, messageId: ID }));
  assert.deepEqual(
    { path: sw.fetches[0].path, method: sw.fetches[0].method, body: sw.fetches[0].body },
    { path: '/api/mail/messages/bulk-archive', method: 'POST', body: { ids: [ID] } },
  );
  assert.deepEqual(sw.opened, []);
  assert.deepEqual(sw.shown, []);
});

test('Archive on an account with no Archive folder says so instead of doing nothing', async () => {
  const sw = loadWorker(() => ({ ok: true, json: async () => ({ ok: true, archived: [], noArchiveFolder: ['acc'] }) }));
  await sw.run('notificationclick', click('archive', { url: `/?m=${ID}`, messageId: ID }));
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Not archived');
  assert.deepEqual(sw.shown[0].options.data, { url: `/?m=${ID}` });
  assert.deepEqual(sw.opened, []);
});

for (const [name, response] of [
  ['signed out', { ok: false, status: 401 }],
  ['screen locked', { ok: false, status: 423 }],
  ['offline', new Error('network')],
]) {
  test(`an action that can't run (${name}) opens the app at the message`, async () => {
    const sw = loadWorker(() => response);
    await sw.run('notificationclick', click('read', { url: `/?m=${ID}`, messageId: ID }));
    assert.deepEqual(sw.opened, [`/?m=${ID}`]);
  });
}

test('a plain tap opens the message as before, and sends nothing', async () => {
  const sw = loadWorker();
  await sw.run('notificationclick', click('', { url: `/?m=${ID}`, messageId: ID }));
  assert.deepEqual(sw.fetches, []);
  assert.deepEqual(sw.opened, [`/?m=${ID}`]);
});
