import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMessageListEmptyVisual } from './messageListEmptyState.js';

test('uses the pet visual only for an unfiltered empty inbox', () => {
  const base = {
    folderSyncing: false,
    searchQuery: '',
    unreadOnly: false,
    hasAccounts: true,
    selectedFolder: 'INBOX',
  };

  assert.equal(resolveMessageListEmptyVisual(base), 'inbox-zero');
  assert.equal(resolveMessageListEmptyVisual({ ...base, selectedFolder: null }), 'inbox-zero');
  assert.equal(resolveMessageListEmptyVisual({ ...base, selectedFolder: 'Archive' }), 'folder');
  assert.equal(resolveMessageListEmptyVisual({ ...base, searchQuery: 'invoice' }), 'search');
  assert.equal(resolveMessageListEmptyVisual({ ...base, unreadOnly: true }), 'unread');
  assert.equal(resolveMessageListEmptyVisual({ ...base, folderSyncing: true }), 'syncing');
  assert.equal(resolveMessageListEmptyVisual({ ...base, hasAccounts: false }), 'no-accounts');
});
