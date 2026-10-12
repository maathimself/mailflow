// Run with: node --test src/utils/signOut.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signOut, SIGN_OUT_CLEARED_KEYS } from './signOut.js';

function memoryStorage(entries) {
  const data = new Map(Object.entries(entries));
  return { data, removeItem: k => data.delete(k), getItem: k => (data.has(k) ? data.get(k) : null) };
}

async function run(logout) {
  const storage = memoryStorage({ mailflow_expanded_accounts: '{"a":true}', mailflow_collapsed_folders: '[]', mailflow_theme: 'light' });
  const calls = { user: undefined, url: null };
  await signOut({ setUser: u => { calls.user = u; }, storage, logout, navigate: url => { calls.url = url; } });
  return { ...calls, storage };
}

describe('signOut (#523, #310)', () => {
  it('follows the SSO end-session URL when the server returns one', async () => {
    const r = await run(async () => ({ ok: true, endSessionUrl: 'https://sso.example/end?id_token_hint=x' }));
    assert.equal(r.url, 'https://sso.example/end?id_token_hint=x');
    assert.equal(r.user, null);
  });

  it('goes to /login without one, and when the request fails', async () => {
    assert.equal((await run(async () => ({ ok: true, endSessionUrl: null }))).url, '/login');
    assert.equal((await run(async () => { throw new Error('offline'); })).url, '/login');
  });

  it('clears the signed-out user\'s mailbox state and keeps appearance settings', async () => {
    const { storage } = await run(async () => ({ ok: true }));
    assert.equal(storage.getItem('mailflow_expanded_accounts'), null);
    assert.equal(storage.getItem('mailflow_collapsed_folders'), null);
    assert.equal(storage.getItem('mailflow_theme'), 'light');
    assert.ok(SIGN_OUT_CLEARED_KEYS.includes('mailflow_expanded_accounts'));
  });

  it('clears the reading and reply-draft preferences, which the next sign-in would otherwise start from', async () => {
    const storage = memoryStorage({ mailflow_after_remove: 'previous', mailflow_auto_open_reply_drafts: 'true', mailflow_theme: 'light' });
    await signOut({ setUser: () => {}, storage, logout: async () => ({ ok: true }), navigate: () => {} });
    assert.equal(storage.getItem('mailflow_after_remove'), null);
    assert.equal(storage.getItem('mailflow_auto_open_reply_drafts'), null);
    assert.equal(storage.getItem('mailflow_theme'), 'light');
  });
});
