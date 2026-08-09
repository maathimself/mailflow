import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDeleteGuard,
  clearDeleteGuard,
  clearPendingDelete,
  setCompletedDelete,
  setPendingDelete,
  pendingDeleteMap,
  completedDeleteMap,
} from './pendingDeletes.js';

// The guard is what stops a background refresh / websocket refetch from resurrecting a
// row that was optimistically removed (archive/delete) but whose server-side removal is
// not yet committed. Bulk archive and delete both feed it via setPendingDelete /
// setCompletedDelete / clearDeleteGuard; the three list-refetch paths run results through
// applyDeleteGuard. These tests cover that reconciliation.
describe('pendingDeletes guard', () => {
  const list = [
    { id: 'a', thread_id: 'thread-a', account_id: 'account-1', folder: 'INBOX' },
    { id: 'b', thread_id: 'thread-b', account_id: 'account-1', folder: 'INBOX' },
    { id: 'c', thread_id: 'thread-c', account_id: 'account-1', folder: 'INBOX' },
  ];
  const guarded = () => applyDeleteGuard(list).map(m => m.id);

  // Clear timers/state so tests don't leak into each other or keep the process alive.
  afterEach(() => ['a', 'b', 'c'].forEach(clearDeleteGuard));

  it('returns the input untouched when nothing is guarded', () => {
    assert.equal(applyDeleteGuard(list), list);
  });

  it('hides a pending id from refetch results, and restores it on clear', () => {
    setPendingDelete('b');
    assert.deepEqual(guarded(), ['a', 'c']);
    clearPendingDelete('b');
    assert.deepEqual(guarded(), ['a', 'b', 'c']);
  });

  it('keeps hiding a committed (completed) id during its grace window', () => {
    setPendingDelete('a');
    setCompletedDelete('a'); // pending -> completed grace
    assert.ok(!pendingDeleteMap.has('a'));
    assert.ok(completedDeleteMap.has('a'));
    assert.deepEqual(guarded(), ['b', 'c']);
  });

  it('filters multiple guarded ids at once (pending + completed)', () => {
    setPendingDelete('a');
    setCompletedDelete('c');
    assert.deepEqual(guarded(), ['b']);
  });

  it('clearDeleteGuard releases an id from both pending and completed', () => {
    setPendingDelete('a');
    setCompletedDelete('a');
    clearDeleteGuard('a');
    assert.ok(!pendingDeleteMap.has('a') && !completedDeleteMap.has('a'));
    assert.deepEqual(guarded(), ['a', 'b', 'c']);
  });

  it('hides a replacement head while its stable account-folder thread id is pending', () => {
    setPendingDelete('thread:thread-b:account:account-1:folder:INBOX');
    assert.deepEqual(guarded(), ['a', 'c']);
    clearDeleteGuard('thread:thread-b:account:account-1:folder:INBOX');
  });

  it('keeps a replacement head hidden during the completed folder thread grace window', () => {
    setCompletedDelete('thread:thread-b:folder:INBOX');
    assert.deepEqual(guarded(), ['a', 'c']);
    clearDeleteGuard('thread:thread-b:folder:INBOX');
  });

  it('does not hide a preserved-folder copy of a guarded thread', () => {
    setPendingDelete('thread:thread-b:folder:INBOX');
    const copies = [
      { id: 'inbox', thread_id: 'thread-b', account_id: 'account-1', folder: 'INBOX' },
      { id: 'sent', thread_id: 'thread-b', account_id: 'account-1', folder: 'Sent' },
    ];
    assert.deepEqual(applyDeleteGuard(copies).map(message => message.id), ['sent']);
    clearDeleteGuard('thread:thread-b:folder:INBOX');
  });

  it('does not hide the same Inbox thread in another account for an account-scoped guard', () => {
    setPendingDelete('thread:thread-b:account:account-1:folder:INBOX');
    const copies = [
      { id: 'first', thread_id: 'thread-b', account_id: 'account-1', folder: 'INBOX' },
      { id: 'second', thread_id: 'thread-b', account_id: 'account-2', folder: 'INBOX' },
    ];
    assert.deepEqual(applyDeleteGuard(copies).map(message => message.id), ['second']);
    clearDeleteGuard('thread:thread-b:account:account-1:folder:INBOX');
  });
});
