import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};
const { useStore } = await import('./index.js');
const { api } = await import('../utils/api.js');
const { SIGN_OUT_CLEARED_KEYS } = await import('../utils/signOut.js');
globalThis.window = new EventTarget();

const s = () => useStore.getState();

// What App.jsx does when a request comes back 401. The page is not reloaded, so whoever signs
// in next in this tab gets the store the previous user left behind.
function sessionExpires() {
  s().setUser(null);
  s().setLocked(false);
}

// Compared with the store's own initial values, so a field dropped from the reset, or a reset
// value that no longer matches the default, fails by name.
function assertDefaults(fields) {
  for (const key of Object.keys(fields)) assert.deepEqual(s()[key], useStore.getInitialState()[key], key);
}

beforeEach(() => { s().setUser({ id: 'alice' }); });
afterEach(() => { s().setUser(null); mem.clear(); });

test('the next user is not shown the compose that was left open', () => {
  s().openCompose({
    accountId: 'acct-a', isReply: true,
    to: ['hr@example.invalid'], subject: 'Re: Disciplinary hearing', quotedBody: 'Confidential',
  });
  // The mounted composer registers how to save itself before another compose replaces it.
  s().setPrepareComposeSwitch(async () => true);
  sessionExpires();
  s().setUser({ id: 'bob' });
  assert.equal(s().composing, false);
  assert.equal(s().composeData, null);
  assert.equal(s().prepareComposeSwitch, null);
});

test('nor the mailbox that was on screen', () => {
  const mailbox = {
    accounts: [{ id: 'acct-a', enabled: true }], accountsReady: true,
    folders: { 'acct-a': [{ path: 'HR' }] },
    messages: [{ id: 'm1', account_id: 'acct-a', subject: 'Salary review' }], selectedMessageId: 'm1',
    searchQuery: 'salary', searchResults: [{ id: 'm1', account_id: 'acct-a', subject: 'Salary review' }],
    threadMessages: { t1: [{ id: 'm1', subject: 'Salary review' }] }, expandedThreadId: 't1',
    replyDrafts: { m1: { exists: true, accountId: 'acct-a', source: 'live' } },
    messageWindows: [{ id: 1, messageId: 'm1' }],
    notifications: [{ id: 1, title: 'Snoozed', body: 'Salary review' }],
    backfillProgress: { 'acct-a': { synced: 10, total: 20 } },
    gtdSections: { now: [{ id: 'm1', subject: 'Salary review' }] }, categoryCounts: { updates: 3 },
    activeGtdTab: 'now',
  };
  useStore.setState(mailbox);
  sessionExpires();
  s().setUser({ id: 'bob' });
  assertDefaults(mailbox);
});

test('nor the message that was open when the screen was locked', () => {
  // Five wrong PINs end the session the same way, and leaving the lock restores the message
  // that was open when it was locked.
  s().setSelectedMessage('m1');
  s().setLocked(true);
  sessionExpires();
  s().setUser({ id: 'bob' });
  assert.equal(s().selectedMessageId, null);
});

test('nor the message open at the lock when the page reloads while Sign out waits for the server', () => {
  s().setSelectedMessage('m1');
  s().setLocked(true);
  api.logout = () => new Promise(() => {});
  s().signOut();
  // The new page has no user yet, and /me comes back 401 because the sign-out did reach the
  // server, so App.jsx clears the user and the lock.
  useStore.setState({ user: null });
  s().setUser(null);
  s().setLocked(false);
  s().setUser({ id: 'bob' });
  assert.equal(s().selectedMessageId, null);
});

test('nor the settings held only in memory', () => {
  // loadPreferences replaces enabledPlugins and aiActions only once it resolves, and the rest
  // only when the new user has saved them.
  const settings = {
    enabledPlugins: ['gtd'], aiActions: [{ id: 'hr', label: 'Summarise for HR', prompt: 'Summarise' }],
    blockRemoteImages: false, imageWhitelist: { addresses: ['sender@example.invalid'], domains: [] },
    hiddenFolders: { 'acct-a': ['HR'] }, shortcuts: { archive: 'z' }, autoLockMinutes: 5,
    categorizationEnabled: true, gtdPetSlug: 'cat',
    autoOpenReplyDrafts: true, afterRemove: 'list', darkEmailBodies: false,
    favoriteFolders: [{ accountId: 'acct-a', path: 'HR' }], recentFolders: [{ accountId: 'acct-a', path: 'HR' }],
    defaultSender: 'account:acct-a', collapsedFolders: ['acct-a:HR'], expandedAccounts: { 'acct-a': true },
  };
  useStore.setState(settings);
  sessionExpires();
  s().setUser({ id: 'bob' });
  assertDefaults(settings);
});

test('dark email bodies start on, for whoever has not chosen', () => {
  assert.equal(useStore.getInitialState().darkEmailBodies, true);
});

test('updating the signed-in user keeps their compose and mailbox', () => {
  // Settings call setUser with the same user after a PIN or 2FA change.
  s().setAccounts([{ id: 'acct-a', enabled: true }]);
  s().openCompose({ subject: 'Half written' });
  s().setUser({ id: 'alice', hasLockPin: true });
  assert.equal(s().composing, true);
  assert.equal(s().accounts.length, 1);
});

test('unlocking reopens the message that was open at the lock, after a reload too', () => {
  s().setSelectedMessage('m1');
  s().setLocked(true);
  s().setLocked(false);
  assert.equal(s().selectedMessageId, 'm1');
  // Locked again, then reloaded: /me finds the session alive and locked, so App.jsx signs the
  // user back in and locks before the PIN unlocks it (#235).
  s().setLocked(true);
  useStore.setState({ user: null });
  s().setUser({ id: 'alice' });
  s().setLocked(true);
  s().setLocked(false);
  assert.equal(s().selectedMessageId, 'm1');
});

test('a cold load that finds the locked session expired does not reopen its message for the next user', () => {
  // The browser closed behind the lock and the session expired. The next load starts with no
  // user, /me answers 401, and App.jsx clears the user and the lock; the login page then signs
  // the next user in without a reload.
  s().setSelectedMessage('m1');
  s().setLocked(true);
  useStore.setState({ user: null });
  s().setUser(null);
  s().setLocked(false);
  s().setUser({ id: 'bob' });
  assert.equal(s().selectedMessageId, null);
  // Nor once they lock and unlock themselves.
  s().setLocked(true);
  s().setLocked(false);
  assert.equal(s().selectedMessageId, null);
});

test('a cold load keeps the reading preferences the store seeded from localStorage', () => {
  // The store reads these two from localStorage when it is created, so they apply before
  // loadPreferences answers. App.jsx then calls setUser with the signed-in user, going from no
  // user to one; there is no previous user's state to clear.
  s().setUser(null);
  useStore.setState({ autoOpenReplyDrafts: true, afterRemove: 'previous' });
  s().setUser({ id: 'alice' });
  assert.equal(s().autoOpenReplyDrafts, true);
  assert.equal(s().afterRemove, 'previous');
});

test('Sign out clears what the shared sign-out clears, and the lock once the server confirmed it', async () => {
  s().setLocked(true);
  const keys = [...SIGN_OUT_CLEARED_KEYS, 'mailflow_locked_message', 'mailflow_locked'];
  for (const k of keys) localStorage.setItem(k, '1');
  window.location = { href: 'https://mail.example.invalid/' };
  api.logout = async () => ({ ok: true, endSessionUrl: null });
  await s().signOut();
  assert.equal(window.location.href, '/login');
  assert.equal(s().isLocked, false);
  for (const k of keys) assert.equal(localStorage.getItem(k), null, k);
});
