import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearGtdMetadata,
  getGtdMetadataClock,
  tickGtdMetadataClock,
  fetchVisibleGtdMetadata,
  getGtdMetadata,
  getGtdMetadataRefreshGeneration,
  invalidateGtdMetadata,
  patchGtdMetadata,
  startGtdMetadataFetch,
  subscribeGtdMetadataRefresh,
} from './metadataStore.js';

const A1 = 'account-1';
const A2 = 'account-2';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const flushMicrotasks = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe('fetchVisibleGtdMetadata', () => {
  it('groups by account, deduplicates, and chunks requests at 100 ids', async () => {
    const calls = [];
    const messages = Array.from({ length: 101 }, (_, i) => ({ id: `m-${i}`, account_id: A1 }));
    messages.push(messages[0], { id: M2, account_id: A2 });
    const api = { gtdMetadata: async (accountId, ids) => {
      calls.push([accountId, ids]);
      return { messages: {} };
    } };

    await fetchVisibleGtdMetadata(messages, { api });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(([accountId, ids]) => [accountId, ids.length]), [
      [A1, 100], [A1, 1], [A2, 1],
    ]);
  });

  it('ignores a slow response superseded by a newer fetch', async () => {
    let resolveSlow;
    const slowApi = { gtdMetadata: () => new Promise(resolve => { resolveSlow = resolve; }) };
    const fastApi = { gtdMetadata: async () => ({ messages: {
      [M1]: { states: ['watch'], dates: { watch: '2026-08-01T00:00:00.000Z' }, date: '2026-08-01T00:00:00.000Z' },
    } }) };

    const slow = fetchVisibleGtdMetadata([{ id: M1, account_id: A1 }], { api: slowApi });
    await fetchVisibleGtdMetadata([{ id: M1, account_id: A1 }], { api: fastApi });
    resolveSlow({ messages: {
      [M1]: { states: ['todo'], dates: { todo: '2026-07-01T00:00:00.000Z' }, date: '2026-07-01T00:00:00.000Z' },
    } });
    await slow;

    assert.deepEqual(getGtdMetadata(M1).states, ['watch']);
  });

  it('clears cached labels omitted by a fresh response', async () => {
    patchGtdMetadata(M2, 'todo', '2026-08-01T00:00:00.000Z');
    await fetchVisibleGtdMetadata([{ id: M2, account_id: A1 }], {
      api: { gtdMetadata: async () => ({ messages: {} }) },
    });
    assert.equal(getGtdMetadata(M2), null);
  });

  it('applies successful account responses without clearing data from a failed request', async () => {
    patchGtdMetadata(M2, 'todo', '2026-08-01T00:00:00.000Z');
    const result = await fetchVisibleGtdMetadata([
      { id: M1, account_id: A1 },
      { id: M2, account_id: A2 },
    ], {
      api: { gtdMetadata: async (accountId) => {
        if (accountId === A2) throw new Error('account offline');
        return { messages: {
          [M1]: { states: ['watch'], dates: { watch: '2026-08-02T00:00:00.000Z' }, date: '2026-08-02T00:00:00.000Z' },
        } };
      } },
    });

    assert.equal(result, 'partial');
    assert.deepEqual(getGtdMetadata(M1)?.states, ['watch']);
    assert.deepEqual(getGtdMetadata(M2)?.states, ['todo']);
  });

  it('publishes a healthy account while another account remains pending', async () => {
    clearGtdMetadata();
    let finishSlow;
    const pending = fetchVisibleGtdMetadata([
      { id: M1, account_id: A1 }, { id: M2, account_id: A2 },
    ], { api: { gtdMetadata: accountId => accountId === A1
      ? Promise.resolve({ messages: { [M1]: { states: ['watch'] } } })
      : new Promise(resolve => { finishSlow = resolve; }) } });
    await flushMicrotasks();
    assert.deepEqual(getGtdMetadata(M1)?.states, ['watch']);
    assert.equal(getGtdMetadata(M2), null);
    finishSlow({ messages: {} });
    assert.equal(await pending, 'complete');
  });

  it('does not let an older fetch overwrite an optimistic classification', async () => {
    const id = 'optimistic-race-message';
    let resolveFetch;
    const pending = fetchVisibleGtdMetadata([{ id, account_id: A1 }], {
      api: { gtdMetadata: () => new Promise(resolve => { resolveFetch = resolve; }) },
    });

    patchGtdMetadata(id, 'todo', '2026-08-04T00:00:00.000Z');
    resolveFetch({ messages: {} });

    assert.equal(await pending, 'stale');
    assert.deepEqual(getGtdMetadata(id)?.states, ['todo']);
  });
});

