import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCountSnapshots, adjustCountPending, expireCountPending, settleCountPending, displayCountSnapshot, mergeFolderSnapshots, PENDING_COUNT_MS, PENDING_SETTLE_MS } from './countSnapshots.js';
import { UNDO_COMMIT_DELAY_MS } from './undoableAction.js';
const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }, { id: 'x', enabled: true, include_in_unified_inbox: false }];
const sample = (a, b, revision = '1') => ({ byAccount: { a, b, x: 7 }, snapshots: Object.fromEntries(['a', 'b', 'x'].map(id => [id, { revision, known: true, stale: false, observedAt: new Date(0).toISOString() }])) });
test('reflected reads never get subtracted from a newer server snapshot a second time', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'b', -3, 1);
  const updated = mergeCountSnapshots(initial, sample(9, 17, '2'));
  assert.equal(displayCountSnapshot(updated, pending, accounts, 2).total, 26);
  assert.equal(displayCountSnapshot(updated, expireCountPending(pending, 6000), accounts, 6000).total, 26);
});
test('arrivals in another account cannot acknowledge a pending read', () => {
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const updated = sample(9, 21, '2');
  assert.deepEqual(displayCountSnapshot(updated, pending, accounts, 2).byAccount, { a: 9, b: 21, x: 7 });
});
test('a later click gets its own full window, and expiry adopts the latest observation', () => {
  // A deadline fixed at the first click expired before the second click's observation could
  // arrive, and the badge showed the count from before the second click (#701).
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'a', -1, 4999);
  assert.equal(pending.a.expiresAt, 4999 + PENDING_COUNT_MS);
  assert.equal(displayCountSnapshot(initial, pending, accounts, PENDING_COUNT_MS).byAccount.a, 8);
  assert.equal(displayCountSnapshot(sample(8, 20, '3'), pending, accounts, 4999 + PENDING_COUNT_MS).byAccount.a, 8);
  assert.deepEqual(expireCountPending(pending, 4999 + PENDING_COUNT_MS), {});
});

test('an observation of the first read cannot settle a window a second read joined (#701)', () => {
  // Marking two unread messages read 6.5s apart: the count measured after the first arrives
  // past the first read's floor, but before the second can have been observed.
  const initial = sample(3, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'a', -1, 6500);
  const afterFirst = mergeCountSnapshots(initial, sample(2, 20, '2'));
  pending = settleCountPending(pending, afterFirst, 7000);
  assert.equal(displayCountSnapshot(afterFirst, pending, accounts, 7000).byAccount.a, 1);
  const afterSecond = mergeCountSnapshots(afterFirst, sample(1, 20, '3'));
  assert.deepEqual(settleCountPending(pending, afterSecond, 6500 + PENDING_SETTLE_MS), {});
});
test('rollback cancels the deduction; a delayed rollback is bounded by its own fixed window', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'a', 1, 50);
  assert.equal(displayCountSnapshot(initial, pending, accounts, 51).byAccount.a, 10);
  pending = adjustCountPending({}, initial, 'a', 1, 6000);
  assert.equal(displayCountSnapshot(initial, pending, accounts, 6000 + PENDING_COUNT_MS).byAccount.a, 10);
});
test('ordering uses per-account integer revisions without losing 64-bit precision', () => {
  const newer = sample(9, 17, '9007199254740993');
  const old = sample(10, 20, '9007199254740992');
  assert.deepEqual(mergeCountSnapshots(newer, old).byAccount, newer.byAccount);
});
test('a failed observation retains count but supersedes the old success freshness', () => {
  const initial = sample(10, 20);
  const failed = sample(10, 20);
  failed.snapshots.a = { ...failed.snapshots.a, attemptRevision: '2', stale: true };
  const next = mergeCountSnapshots(initial, failed);
  assert.equal(mergeCountSnapshots(next, initial).snapshots.a.stale, true);
});
test('unknown counts stay unknown and time alone can make a count stale', () => {
  const initial = sample(null, 20);
  initial.snapshots.a.known = false;
  assert.deepEqual(adjustCountPending({}, initial, 'a', -1, 0), {});
  assert.equal(displayCountSnapshot(initial, {}, accounts, 0).complete, false);
  assert.equal(displayCountSnapshot(sample(10,20), {}, accounts, 180001).snapshots.a.stale, true);
});
test('folder responses cannot overwrite a later observation or reintroduce removed folders', () => {
  const old = [{ path: 'INBOX', unread_count: 4, status_attempt_revision: '3' }, { path: 'removed' }];
  const incoming = [{ path: 'INBOX', unread_count: 5, status_attempt_revision: '2', name: 'Inbox' }];
  const [folder] = mergeFolderSnapshots(old, incoming);
  assert.equal(folder.unread_count, 4);
  assert.equal(folder.name, 'Inbox');
  assert.equal(mergeFolderSnapshots(old, incoming).length, 1);
});

