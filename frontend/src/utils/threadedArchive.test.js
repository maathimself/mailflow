import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as threadedArchive from './threadedArchive.js';

const {
  archiveTargetsForFolder,
  currentThreadLoadVersion,
  findVisibleArchiveMessage,
  invalidateThreadLoad,
  isCurrentThreadLoad,
  removeThreadCacheEntry,
  unreadCountsByAccount,
} = threadedArchive;

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

describe('archiveViewKey', () => {
  it('distinguishes account, folder, search, and threaded view changes', () => {
    assert.equal(typeof threadedArchive.archiveViewKey, 'function');
    const original = {
      selectedAccountId: 'account-1',
      selectedFolder: 'INBOX',
      searchQuery: '',
      threadedView: true,
      unreadOnly: false,
      activeCategory: 'primary',
      currentPage: 1,
      searchAllFolders: false,
      activeGtdTab: null,
      pageSize: 50,
      scrollMode: 'paginated',
      categorizationEnabled: true,
      accountCategorizationEnabled: true,
      unifiedInboxAccountKey: 'account-1,account-2',
      showGtdTab: false,
    };

    assert.equal(threadedArchive.archiveViewKey({ ...original }), threadedArchive.archiveViewKey(original));
    for (const changed of [
      { selectedAccountId: 'account-2' },
      { selectedFolder: 'Sent' },
      { searchQuery: 'from:alice' },
      { threadedView: false },
      { unreadOnly: true },
      { activeCategory: 'updates' },
      { currentPage: 2 },
      { searchAllFolders: true },
      { activeGtdTab: 'todo' },
      { pageSize: 100 },
      { scrollMode: 'infinite' },
      { categorizationEnabled: false },
      { accountCategorizationEnabled: false },
      { unifiedInboxAccountKey: 'account-1' },
      { showGtdTab: true },
    ]) {
      assert.notEqual(
        threadedArchive.archiveViewKey({ ...original, ...changed }),
        threadedArchive.archiveViewKey(original),
      );
    }
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

  it('includes the visible row when a stale cache contains only active-folder siblings', () => {
    assert.deepEqual(
      archiveTargetsForFolder(
        { ...parent, account_id: 'account-1' },
        [{ id: 'oldest', account_id: 'account-1', folder: 'INBOX' }],
        'INBOX',
        true,
        'account-1',
      ).map(message => message.id),
      ['oldest', 'head'],
    );
  });
});

describe('archiveTargetGroupsForRows', () => {
  it('resolves every unique active-folder member for each selected thread row', async () => {
    assert.equal(typeof threadedArchive.archiveTargetGroupsForRows, 'function');

    const first = { id: 'first-head', thread_id: 'thread-1', message_count: 2 };
    const second = { id: 'second-head', thread_id: 'thread-2', message_count: 3 };
    const resolvedByThread = {
      'thread-1': [
        { id: 'first-oldest', account_id: 'account-1', folder: 'INBOX' },
        { id: 'first-head', account_id: 'account-1', folder: 'INBOX' },
      ],
      'thread-2': [
        { id: 'second-sent', account_id: 'account-1', folder: 'Sent' },
        { id: 'second-oldest', account_id: 'account-1', folder: 'INBOX' },
        { id: 'second-head', account_id: 'account-1', folder: 'INBOX' },
        { id: 'second-oldest', account_id: 'account-1', folder: 'INBOX' },
      ],
    };

    const groups = await threadedArchive.archiveTargetGroupsForRows(
      [first, second],
      message => resolvedByThread[message.thread_id],
      'INBOX',
      () => true,
      'account-1',
    );

    assert.deepEqual(
      groups.map(({ row, targets }) => ({
        row: row.id,
        targets: targets.map(target => target.id),
      })),
      [
        { row: 'first-head', targets: ['first-oldest', 'first-head'] },
        { row: 'second-head', targets: ['second-oldest', 'second-head'] },
      ],
    );
  });

  it('bounds concurrent thread resolution', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: `head-${index}`,
      thread_id: `thread-${index}`,
      folder: 'INBOX',
      message_count: 2,
    }));
    let active = 0;
    let maxActive = 0;

    await threadedArchive.archiveTargetGroupsForRows(
      rows,
      async (message) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 0));
        active -= 1;
        return [message];
      },
      'INBOX',
      () => true,
    );

    assert.equal(maxActive, 8);
  });
});

describe('archiveInChunks', () => {
  it('keeps each request within the backend limit and merges results', async () => {
    assert.equal(typeof threadedArchive.archiveInChunks, 'function');
    const ids = Array.from({ length: 501 }, (_, index) => `id-${index}`);
    const calls = [];

    const result = await threadedArchive.archiveInChunks(ids, async (chunk) => {
      calls.push(chunk);
      return {
        archived: chunk.slice(0, -1),
        noArchiveFolder: chunk.slice(-1),
      };
    });

    assert.deepEqual(calls.map(chunk => chunk.length), [500, 1]);
    assert.deepEqual(result.archived, ids.slice(0, 499));
    assert.deepEqual(result.noArchiveFolder, [ids[499], ids[500]]);
  });

  it('preserves completed chunks and reports the unconfirmed remainder after an error', async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `id-${index}`);
    let call = 0;

    let result;
    try {
      result = await threadedArchive.archiveInChunks(ids, async (chunk) => {
        call += 1;
        if (call === 2) throw new Error('network failed');
        return { archived: chunk, noArchiveFolder: [] };
      });
    } catch (error) {
      assert.fail(`archiveInChunks discarded completed chunk results: ${error.message}`);
    }

    assert.deepEqual(result.archived, ids.slice(0, 500));
    assert.deepEqual(result.unconfirmed, ids.slice(500));
    assert.equal(result.error.message, 'network failed');
    assert.equal(call, 2);
  });
});
