import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposeSwitch } from './composeSwitch.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('pristine switch does not save', async () => {
  let value = 'a'; let calls = 0;
  const c = createComposeSwitch({ snapshot: () => value, save: async () => { calls++; return true; } });
  c.markSaved();
  assert.equal(await c.prepare(), true);
  assert.equal(calls, 0);
});

test('edit during in-flight save requires a second save before switch', async () => {
  let value = 'a'; const first = deferred(); const calls = [];
  const c = createComposeSwitch({ snapshot: () => value, save: async s => { calls.push(s); return calls.length === 1 ? first.promise : true; } });
  c.markSaved(); value = 'b';
  const preparing = c.prepare();
  value = 'c'; first.resolve(true);
  assert.equal(await preparing, true);
  assert.deepEqual(calls, ['b', 'c']);
  assert.equal(c.isDirty(), false);
});

test('failed save keeps the old composer dirty', async () => {
  let value = 'a';
  const c = createComposeSwitch({ snapshot: () => value, save: async () => false });
  c.markSaved(); value = 'b';
  assert.equal(await c.prepare(), false);
  assert.equal(c.isDirty(), true);
});

test('unsupported attachment blocks a dirty switch without saving', async () => {
  let value = 'a'; let calls = 0;
  const c = createComposeSwitch({ snapshot: () => value, unsupported: () => true, save: async () => { calls++; return true; } });
  c.markSaved(); value = 'b';
  assert.equal(await c.prepare(), false);
  assert.equal(calls, 0);
});

test('an explicit save may keep text while attachments stay only in the open editor', async () => {
  let value = 'a'; const calls = [];
  const c = createComposeSwitch({ snapshot: () => value, unsupported: () => true,
    save: async s => { calls.push(s); return true; } });
  c.markSaved(); value = 'b';
  assert.equal(await c.save({ allowUnsupported: true }), true);
  assert.deepEqual(calls, ['b']);
  assert.equal(c.isDirty(), false);
});

test('concurrent switches and manual save serialize one write at a time', async () => {
  let value = 'a'; const first = deferred(); const calls = [];
  const c = createComposeSwitch({ snapshot: () => value, save: async s => { calls.push(s); if (calls.length === 1) await first.promise; return true; } });
  c.markSaved(); value = 'b';
  const manual = c.save(); const switchB = c.prepare();
  value = 'c'; const switchC = c.prepare();
  first.resolve();
  assert.deepEqual(await Promise.all([manual, switchB, switchC]), [true, true, true]);
  assert.deepEqual(calls, ['b', 'c']);
});