test('the window outlives the observation path it is waiting for', () => {
  // The bounce: the backend debounces its mutation-triggered STATUS by 5s and then needs a
  // connect, login and STATUS on top, measured at 1-2s. A window shorter than that reverted the
  // badge before its own replacement value arrived, on every read, move and archive.
  assert.ok(PENDING_COUNT_MS > 8000, 'backstop must outlast a slow observation path');
  assert.ok(PENDING_SETTLE_MS > 5000, 'settle floor must clear the backend mutation debounce');
  assert.ok(PENDING_SETTLE_MS < PENDING_COUNT_MS, 'the floor must be reachable before the backstop');
});

test('an observation taken too soon after the mutation cannot settle the window', () => {
  // A routine poll can land moments after the click, BEFORE the IMAP flag write. Settling on it
  // would reinstate exactly the bounce this mechanism exists to remove.
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const newer = mergeCountSnapshots(initial, sample(10, 20, '2'));
  assert.deepEqual(settleCountPending(pending, newer, PENDING_SETTLE_MS - 1), pending);
  assert.equal(displayCountSnapshot(newer, pending, accounts, PENDING_SETTLE_MS - 1).byAccount.a, 9);
});

test('the first observation past the floor settles the window and hands back the server value', () => {
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const newer = mergeCountSnapshots(initial, sample(9, 20, '2'));
  const settled = settleCountPending(pending, newer, PENDING_SETTLE_MS);
  assert.deepEqual(settled, {});
  assert.equal(displayCountSnapshot(newer, settled, accounts, PENDING_SETTLE_MS).byAccount.a, 9);
});

test('settling reads the observation revision, never the count it carries', () => {
  // Same revision means no new observation has been taken, whatever the number says. A total
  // that happens to match cannot acknowledge a specific read: arrivals and other-account
  // changes cancel out.
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  const sameRevisionLowerCount = mergeCountSnapshots(initial, sample(9, 20, '1'));
  assert.deepEqual(settleCountPending(pending, sameRevisionLowerCount, PENDING_SETTLE_MS + 1000), pending);
  const older = { byAccount: { a: 9 }, snapshots: { a: { revision: '0', known: true } } };
  assert.deepEqual(settleCountPending(pending, older, PENDING_SETTLE_MS + 1000), pending);
});

test('windows settle independently, and each keeps its own floor', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'b', -2, 4000);
  const newer = mergeCountSnapshots(initial, sample(9, 18, '2'));
  const settled = settleCountPending(pending, newer, 7000);
  assert.equal(settled.a, undefined, 'a is 7000ms past its mutation');
  assert.ok(settled.b, 'b is only 3000ms past its own');
  assert.equal(displayCountSnapshot(newer, settled, accounts, 7000).byAccount.a, 9);
  assert.equal(displayCountSnapshot(newer, settled, accounts, 7000).byAccount.b, 18);
});

