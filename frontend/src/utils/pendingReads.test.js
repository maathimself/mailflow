// The read guard a list refresh goes through, and who owns it (utils/pendingReads.js).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReadGuard, clearReadGuard, completedMarkReadMap, failMarkRead, pendingMarkReadMap, setPending, settleMarkRead,
} from './pendingReads.js';

beforeEach(() => {
  for (const id of ['m1', 'm2']) clearReadGuard(id);
});

describe('read guard ownership', () => {
  test('a read that settles records its grace entry', () => {
    const token = setPending('m1', 'acct');
    assert.equal(settleMarkRead('m1', 'acct', token), true);
    assert.equal(pendingMarkReadMap.has('m1'), false);
    assert.equal(completedMarkReadMap.get('m1'), 'acct');
  });

  test('a read the user undid by hand records nothing when its reply arrives', () => {
    const token = setPending('m1', 'acct');
    clearReadGuard('m1');
    assert.equal(settleMarkRead('m1', 'acct', token), false);
    assert.equal(completedMarkReadMap.has('m1'), false);
    assert.equal(failMarkRead('m1', token), false, 'nor does its failure roll anything back');
  });

  test('a newer read owns the guard: the older one settling or failing leaves it alone', () => {
    const older = setPending('m1', 'acct');
    const newer = setPending('m1', 'acct');
    assert.equal(failMarkRead('m1', older), false);
    assert.equal(settleMarkRead('m1', 'acct', older), false);
    assert.equal(pendingMarkReadMap.has('m1'), true);
    assert.equal(settleMarkRead('m1', 'acct', newer), true);
    assert.equal(completedMarkReadMap.has('m1'), true);
  });
});

describe('applyReadGuard', () => {
  test('leaves the batch alone with nothing guarded', () => {
    const rows = [{ id: 'm1', is_read: false }];
    assert.equal(applyReadGuard(rows), rows);
  });

  test('marks a guarded row read, unread_count with it', () => {
    setPending('m1', 'acct');
    assert.deepEqual(applyReadGuard([{ id: 'm1', is_read: false }]), [{ id: 'm1', is_read: true }]);
    assert.deepEqual(applyReadGuard([{ id: 'm1', is_read: false, unread_count: 2 }]), [{ id: 'm1', is_read: true, unread_count: 1 }]);
    assert.deepEqual(applyReadGuard([{ id: 'm2', is_read: false, unread_count: 2 }]), [{ id: 'm2', is_read: false, unread_count: 2 }], 'an unguarded row is untouched');
  });

  test('a guarded row keeps the count it has on screen: a whole conversation marked read stays at 0', () => {
    setPending('m1', 'acct');
    const server = { id: 'm1', is_read: false, unread_count: 2 };
    assert.deepEqual(applyReadGuard([server], [{ id: 'm1', is_read: true, unread_count: 0 }]), [{ id: 'm1', is_read: true, unread_count: 0 }]);
    assert.deepEqual(applyReadGuard([server], [{ id: 'm1', is_read: true, unread_count: 1 }]), [{ id: 'm1', is_read: true, unread_count: 1 }],
      'one read of two unread leaves the other counted');
  });

  test('the count comes only from a row of the same kind', () => {
    setPending('m1', 'acct');
    // A flat row from before a switch to conversations, against the conversation row now served.
    const conversation = { id: 'm1', is_read: false, unread_count: 2, message_count: 3 };
    assert.deepEqual(applyReadGuard([conversation], [{ id: 'm1', is_read: true, unread_count: 0 }]),
      [{ id: 'm1', is_read: true, unread_count: 1, message_count: 3 }]);
  });

  test('a row the server already has read ends the grace period', () => {
    const token = setPending('m1', 'acct');
    settleMarkRead('m1', 'acct', token);
    applyReadGuard([{ id: 'm1', is_read: true }]);
    assert.equal(completedMarkReadMap.has('m1'), false);
  });
});
