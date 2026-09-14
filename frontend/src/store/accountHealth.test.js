import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const store_ = new Map();
globalThis.localStorage = {
  getItem: k => (store_.has(k) ? store_.get(k) : null),
  setItem: (k, v) => store_.set(k, String(v)),
  removeItem: k => store_.delete(k),
};
const { useStore } = await import('./index.js');
const { accountEventPatch } = await import('../utils/accountHealth.js');
globalThis.window = new EventTarget();

const account = (overrides) => ({
  id: 'a1', enabled: true, oauth_provider: 'google', oauth_reconnect_required: false,
  sync_error: null, last_sync: new Date().toISOString(), health: 'healthy', ...overrides,
});
const health = () => useStore.getState().accounts.find(a => a.id === 'a1').health;

beforeEach(() => {
  useStore.getState().setUser({ id: 'u' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([account()]);
});
afterEach(() => { useStore.getState().setLocked(true); store_.clear(); });

test('an account_error patch marks the account failed provisionally', () => {
  useStore.getState().updateAccount('a1', { sync_error: 'Connection refused' });
  assert.equal(health(), 'failed');
});

test('a reconnect-required code pushed over WebSocket shows reconnect before the flag refresh', () => {
  useStore.getState().updateAccount('a1', { sync_error: 'oauth_reconnect_required' });
  assert.equal(health(), 'oauth_reconnect_required');
});

test('an account_connected patch clears a failure', () => {
  useStore.getState().setAccounts([account({ sync_error: 'Connection refused', health: 'failed' })]);
  useStore.getState().updateAccount('a1', { sync_error: null });
  assert.equal(health(), 'healthy');
});

test('a patch that does not touch a health field keeps the server code', () => {
  useStore.getState().setAccounts([account({ last_sync: null, health: 'stale' })]);
  useStore.getState().updateAccount('a1', { name: 'Renamed' });
  assert.equal(health(), 'stale');
});

test('an account_connected patch on a page open past the stale window never marks a healthy account stale', () => {
  const oldSync = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  useStore.getState().setAccounts([account({ last_sync: oldSync, health: 'healthy' })]);
  useStore.getState().updateAccount('a1', accountEventPatch('account_connected', { accountId: 'a1' }));
  assert.equal(health(), 'healthy');
});

test('an account_connected patch clears reconnect-required in other browsers', () => {
  useStore.getState().setAccounts([account({
    oauth_reconnect_required: true, sync_error: 'oauth_reconnect_required', health: 'oauth_reconnect_required',
  })]);
  useStore.getState().updateAccount('a1', accountEventPatch('account_connected', { accountId: 'a1' }));
  const a = useStore.getState().accounts.find(x => x.id === 'a1');
  assert.equal(a.oauth_reconnect_required, false);
  assert.equal(a.health, 'healthy');
});
