import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRunRegistry, aiRuns } from './aiRunRegistry.js';

const ctrl = () => { const c = { aborted: false, abort() { this.aborted = true; } }; return c; };

describe('the summary thrown away by navigating (#428)', () => {
  test('looking at another message does not cancel a running action', () => {
    // The bug: switching messages aborted every in-flight request, the AbortError was
    // swallowed, and the completed text was never persisted. No output, no sign it had run.
    const reg = createAiRunRegistry();
    const a = reg.start('msg-1', 'summarize', ctrl());
    // ...user navigates to msg-2 and starts nothing. Nothing in the registry should change.
    assert.equal(a.aborted, false);
    assert.equal(reg.size, 1);
  });

  test('the same action on a different message runs alongside, not instead', () => {
    // Keyed by action alone, starting summarize on msg-2 would abort msg-1's summarize:
    // the same data loss by another route.
    const reg = createAiRunRegistry();
    const first = reg.start('msg-1', 'summarize', ctrl());
    const second = reg.start('msg-2', 'summarize', ctrl());
    assert.equal(first.aborted, false);
    assert.equal(second.aborted, false);
    assert.equal(reg.size, 2);
  });
});

describe('what must still be cancelled', () => {
  test('re-running the same action on the same message supersedes the first', () => {
    const reg = createAiRunRegistry();
    const first = reg.start('msg-1', 'summarize', ctrl());
    const second = reg.start('msg-1', 'summarize', ctrl());
    assert.equal(first.aborted, true, 'the superseded run must stop');
    assert.equal(second.aborted, false);
    assert.equal(reg.size, 1, 'and must not be left in the map');
  });

  test('dismissing a result cancels that run and only that run', () => {
    const reg = createAiRunRegistry();
    const keep = reg.start('msg-1', 'translate', ctrl());
    const drop = reg.start('msg-1', 'summarize', ctrl());
    reg.abort('msg-1', 'summarize');
    assert.equal(drop.aborted, true);
    assert.equal(keep.aborted, false);
    assert.equal(reg.size, 1);
  });

  test('signing out or locking cancels everything', () => {
    const reg = createAiRunRegistry();
    const a = reg.start('msg-1', 'summarize', ctrl());
    const b = reg.start('msg-2', 'translate', ctrl());
    reg.abortAll();
    assert.equal(a.aborted, true);
    assert.equal(b.aborted, true);
    assert.equal(reg.size, 0);
  });
});

describe('bookkeeping', () => {
  test('a finished run is forgotten without being aborted', () => {
    // finish() runs after the request resolves; aborting there would be harmless but wrong,
    // and leaving the entry would grow the map for the life of the session.
    const reg = createAiRunRegistry();
    const done = reg.start('msg-1', 'summarize', ctrl());
    reg.finish('msg-1', 'summarize');
    assert.equal(done.aborted, false);
    assert.equal(reg.size, 0);
  });

  test('many messages and actions stay independent', () => {
    const reg = createAiRunRegistry();
    const made = [];
    for (let m = 0; m < 10; m++) for (const k of ['summarize', 'translate']) made.push(reg.start(`msg-${m}`, k, ctrl()));
    assert.equal(reg.size, 20);
    reg.abort('msg-4', 'translate');
    assert.equal(reg.size, 19);
    assert.equal(made.filter(c => c.aborted).length, 1, 'exactly one run cancelled');
  });

  test('aborting or finishing something unknown is a no-op', () => {
    const reg = createAiRunRegistry();
    reg.abort('nope', 'summarize');
    reg.finish('nope', 'summarize');
    assert.equal(reg.size, 0);
  });

  test('a missing controller does not throw', () => {
    const reg = createAiRunRegistry();
    reg.start('msg-1', 'summarize', null);
    reg.abortAll();
    assert.equal(reg.size, 0);
  });
});

describe('the shared registry', () => {
  test('is module-level, so a run outlives the pane that started it', () => {
    // Held in a component ref it died on unmount, which happens when a pop-out closes or the
    // layout changes — navigation wearing a different hat, and the same lost result.
    const c = ctrl();
    aiRuns.start('msg-1', 'summarize', c);
    assert.equal(aiRuns.size, 1);
    assert.equal(c.aborted, false);
    aiRuns.abortAll();
    assert.equal(aiRuns.size, 0);
  });

  test('the same instance is shared by every importer', async () => {
    const again = await import('./aiRunRegistry.js');
    assert.equal(again.aiRuns, aiRuns, 'the store and the pane must cancel the same runs');
  });
});
