import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveTargetsForFolder,
  currentThreadLoadVersion,
  findVisibleArchiveMessage,
  invalidateThreadLoad,
  isCurrentThreadLoad,
  removeThreadCacheEntry,
  unreadCountsByAccount,
} from './threadedArchive.js';

describe('findVisibleArchiveMessage', () => {
  const parent = { id: 'head', thread_id: 'thread-1', message_count: 3 };
  const sibling = { id: 'other', thread_id: 'thread-2', message_count: 2 };
  const messages = [parent, sibling];
  const threadMessages = {
    'thread-1': [{ id: 'oldest' }, { id: 'middle' }, { id: 'head' }],
    'thread-2': [{ id: 'other-child' }, { id: 'other' }],
  };

  it('returns the selected visible row directly', () => {
    assert.equal(findVisibleArchiveMessage(messages, 'head', threadMessages), parent);
  });

  it('maps an expanded sub-message selection back to its visible thread row', () => {
    assert.equal(findVisibleArchiveMessage(messages, 'middle', threadMessages), parent);
  });

  it('returns null when the selection is no longer represented in the list', () => {
    assert.equal(findVisibleArchiveMessage(messages, 'missing', threadMessages), null);
  });
});

describe('unreadCountsByAccount', () => {
  it('groups only unread archive targets by account', () => {
    assert.deepEqual(
      [...unreadCountsByAccount([
        { account_id: 'account-1', is_read: false },
        { account_id: 'account-1', is_read: true },
        { account_id: 'account-2', is_read: false },
      ])],
      [['account-1', 1], ['account-2', 1]],
    );
  });
});

describe('thread load invalidation', () => {
  it('rejects an in-flight load captured before cache invalidation', () => {
    const versions = new Map();
    const captured = currentThreadLoadVersion(versions, 'thread-1');
    assert.equal(isCurrentThreadLoad(versions, 'thread-1', captured), true);
    invalidateThreadLoad(versions, 'thread-1');
    assert.equal(isCurrentThreadLoad(versions, 'thread-1', captured), false);
  });

  it('removes a cache key without leaving a non-array sentinel behind', () => {
    const cache = { 'thread-1': [{ id: 'one' }], 'thread-2': [{ id: 'two' }] };
    const next = removeThreadCacheEntry(cache, 'thread-1');
    assert.equal(Object.hasOwn(next, 'thread-1'), false);
    assert.deepEqual(next['thread-2'], [{ id: 'two' }]);
    assert.deepEqual(cache['thread-1'], [{ id: 'one' }]);
  });
});

describe('archiveTargetsForFolder', () => {
  const parent = { id: 'head', folder: 'INBOX', thread_id: 'thread-1', message_count: 4 };
  const resolved = [
    { id: 'oldest', account_id: 'account-1', folder: 'INBOX' },
    { id: 'sent-reply', account_id: 'account-1', folder: 'Sent' },
    { id: 'head', account_id: 'account-1', folder: 'INBOX' },
    { id: 'other-account', account_id: 'account-2', folder: 'INBOX' },
    { id: 'oldest', account_id: 'account-1', folder: 'INBOX' },
  ];

  it('archives every unique member in the active folder but leaves other folders alone', () => {
    assert.deepEqual(
      archiveTargetsForFolder(parent, resolved, 'INBOX', true).map(message => message.id),
      ['oldest', 'head', 'other-account'],
    );
  });

  it('limits a thread action to the selected account when one is active', () => {
    assert.deepEqual(
      archiveTargetsForFolder(parent, resolved, 'INBOX', true, 'account-1').map(message => message.id),
      ['oldest', 'head'],
    );
  });

  it('archives only the selected message outside threaded list mode', () => {
    assert.deepEqual(archiveTargetsForFolder(parent, resolved, 'INBOX', false), [parent]);
  });

  it('falls back to the visible row when thread resolution has no active-folder member', () => {
    assert.deepEqual(
      archiveTargetsForFolder(parent, [{ id: 'sent-reply', folder: 'Sent' }], 'INBOX', true),
      [parent],
    );
  });
});
