import test from 'node:test';
import assert from 'node:assert/strict';
import { mailboxQueryScope, mailboxTitle } from './mailboxQuery.js';

test('All Mail sends its scope while unified Inbox keeps the legacy request', () => {
  assert.deepEqual(mailboxQueryScope(null, 'ALL_MAIL'), { folder: 'ALL_MAIL' });
  assert.deepEqual(mailboxQueryScope(null, 'INBOX'), {});
  assert.deepEqual(mailboxQueryScope('account-1', 'Sent'), { accountId: 'account-1', folder: 'Sent' });
});

test('All Mail title reports indexing until the server marks it complete', () => {
  assert.equal(mailboxTitle(null, 'ALL_MAIL', false, 'All Inboxes'), 'All Mail (syncing)');
  assert.equal(mailboxTitle(null, 'ALL_MAIL', true, 'All Inboxes'), 'All Mail');
});