describe('startGtdMetadataFetch', () => {
  it('does not schedule a late partial retry after cancellation', async () => {
    let rejectRequest;
    const scheduled = [];
    const cancel = startGtdMetadataFetch([{ id: M1, account_id: A1 }], {
      api: { gtdMetadata: () => new Promise((_resolve, reject) => { rejectRequest = reject; }) },
      schedule: callback => { scheduled.push(callback); return callback; },
      cancelSchedule: () => {},
      onError: () => {},
    });

    cancel();
    rejectRequest(new Error('offline'));
    await flushMicrotasks();

    assert.equal(scheduled.length, 0);
  });

  for (const supersede of ['newer fetch', 'session reset']) {
    it(`does not run a queued retry after a ${supersede}`, async () => {
      const scheduled = [];
      let calls = 0;
      const cancel = startGtdMetadataFetch([{ id: M1, account_id: A1 }], {
        api: { gtdMetadata: async () => { calls += 1; throw new Error('offline'); } },
        schedule: callback => { scheduled.push(callback); return callback; },
        cancelSchedule: () => {},
      });
      await flushMicrotasks();
      assert.equal(scheduled.length, 1);
      if (supersede === 'session reset') clearGtdMetadata();
      else await fetchVisibleGtdMetadata([{ id: M2, account_id: A2 }], {
        api: { gtdMetadata: async () => ({ messages: { [M2]: { states: ['todo'] } } }) },
      });
      scheduled[0]();
      await flushMicrotasks();
      assert.equal(calls, 1);
      assert.equal(getGtdMetadata(M1), null);
      if (supersede === 'newer fetch') assert.deepEqual(getGtdMetadata(M2)?.states, ['todo']);
      cancel();
    });
  }

  it('schedules at most one retry for a partial response', async () => {
    const scheduled = [];
    let calls = 0;
    const cancel = startGtdMetadataFetch([{ id: M1, account_id: A1 }], {
      api: { gtdMetadata: async () => { calls += 1; throw new Error('offline'); } },
      schedule: callback => { scheduled.push(callback); return callback; },
      cancelSchedule: () => {},
      onError: () => {},
    });
    await flushMicrotasks();

    assert.equal(scheduled.length, 1);
    scheduled[0]();
    await flushMicrotasks();

    assert.equal(calls, 2);
    assert.equal(scheduled.length, 1);
    cancel();
  });
});

describe('invalidateGtdMetadata', () => {
  it('advances the refresh generation and notifies runtime subscribers', () => {
    const before = getGtdMetadataRefreshGeneration();
    let calls = 0;
    const unsubscribe = subscribeGtdMetadataRefresh(() => { calls += 1; });

    invalidateGtdMetadata();
    unsubscribe();
    invalidateGtdMetadata();

    assert.equal(getGtdMetadataRefreshGeneration(), before + 2);
    assert.equal(calls, 1);
  });
});

describe('patchGtdMetadata', () => {
  it('inserts states canonically without overwriting older state dates', () => {
    const id = 'patch-message';
    patchGtdMetadata(id, 'someday', '2026-08-03T00:00:00.000Z');
    patchGtdMetadata(id, 'watch', '2026-08-02T00:00:00.000Z');
    patchGtdMetadata(id, 'todo', '2026-08-01T00:00:00.000Z');
    patchGtdMetadata(id, 'watch', '2026-08-09T00:00:00.000Z');

    assert.deepEqual(getGtdMetadata(id), {
      states: ['todo', 'watch', 'someday'],
      dates: {
        todo: '2026-08-01T00:00:00.000Z',
        watch: '2026-08-02T00:00:00.000Z',
        someday: '2026-08-03T00:00:00.000Z',
      },
      date: '2026-08-01T00:00:00.000Z',
    });
  });
});


describe('metadata lifecycle', () => {
  it('does not apply a response after its only consumer cancels', async () => {
    const id = 'cancel-result';
    let finish;
    const cancel = startGtdMetadataFetch([{ id, account_id: A1 }], {
      api: { gtdMetadata: () => new Promise(resolve => { finish = resolve; }) },
    });
    cancel();
    finish({ messages: { [id]: { states: ['todo'] } } });
    await flushMicrotasks();
    assert.equal(getGtdMetadata(id), null);
  });

  it('evicts old rows when the rendered pool changes', async () => {
    patchGtdMetadata('offscreen', 'todo', null);
    await fetchVisibleGtdMetadata([{ id: 'onscreen', account_id: A1 }], {
      api: { gtdMetadata: async () => ({ messages: { onscreen: { states: ['watch'] } } }) },
    });
    assert.equal(getGtdMetadata('offscreen'), null);
    assert.deepEqual(getGtdMetadata('onscreen').states, ['watch']);
  });

  it('clears cache and invalidates in-flight responses on runtime teardown', async () => {
    let finish;
    patchGtdMetadata('cached', 'todo', null);
    const pending = fetchVisibleGtdMetadata([{ id: 'cached', account_id: A1 }], {
      api: { gtdMetadata: () => new Promise(resolve => { finish = resolve; }) },
    });
    clearGtdMetadata();
    finish({ messages: { cached: { states: ['todo'] } } });
    assert.equal(await pending, 'stale');
    assert.equal(getGtdMetadata('cached'), null);
  });

  it('patches every loaded head of the same account thread, excluding other accounts', async () => {
    const messages = [
      { id: 'head', account_id: A1, thread_id: 'thread' },
      { id: 'member', account_id: A1, thread_key: 'thread' },
      { id: 'other', account_id: A2, thread_id: 'thread' },
    ];
    await fetchVisibleGtdMetadata(messages, { api: { gtdMetadata: async () => ({ messages: {} }) } });
    patchGtdMetadata(messages[1], 'todo', null);
    assert.deepEqual(getGtdMetadata('head').states, ['todo']);
    assert.equal(getGtdMetadata('other'), null);
    clearGtdMetadata(messages[1]);
    assert.equal(getGtdMetadata('head'), null);
    assert.equal(getGtdMetadata('member'), null);
  });

  it('treats malformed successful responses as retryable without clearing cached state', async () => {
    patchGtdMetadata(M1, 'todo', null);
    const status = await fetchVisibleGtdMetadata([{ id: M1, account_id: A1 }], {
      api: { gtdMetadata: async () => ({}) },
    });
    assert.equal(status, 'partial');
    assert.deepEqual(getGtdMetadata(M1).states, ['todo']);
  });
});


it('advances the shared indicator clock without fetching metadata', () => {
  tickGtdMetadataClock(100);
  assert.equal(getGtdMetadataClock(), 100);
  tickGtdMetadataClock(200);
  assert.equal(getGtdMetadataClock(), 200);
});
