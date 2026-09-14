import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const store_ = new Map();
const writes = [];
globalThis.localStorage = {
  getItem: k => (store_.has(k) ? store_.get(k) : null),
  setItem: (k, v) => { writes.push(k); store_.set(k, String(v)); },
  removeItem: k => { writes.push(k); store_.delete(k); },
};
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();

beforeEach(() => {
  useStore.getState().setUser({ id: 'u' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([
    { id: 'a1', name: 'Sales', email_address: 'sales@example.com', enabled: true },
    { id: 'a2', name: 'Support', email_address: 'support@example.com', enabled: true },
  ]);
  useStore.getState().setSelectedAccount('a2', 'INBOX');
  useStore.getState().setAccountFilter('');
});
afterEach(() => { useStore.getState().setLocked(true); store_.clear(); });

test('the account filter starts empty', () => {
  assert.equal(useStore.getState().accountFilter, '');
});

test('setting the filter changes neither the accounts, the selection nor unread counts', () => {
  const before = useStore.getState();
  const { accounts, selectedAccountId, selectedFolder, unreadCounts } = before;

  useStore.getState().setAccountFilter('sales');

  const after = useStore.getState();
  assert.equal(after.accountFilter, 'sales');
  assert.equal(after.accounts, accounts, 'the account array keeps its identity');
  assert.equal(after.selectedAccountId, selectedAccountId, 'a hidden selected account stays selected');
  assert.equal(after.selectedFolder, selectedFolder);
  assert.equal(after.unreadCounts, unreadCounts);
});

test('the filter is kept only in memory, never in localStorage', () => {
  writes.length = 0;
  useStore.getState().setAccountFilter('support');
  useStore.getState().setAccountFilter('');
  assert.deepEqual(writes, []);
});

test('clearing the filter restores the empty query', () => {
  useStore.getState().setAccountFilter('sales');
  useStore.getState().setAccountFilter('');
  assert.equal(useStore.getState().accountFilter, '');
});
