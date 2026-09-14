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
globalThis.window = new EventTarget();

const LIVE = { id: 'live', enabled: true };
beforeEach(() => {
  useStore.getState().setUser({ id: 'u' });
  useStore.getState().setLocked(false);
  useStore.getState().setAccounts([LIVE, { id: 'doomed', enabled: true }]);
});
afterEach(() => { useStore.getState().setLocked(true); store_.clear(); });

test('actual store releases a selection whose account has been deleted', () => {
  const s = useStore.getState();
  s.setSelectedAccount('doomed', 'Archive');
  s.setFolders('doomed', [{ path: 'INBOX' }]);
  s.setFolders('live', [{ path: 'INBOX' }]);
  assert.equal(useStore.getState().selectedAccountId, 'doomed');

  useStore.getState().setAccounts([LIVE]);   // the account is deleted server-side

  const after = useStore.getState();
  assert.equal(after.selectedAccountId, null, 'falls back to the unified inbox');
  assert.equal(after.selectedFolder, 'INBOX', 'a folder scoped to the dead account is dropped too');
  assert.deepEqual(Object.keys(after.folders), ['live'], 'stops polling folders that 404');
  assert.equal(localStorage.getItem('mailflow_selected_account'), '',
    'the fallback must survive a reload, or localStorage restores the dead id');
});

test('actual store leaves a still-valid selection untouched', () => {
  const s = useStore.getState();
  s.setSelectedAccount('doomed', 'Archive');
  useStore.getState().setAccounts([LIVE, { id: 'doomed', enabled: true }]);
  const after = useStore.getState();
  assert.equal(after.selectedAccountId, 'doomed');
  assert.equal(after.selectedFolder, 'Archive', 'an unrelated account refresh must not reset navigation');
});

test('the favicon count recovers, which is how this surfaced', () => {
  const s = useStore.getState();
  s.setSelectedAccount('doomed', 'INBOX');
  s.setUnreadCounts({ byAccount: { live: 3 }, snapshots: { live: { revision: '1', known: true, stale: false, observedAt: new Date().toISOString() } } });
  // MailApp: selectedAccountId ? (byAccount[selectedAccountId] ?? 0) : total
  const favicon = () => { const st = useStore.getState();
    return st.selectedAccountId ? (st.unreadCounts.byAccount[st.selectedAccountId] ?? 0) : st.unreadCounts.total; };
  assert.equal(favicon(), 0, 'the reported symptom: no badge despite unread mail elsewhere');
  useStore.getState().setAccounts([LIVE]);
  assert.equal(favicon(), 3, 'and it comes back once the dead selection is released');
});
