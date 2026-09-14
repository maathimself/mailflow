import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');
const { PENDING_COUNT_MS, PENDING_SETTLE_MS } = await import('../utils/countSnapshots.js');
globalThis.window = new EventTarget();
const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }];
const snapshot = (a, b, revision = '1') => ({ byAccount: { a, b }, snapshots: Object.fromEntries(['a','b'].map(id => [id, { revision, known: true, stale: false, observedAt: new Date().toISOString() }])) });
beforeEach(() => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  useStore.getState().setUser({ id: 'u' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts(accounts);
  useStore.getState().setUnreadCounts(snapshot(10,20));
});
afterEach(() => { useStore.getState().setLocked(true); mock.timers.reset(); });
test('actual store retires each account window on its own backstop when no observation arrives', () => {
  let refreshes = 0;
  const refresh = () => refreshes++;
  window.addEventListener('mailflow:counts_refresh', refresh);
  const store = useStore.getState();
  store.decrementUnread('a');
  mock.timers.tick(4000);
  store.decrementUnread('b', 2);
  assert.equal(useStore.getState().unreadCounts.total,27);
  mock.timers.tick(PENDING_COUNT_MS - 4000);
  assert.equal(useStore.getState().pendingCounts.a,undefined);
  assert.ok(useStore.getState().pendingCounts.b,'a later mutation keeps its own full window');
  mock.timers.tick(4000);
  assert.deepEqual(useStore.getState().pendingCounts,{});
  assert.equal(useStore.getState().unreadCounts.total,30,'adopts the server value it never heard back about');
  assert.equal(refreshes,2);
  window.removeEventListener('mailflow:counts_refresh',refresh);
});

test('actual store settles on the observation the mutation triggered, without a visible bounce', () => {
  // The user-visible regression: the window closed on a fixed 5s timer while the observation
  // that replaces it needed the backend's 5s debounce plus a connect, login and STATUS. The
  // badge reverted to the pre-read count for 1-2s on every read, move and archive.
  let refreshes = 0;
  const refresh = () => refreshes++;
  window.addEventListener('mailflow:counts_refresh', refresh);
  const store = useStore.getState();
  store.decrementUnread('a');
  assert.equal(useStore.getState().unreadCounts.byAccount.a,9);
  mock.timers.tick(PENDING_SETTLE_MS - 3000);
  store.setUnreadCounts(snapshot(10,20,'2'));
  assert.equal(useStore.getState().unreadCounts.byAccount.a,9,'a poll taken before the floor cannot revert it');
  mock.timers.tick(3000);
  store.setUnreadCounts(snapshot(9,20,'3'));
  assert.deepEqual(useStore.getState().pendingCounts,{},'the triggered observation retires the window');
  assert.equal(useStore.getState().unreadCounts.byAccount.a,9,'settles to the server value with nothing visible');
  mock.timers.tick(PENDING_COUNT_MS * 2);
  assert.equal(useStore.getState().unreadCounts.byAccount.a,9,'and never bounces afterwards');
  assert.equal(refreshes,0,'a settled window must not leave its backstop timer armed');
  window.removeEventListener('mailflow:counts_refresh',refresh);
});
test('locking cancels pending work and rejects delayed snapshots', () => {
  useStore.getState().decrementUnread('a');
  useStore.getState().setLocked(true);
  useStore.getState().setUnreadCounts(snapshot(9,20,'2'));
  mock.timers.tick(10000);
  assert.deepEqual(useStore.getState().unreadCounts.byAccount,{});
  assert.deepEqual(useStore.getState().pendingCounts,{});
});
test('changing unified scope does not turn the displayed optimistic count into a new baseline', () => {
  useStore.getState().decrementUnread('a');
  useStore.getState().updateAccount('b',{ include_in_unified_inbox: false });
  assert.equal(useStore.getState().unreadCounts.total,9);
  assert.equal(useStore.getState().serverUnreadCounts.byAccount.a,10);
  mock.timers.tick(PENDING_COUNT_MS);
  assert.equal(useStore.getState().unreadCounts.total,10);
});
