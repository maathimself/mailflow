import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDelegation,
  getDelegationSnapshot,
  openDelegation,
  subscribeDelegation,
} from './delegationController.js';

describe('delegation controller', () => {
  it('deduplicates and freezes target ids', () => {
    openDelegation(['m1', 'm1', 'm2']);
    const snapshot = getDelegationSnapshot();
    assert.deepEqual(snapshot.messageIds, ['m1', 'm2']);
    assert.equal(snapshot.phase, 'checking');
    assert.throws(() => snapshot.messageIds.push('m3'));
  });

  it('rejects oversized target sets instead of silently truncating them', () => {
    openDelegation(Array.from({ length: 101 }, (_, index) => `m${index}`));
    const snapshot = getDelegationSnapshot();
    assert.equal(snapshot.phase, 'rejected');
    assert.equal(snapshot.messageIds.length, 101);
  });

  it('replaces targets with the newest open request and notifies subscribers', () => {
    let calls = 0;
    const unsubscribe = subscribeDelegation(() => { calls += 1; });
    openDelegation(['old']);
    openDelegation(['new']);
    unsubscribe();
    assert.deepEqual(getDelegationSnapshot().messageIds, ['new']);
    assert.equal(calls, 2);
  });

  it('resets fully on close', () => {
    openDelegation(['m1']);
    closeDelegation();
    assert.deepEqual(getDelegationSnapshot(), { phase: 'closed', messageIds: [], error: null });
  });
});
