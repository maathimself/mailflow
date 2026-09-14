import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const store_ = new Map();
globalThis.localStorage = {
  getItem: k => (store_.has(k) ? store_.get(k) : null),
  setItem: (k, v) => store_.set(k, String(v)),
  removeItem: k => store_.delete(k),
};
const { useStore } = await import('./index.js');
const { startRun, getRuns, abortAllRuns } = await import('../aiRuns.js');
const { getResults } = await import('../aiResults.js');
globalThis.window = new EventTarget();

// A model call that never settles on its own; the test inspects its abort signal.
function pendingRun(signals) {
  return (signal) => { signals.push(signal); return new Promise(() => {}); };
}

beforeEach(() => { useStore.getState().setUser({ id: 'u1' }); useStore.getState().setLocked(false); });
afterEach(() => { abortAllRuns(); store_.clear(); });

test('logout aborts every background AI run', async () => {
  const signals = [];
  startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run: pendingRun(signals) });
  startRun({ messageId: 'm2', key: 'summarize', label: 'Summary', run: pendingRun(signals) });
  await new Promise(r => setTimeout(r, 0));
  useStore.getState().setUser(null);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(s => s.aborted));
  assert.deepEqual(getRuns('m1'), {});
  assert.deepEqual(getResults('m1'), {});
});

test('switching to another user aborts every background AI run', async () => {
  const signals = [];
  startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run: pendingRun(signals) });
  await new Promise(r => setTimeout(r, 0));
  useStore.getState().setUser({ id: 'u2' });
  assert.ok(signals[0].aborted);
});

test('locking the screen aborts every background AI run', async () => {
  const signals = [];
  startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run: pendingRun(signals) });
  await new Promise(r => setTimeout(r, 0));
  useStore.getState().setLocked(true);
  assert.ok(signals[0].aborted);
  assert.deepEqual(getRuns('m1'), {});
});

test('refreshing the same user keeps background AI runs alive', async () => {
  const signals = [];
  startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run: pendingRun(signals) });
  await new Promise(r => setTimeout(r, 0));
  useStore.getState().setUser({ id: 'u1', totpEnabled: true });
  assert.equal(signals[0].aborted, false);
  assert.equal(getRuns('m1').summarize.status, 'loading');
});
