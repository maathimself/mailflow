import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGtdRemovalGuard,
  clearGtdRemovalGuard,
  completedGtdRemovalMap,
  pendingGtdRemovalMap,
  setCompletedGtdRemoval,
  setPendingGtdRemoval,
} from './pendingGtdRemovals.js';

const makeSections = () => ({
  todo: {
    total: 2,
    unread: 1,
    threads: [
      { id: 'todo-x', message_id: 'x', is_read: false },
      { id: 'todo-y', message_id: 'y', is_read: true },
    ],
  },
  watch: {
    total: 1,
    unread: 1,
    threads: [{ id: 'watch-x', message_id: 'x', is_read: false }],
  },
  delegated: {
    total: 1,
    unread: 1,
    threads: [{ id: 'delegated-x', message_id: 'x', is_read: false }],
  },
  waiting: { total: 1, unread: 1 },
  reference: {
    total: 1,
    unread: 1,
    threads: [{ id: 'reference-x', message_id: 'x', is_read: false }],
  },
});

describe('pending GTD removal guard', () => {
  afterEach(() => {
    for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
      clearGtdRemovalGuard(removal.identity, removal.states);
    }
  });

  it('leaves fetched sections untouched when no row is guarded', () => {
    const sections = makeSections();
    assert.equal(applyGtdRemovalGuard(sections), sections);
  });

  it('keeps a pending Waiting row out of stale refetches with correct rollups', () => {
    setPendingGtdRemoval('x', ['watch', 'delegated']);
    const guarded = applyGtdRemovalGuard(makeSections());

    assert.equal(guarded.watch.total, 0);
    assert.equal(guarded.delegated.total, 0);
    assert.deepEqual(guarded.watch.threads, []);
    assert.deepEqual(guarded.delegated.threads, []);
    assert.deepEqual(guarded.waiting, { total: 0, unread: 0 });
    assert.equal(guarded.todo.total, 2);
    assert.equal(guarded.reference.total, 1);
  });

  it('keeps a completed row hidden during the reconciliation grace window', () => {
    setPendingGtdRemoval('x', ['todo']);
    setCompletedGtdRemoval('x', ['todo']);

    assert.equal(pendingGtdRemovalMap.size, 0);
    assert.equal(completedGtdRemovalMap.size, 1);
    assert.deepEqual(
      applyGtdRemovalGuard(makeSections()).todo.threads.map(thread => thread.message_id),
      ['y'],
    );
  });

  it('tracks rapid state-scoped removals independently for the same thread', () => {
    setPendingGtdRemoval('x', ['todo']);
    setCompletedGtdRemoval('x', ['reference']);
    const guarded = applyGtdRemovalGuard(makeSections());

    assert.deepEqual(guarded.todo.threads.map(thread => thread.message_id), ['y']);
    assert.deepEqual(guarded.reference.threads, []);
    assert.equal(guarded.watch.threads.length, 1);
  });

  it('allows a failed row to return after its guard is cleared', () => {
    const sections = makeSections();
    setPendingGtdRemoval('x', ['todo']);
    assert.equal(applyGtdRemovalGuard(sections).todo.total, 1);

    clearGtdRemovalGuard('x', ['todo']);
    assert.equal(applyGtdRemovalGuard(sections), sections);
  });
});
