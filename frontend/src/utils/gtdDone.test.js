import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { doneGtdRow } from './gtdDone.js';
import {
  clearGtdRemovalGuard,
  completedGtdRemovalMap,
  pendingGtdRemovalMap,
} from './pendingGtdRemovals.js';

const thread = { id: 'row-x', message_id: 'x', subject: 'A subject' };
const states = ['todo'];

function deps(overrides = {}) {
  return {
    gtdDone: async () => ({ ok: true }),
    removeGtdThread: () => ({ snapshot: true }),
    restoreGtdThread: () => {},
    addNotification: () => {},
    scheduleGtdSectionsFetch: () => {},
    t: key => key,
    ...overrides,
  };
}

describe('doneGtdRow', () => {
  afterEach(() => {
    for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
      clearGtdRemovalGuard(removal.identity, removal.states);
    }
  });

  it('guards and removes the row before the request settles, then completes the guard', async () => {
    const calls = [];
    let resolveRequest;
    const request = new Promise(resolve => { resolveRequest = resolve; });
    const result = doneGtdRow(thread, states, deps({
      removeGtdThread: (identity, removedStates) => {
        calls.push(['remove', identity, removedStates]);
        return { snapshot: true };
      },
      gtdDone: async (id, removedStates) => {
        calls.push(['api', id, removedStates]);
        return request;
      },
      scheduleGtdSectionsFetch: () => calls.push(['schedule']),
    }));

    assert.deepEqual(calls, [
      ['remove', 'x', states],
      ['api', 'row-x', states],
    ]);
    assert.equal(pendingGtdRemovalMap.size, 1);
    assert.equal(completedGtdRemovalMap.size, 0);

    resolveRequest({ ok: true });
    assert.deepEqual(await result, { ok: true });
    assert.equal(pendingGtdRemovalMap.size, 0);
    assert.equal(completedGtdRemovalMap.size, 1);
    assert.deepEqual(calls.at(-1), ['schedule']);
  });

  it('clears the guard and restores only the captured row on failure', async () => {
    const snapshot = { identity: 'x', removedByState: { todo: [] } };
    const calls = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await doneGtdRow(thread, states, deps({
        removeGtdThread: () => snapshot,
        gtdDone: async () => { throw new Error('network failed'); },
        restoreGtdThread: value => calls.push(['restore', value]),
        addNotification: notification => calls.push(['notify', notification]),
        scheduleGtdSectionsFetch: () => calls.push(['schedule']),
      }));

      assert.equal(result, null);
      assert.equal(pendingGtdRemovalMap.size, 0);
      assert.equal(completedGtdRemovalMap.size, 0);
      assert.deepEqual(calls, [
        ['restore', snapshot],
        ['notify', { title: 'gtd.doneFailed', body: 'A subject' }],
        ['schedule'],
      ]);
    } finally {
      console.error = originalError;
    }
  });

  it('keeps the row removed but reports a partial archive failure', async () => {
    const calls = [];
    await doneGtdRow(thread, states, deps({
      gtdDone: async () => ({ ok: true, archiveFailed: true }),
      restoreGtdThread: () => calls.push(['restore']),
      addNotification: notification => calls.push(['notify', notification]),
    }));

    assert.deepEqual(calls, [
      ['notify', { title: 'gtd.doneArchiveFailed', body: 'A subject' }],
    ]);
    assert.equal(completedGtdRemovalMap.size, 1);
  });
});
