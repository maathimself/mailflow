import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inInbox, inboxShare, inboxUnreadByAccount, rowInboxUnread, inboxMoveDelta } from './inboxBadge.js';

describe('inboxBadge: only INBOX mail is in the account badge', () => {
  it('knows a message as in INBOX by its folder alone', () => {
    assert.equal(inInbox({ folder: 'INBOX' }), true);
    assert.equal(inInbox({ folder: 'Archive' }), false);
    assert.equal(inInbox({ folder: 'INBOX.Newsletters' }), false, 'a subfolder of INBOX is its own folder');
    assert.equal(inInbox({ folder: 'Inbox' }), false, 'the badge reads the folder named INBOX');
    assert.equal(inInbox({}), false, 'no folder: not known to be in INBOX');
    assert.equal(inInbox(null), false);
  });

  it('inboxShare charges the count for INBOX mail and nothing else', () => {
    assert.equal(inboxShare({ folder: 'INBOX' }), 1);
    assert.equal(inboxShare({ folder: 'INBOX' }, 3), 3);
    assert.equal(inboxShare({ folder: 'Newsletters' }, 3), 0);
    assert.equal(inboxShare({ folder: 'INBOX' }, 0), 0);
    assert.equal(inboxShare({ folder: 'INBOX' }, -2), 0);
    assert.equal(inboxShare({ folder: 'INBOX' }, Number.NaN), 0);
  });

  it('inboxUnreadByAccount counts unread INBOX messages per account', () => {
    const counts = inboxUnreadByAccount([
      { account_id: 'a', folder: 'INBOX', is_read: false },
      { account_id: 'a', folder: 'INBOX', is_read: true },
      { account_id: 'a', folder: 'Archive', is_read: false },
      { account_id: 'b', folder: 'INBOX', is_read: false },
      { account_id: 'b', folder: 'Sent', is_read: false },
      { folder: 'INBOX', is_read: false },
      null,
    ]);
    assert.deepEqual([...counts].sort(), [['a', 1], ['b', 1]]);
    assert.equal(inboxUnreadByAccount(null).size, 0);
  });

  it('rowInboxUnread: a thread row its own count, a single row one, a row outside INBOX nothing', () => {
    assert.equal(rowInboxUnread({ folder: 'INBOX', unread_count: 3, is_read: false }, true), 3);
    assert.equal(rowInboxUnread({ folder: 'INBOX', unread_count: 0, is_read: true }, true), 0);
    assert.equal(rowInboxUnread({ folder: 'INBOX', is_read: false }, true), 1, 'no count on the row: the row itself');
    assert.equal(rowInboxUnread({ folder: 'INBOX', unread_count: 3, is_read: false }, false), 1, 'a single row is one message');
    assert.equal(rowInboxUnread({ folder: 'INBOX', is_read: true }, false), 0);
    assert.equal(rowInboxUnread({ folder: 'Projects', unread_count: 3, is_read: false }, true), 0);
    assert.equal(rowInboxUnread({ folder: 'Projects', is_read: false }, false), 0);
  });

  it('inboxMoveDelta: down leaving INBOX, up arriving, nothing between two other folders or for read mail', () => {
    const unread = folder => ({ folder, is_read: false });
    assert.equal(inboxMoveDelta(unread('INBOX'), 'Archive'), -1);
    assert.equal(inboxMoveDelta(unread('Archive'), 'INBOX'), 1);
    assert.equal(inboxMoveDelta(unread('Archive'), 'Projects'), 0);
    assert.equal(inboxMoveDelta(unread('INBOX'), 'INBOX'), 0);
    assert.equal(inboxMoveDelta({ folder: 'Archive', is_read: true }, 'INBOX'), 0);
    assert.equal(inboxMoveDelta(unread('Spam'), 'INBOX', 2), 2);
    assert.equal(inboxMoveDelta(null, 'INBOX'), 0);
  });
});