test('an observation from before a held delete was sent cannot settle it (#701)', () => {
  // Deleting three unread messages one at a time. Each delete reaches the server only when its
  // undo window closes, so the observation of the first lands after the second was clicked and
  // the third's lands last. Counted from the click, that first observation settled the window
  // and the badge went back up; after the last delete it showed 1 until its own STATUS came in.
  const held = { commitDelayMs: UNDO_COMMIT_DELAY_MS };
  const accountsA = [{ id: 'a', enabled: true }];
  let server = mergeCountSnapshots(sample(3, 0), sample(3, 0));
  let pending = adjustCountPending({}, displayCountSnapshot(server, {}, accountsA, 0), 'a', -1, 0, held);
  const shown = now => displayCountSnapshot(server, pending, accountsA, now).byAccount.a;
  const observe = (count, rev, now) => {
    server = mergeCountSnapshots(server, sample(count, 0, rev));
    pending = settleCountPending(pending, server, now);
  };
  const remove = now => {
    pending = adjustCountPending(pending, displayCountSnapshot(server, pending, accountsA, now), 'a', -1, now, held);
  };
  assert.equal(shown(0), 2);
  remove(6600);
  assert.equal(shown(6600), 1);
  observe(2, '2', 10600);
  assert.equal(shown(10600), 1, 'the first delete\'s observation predates the second being sent');
  remove(13000);
  assert.equal(shown(13000), 0);
  observe(1, '3', 17200);
  assert.equal(shown(17200), 0, 'the second delete\'s observation predates the last being sent');
  observe(0, '4', 23900);
  assert.deepEqual(pending, {}, 'the last delete\'s own observation settles it');
  assert.equal(shown(23900), 0);
});

test('a held change still has a backstop, counted from when it is sent', () => {
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0, { commitDelayMs: UNDO_COMMIT_DELAY_MS });
  assert.equal(pending.a.expiresAt, UNDO_COMMIT_DELAY_MS + PENDING_COUNT_MS);
  assert.equal(displayCountSnapshot(initial, pending, accounts, PENDING_COUNT_MS).byAccount.a, 9,
    'still waiting for the observation of a change sent 4.75s after the click');
  assert.deepEqual(expireCountPending(pending, UNDO_COMMIT_DELAY_MS + PENDING_COUNT_MS), {});
});

test('the backstop still applies when the observation never arrives', () => {
  const initial = sample(10, 20);
  const pending = adjustCountPending({}, initial, 'a', -1, 0);
  assert.deepEqual(settleCountPending(pending, initial, PENDING_COUNT_MS), {},
    'a window whose replacement never came must not survive its deadline');
});

test('a window missing its watermark falls back to the backstop rather than settling early', () => {
  // Defensive: an entry from an older client build, or hand-rolled state, must degrade to the
  // previous time-based behaviour instead of settling on the next observation.
  const initial = sample(10, 20);
  const legacy = { a: { base: 10, delta: -1, expiresAt: PENDING_COUNT_MS } };
  const newer = mergeCountSnapshots(initial, sample(9, 20, '2'));
  assert.deepEqual(settleCountPending(legacy, newer, PENDING_SETTLE_MS + 1000), legacy);
  assert.deepEqual(settleCountPending(legacy, newer, PENDING_COUNT_MS), {});
});
import { unreadDeltaByAccount } from './countSnapshots.js';

describe('unreadDeltaByAccount (#476 badge attribution)', () => {
  it('splits a cross-account conversation unread delta per account', () => {
    const msgs = [
      { id: 'w', account_id: 'work', is_read: false },
      { id: 'h', account_id: 'home', is_read: false },
    ];
    const d = unreadDeltaByAccount(msgs, true, 'work');
    assert.deepEqual([...d.entries()].sort(), [['home', 1], ['work', 1]]);
  });

  it('counts only messages whose state actually changes', () => {
    const msgs = [
      { id: 'a', account_id: 'work', is_read: true },   // already read: no change when marking read
      { id: 'b', account_id: 'work', is_read: false },
    ];
    assert.deepEqual([...unreadDeltaByAccount(msgs, true, 'work')], [['work', 1]]);
    assert.deepEqual([...unreadDeltaByAccount(msgs, false, 'work')], [['work', 1]]);
  });

  it('charges a message with no account to the acted-on row account', () => {
    const msgs = [{ id: 'x', is_read: false }];
    assert.deepEqual([...unreadDeltaByAccount(msgs, true, 'work')], [['work', 1]]);
  });

  it('is empty when nothing changes', () => {
    assert.equal(unreadDeltaByAccount([{ id: 'a', account_id: 'work', is_read: true }], true, 'work').size, 0);
    assert.equal(unreadDeltaByAccount(null, true, 'work').size, 0);
  });
});
