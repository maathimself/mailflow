import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaimQueue, refreshListAndWait, LIST_REFRESH_EVENT } from './listRefreshClaims.js';

const target = () => new EventTarget();
const outcome = promise => promise.then(() => 'done', error => `failed: ${error.message}`);

describe('refreshListAndWait', () => {
  test('dispatches the list refresh, and with no list to claim it resolves at once', async () => {
    const t = target();
    let heard = 0;
    t.addEventListener(LIST_REFRESH_EVENT, () => { heard += 1; });
    assert.equal(await outcome(refreshListAndWait(t)), 'done');
    assert.equal(heard, 1, 'a listener that takes no claim still hears the refresh');
  });

  test('waits for the list that claimed it, and hears its failure', async () => {
    const t = target();
    const queue = createClaimQueue();
    t.addEventListener(LIST_REFRESH_EVENT, e => queue.add(e.detail?.claim()));
    const first = outcome(refreshListAndWait(t));
    let settled = false;
    first.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    queue.settle(true);
    assert.equal(await first, 'done');
    const second = outcome(refreshListAndWait(t));
    queue.settle(false, new Error('offline'));
    assert.equal(await second, 'failed: offline');
    const third = outcome(refreshListAndWait(t));
    queue.settle(false);
    assert.equal(await third, 'failed: The list could not be reloaded');
  });
});

describe('createClaimQueue', () => {
  const claim = (log, name) => ({ done: () => log.push(`${name} done`), fail: () => log.push(`${name} failed`) });

  test('a reload settles only the claims made before it started', () => {
    const log = [];
    const queue = createClaimQueue();
    queue.add(claim(log, 'a'));
    const upTo = queue.mark();
    queue.add(claim(log, 'b')); // made while that reload was in flight
    queue.settle(true, null, upTo);
    assert.deepEqual(log, ['a done']);
    assert.equal(queue.size, 1, 'b waits for the next reload');
    queue.settle(false, new Error('x'), queue.mark());
    assert.deepEqual(log, ['a done', 'b failed']);
    assert.equal(queue.size, 0);
  });

  test('settles each claim once, and ignores a missing one', () => {
    const log = [];
    const queue = createClaimQueue();
    queue.add(undefined);
    queue.add(claim(log, 'a'));
    queue.settle(true);
    queue.settle(true);
    assert.deepEqual(log, ['a done']);
  });
});
