import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingOperationManager } from './pendingOperationManager.js';

test('flushes registered operations once using normal or unload behavior', async () => {
  const events = [];
  const timers = { clearTimeout: timer => events.push(['clear', timer]) };
  const manager = createPendingOperationManager(timers);
  manager.register({
    timer: 'normal-timer',
    run: async () => events.push(['run']),
    unload: () => events.push(['unload-unused']),
  });
  await manager.flush('normal');
  assert.deepEqual(events, [['clear', 'normal-timer'], ['run']]);

  manager.register({
    timer: 'unload-timer',
    run: async () => events.push(['run-unused']),
    unload: () => events.push(['unload']),
  });
  await manager.flush('unload');
  await manager.flush('normal');
  assert.deepEqual(events.slice(2), [['clear', 'unload-timer'], ['unload']]);
});

test('unregister prevents a pending operation from being flushed', async () => {
  let calls = 0;
  const manager = createPendingOperationManager({ clearTimeout() {} });
  const unregister = manager.register({ timer: 1, run: () => { calls += 1; } });
  unregister();
  await manager.flush('normal');
  assert.equal(calls, 0);
});
