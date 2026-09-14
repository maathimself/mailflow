// Run with: node --test src/aiRuns.test.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stub (aiResults only touches it inside its functions).
globalThis.localStorage = (() => {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();

const { getResults, saveResult } = await import('./aiResults.js');
const {
  startRun, cancelRun, getRuns, getAiState, subscribeRuns, abortAllRuns, MAX_CONCURRENT_RUNS,
} = await import('./aiRuns.js');

// A fake model call driven by hand: the test decides when it streams, resolves or fails.
function fakeRun() {
  const calls = [];
  const run = (signal, onDelta) => new Promise((resolve, reject) => {
    const call = { signal, onDelta, resolve, reject };
    calls.push(call);
  });
  return { run, calls };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('aiRuns', () => {
  beforeEach(() => {
    abortAllRuns();
    localStorage.clear();
  });

  it('keeps a run going after the viewer switches messages and persists it for the original message (#428)', async () => {
    const { run, calls } = fakeRun();
    const seen = [];
    const unsubscribeM1 = subscribeRuns('m1', () => seen.push('m1'));
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    // The pane moves on to m2: it unsubscribes from m1 and never aborts the run.
    unsubscribeM1();
    subscribeRuns('m2', () => seen.push('m2'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);

    calls[0].resolve('the summary');
    await flush();

    assert.equal(getResults('m1').summarize.text, 'the summary');
    assert.equal(getResults('m1').summarize.label, 'Summary');
    assert.deepEqual(getResults('m2'), {});
    assert.ok(!seen.includes('m2'), 'm2 subscriber must not hear about m1');
    assert.deepEqual(getRuns('m1'), {}, 'a completed run leaves the registry');
  });

  it('never delivers deltas or completion of one message to another message', async () => {
    const { run, calls } = fakeRun();
    const m1Events = [];
    const m2Events = [];
    subscribeRuns('m1', () => m1Events.push(getAiState('m1')));
    subscribeRuns('m2', () => m2Events.push(getAiState('m2')));

    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    calls[0].onDelta('partial');
    calls[0].resolve('final');
    await flush();

    assert.ok(m1Events.length >= 2);
    assert.equal(m2Events.length, 0);
    assert.deepEqual(getAiState('m2'), {}, 'the state rendered for m2 has no trace of m1');
    assert.deepEqual(getAiState('m1').summarize, { status: 'done', text: 'final', label: 'Summary' });
  });

  it('exposes the partial text of an in-flight run so a re-selected pane shows progress', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    calls[0].onDelta('half a');
    assert.deepEqual(getRuns('m1'), { summarize: { status: 'loading', text: 'half a', label: 'Summary' } });
    assert.deepEqual(getAiState('m1').summarize, { status: 'loading', text: 'half a', label: 'Summary' });
  });

  it('cancelRun aborts the signal and persists nothing', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    cancelRun('m1', 'summarize');
    assert.equal(calls[0].signal.aborted, true);
    assert.deepEqual(getRuns('m1'), {});
    // A provider that ignores the abort and still resolves must not be persisted.
    calls[0].resolve('too late');
    await flush();
    assert.deepEqual(getResults('m1'), {});
    assert.deepEqual(getRuns('m1'), {});
  });

  it('records a failed run as an error and does not persist it', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    calls[0].reject(new Error('AI request failed'));
    await flush();
    assert.deepEqual(getRuns('m1'), { summarize: { status: 'error', text: 'AI request failed', label: 'Summary' } });
    assert.deepEqual(getResults('m1'), {});
  });

  it('drops an aborted run silently', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    calls[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await flush();
    assert.deepEqual(getRuns('m1'), {});
    assert.deepEqual(getResults('m1'), {});
  });

  it('is idempotent: starting the same run twice (StrictMode double effects) issues one request', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
  });

  it('subscribing and unsubscribing twice is harmless', async () => {
    const { run, calls } = fakeRun();
    let count = 0;
    const listener = () => { count++; };
    const u1 = subscribeRuns('m1', listener);
    u1();
    const u2 = subscribeRuns('m1', listener);
    u1();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    assert.ok(count > 0, 'the second subscription is still live');
    u2();
    const before = count;
    calls[0].resolve('done');
    await flush();
    assert.equal(count, before);
  });

  it('force restarts: aborts the previous signal and a stale late resolution does not overwrite the new result', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run, force: true });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);

    calls[1].resolve('fresh');
    await flush();
    calls[0].resolve('stale');
    await flush();
    assert.equal(getResults('m1').summarize.text, 'fresh');
  });

  it('restarts a run that previously failed', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    calls[0].reject(new Error('boom'));
    await flush();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(getRuns('m1').summarize.status, 'loading');
  });

  it('runs the same action key on two messages independently', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run });
    startRun({ messageId: 'm2', key: 'summarize', label: 'Summary', run });
    await flush();
    assert.equal(calls.length, 2);
    cancelRun('m1', 'summarize');
    assert.equal(calls[1].signal.aborted, false);
    calls[1].resolve('two');
    await flush();
    assert.deepEqual(getResults('m1'), {});
    assert.equal(getResults('m2').summarize.text, 'two');
  });

  it('overlays an in-flight regenerate over the persisted result for the same key', async () => {
    saveResult('m1', 'summarize', 'old', 'Summary');
    saveResult('m1', 'act-2', 'kept', 'Translate');
    const { run } = fakeRun();
    startRun({ messageId: 'm1', key: 'summarize', label: 'Summary', run, force: true });
    await flush();
    const state = getAiState('m1');
    assert.equal(state.summarize.status, 'loading');
    assert.deepEqual(state['act-2'], { status: 'done', text: 'kept', label: 'Translate' });
  });

  it('caps concurrent runs at 3 and starts queued runs in FIFO order', async () => {
    assert.equal(MAX_CONCURRENT_RUNS, 3);
    const { run, calls } = fakeRun();
    const started = [];
    const tracked = (id) => (signal, onDelta) => { started.push(id); return run(signal, onDelta); };
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      startRun({ messageId: id, key: 'summarize', label: 'Summary', run: tracked(id) });
    }
    await flush();
    assert.deepEqual(started, ['m1', 'm2', 'm3']);
    // A queued run already reads as running when its message is selected.
    assert.deepEqual(getRuns('m4'), { summarize: { status: 'loading', text: '', label: 'Summary' } });
    assert.equal(getAiState('m5').summarize.status, 'loading');

    calls[1].resolve('m2 done');
    await flush();
    assert.deepEqual(started, ['m1', 'm2', 'm3', 'm4']);

    // Cancelling an active run frees its slot immediately.
    cancelRun('m1', 'summarize');
    await flush();
    assert.deepEqual(started, ['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('a cancelled queued run never starts', async () => {
    const { run } = fakeRun();
    const started = [];
    const tracked = (id) => (signal, onDelta) => { started.push(id); return run(signal, onDelta); };
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      startRun({ messageId: id, key: 'summarize', label: 'Summary', run: tracked(id) });
    }
    await flush();
    cancelRun('m4', 'summarize');
    assert.deepEqual(getRuns('m4'), {});
    cancelRun('m1', 'summarize');
    await flush();
    assert.deepEqual(started, ['m1', 'm2', 'm3']);
  });

  it('abortAllRuns aborts active runs, drops queued ones and persists nothing', async () => {
    const { run, calls } = fakeRun();
    const started = [];
    const tracked = (id) => (signal, onDelta) => { started.push(id); return run(signal, onDelta); };
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      startRun({ messageId: id, key: 'summarize', label: 'Summary', run: tracked(id) });
    }
    await flush();
    abortAllRuns();
    assert.ok(calls.every(c => c.signal.aborted));
    calls.forEach(c => c.resolve('late'));
    await flush();
    assert.deepEqual(started, ['m1', 'm2', 'm3']);
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      assert.deepEqual(getRuns(id), {});
      assert.deepEqual(getResults(id), {});
    }
  });

  it('ignores starts without a message id or action key', async () => {
    const { run, calls } = fakeRun();
    startRun({ messageId: null, key: 'summarize', label: 'Summary', run });
    startRun({ messageId: 'm1', key: '', label: 'Summary', run });
    await flush();
    assert.equal(calls.length, 0);
    assert.deepEqual(getAiState(null), {});
  });
});
