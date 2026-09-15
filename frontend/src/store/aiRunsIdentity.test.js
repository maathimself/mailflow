import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
const { useStore } = await import('./index.js');
const { aiRuns } = await import('../utils/aiRunRegistry.js');
globalThis.window = new EventTarget();

const ctrl = () => ({ aborted: false, abort() { this.aborted = true; } });
beforeEach(() => { useStore.getState().setUser({ id: 'u1' }); useStore.getState().setLocked(false); });
afterEach(() => { aiRuns.abortAll(); mem.clear(); });

test('signing out cancels in-flight AI runs', () => {
  // An AI run outlives the message pane by design, so nothing else stops it here. Left running,
  // it would finish after logout and write the previous user's result into this device's cache.
  const run = ctrl();
  aiRuns.start('msg-1', 'summarize', run);
  useStore.getState().setUser(null);
  assert.equal(run.aborted, true);
  assert.equal(aiRuns.size, 0);
});

test('switching to a different user cancels them too', () => {
  const run = ctrl();
  aiRuns.start('msg-1', 'summarize', run);
  useStore.getState().setUser({ id: 'u2' });
  assert.equal(run.aborted, true);
});

test('locking cancels them, because that is what the lock is for', () => {
  const run = ctrl();
  aiRuns.start('msg-1', 'summarize', run);
  useStore.getState().setLocked(true);
  assert.equal(run.aborted, true);
});

test('re-setting the same user leaves runs alone', () => {
  // A refresh of the same identity is not a logout; cancelling here would lose work for nothing.
  const run = ctrl();
  aiRuns.start('msg-1', 'summarize', run);
  useStore.getState().setUser({ id: 'u1', displayName: 'Matt' });
  assert.equal(run.aborted, false);
  assert.equal(aiRuns.size, 1);
});
