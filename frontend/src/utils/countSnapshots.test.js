import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCountSnapshots, adjustCountPending, expireCountPending, settleCountPending, displayCountSnapshot, mergeFolderSnapshots, PENDING_COUNT_MS, PENDING_SETTLE_MS } from './countSnapshots.js';
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
test('continuous clicks cannot extend the deadline, and expiry adopts the latest observation', () => {
  const initial = sample(10, 20);
  let pending = adjustCountPending({}, initial, 'a', -1, 0);
  pending = adjustCountPending(pending, initial, 'a', -1, 4999);
  assert.equal(pending.a.expiresAt, PENDING_COUNT_MS);
  assert.equal(displayCountSnapshot(sample(8, 20, '3'), pending, accounts, PENDING_COUNT_MS).byAccount.a, 8);
  assert.deepEqual(expireCountPending(pending, PENDING_COUNT_MS), {});
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
