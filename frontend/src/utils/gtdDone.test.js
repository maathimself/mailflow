import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  doneGtdInboxRow,
  doneGtdRow,
  gtdDoneRefreshPatch,
  isGtdArchiveIncomplete,
} from './gtdDone.js';
import {
  clearGtdRemovalGuard,
  completedGtdRemovalMap,
  pendingGtdRemovalMap,
} from './pendingGtdRemovals.js';

const thread = { id: 'row-x', account_id: 'account-1', message_id: 'x', subject: 'A subject' };
const states = ['todo'];

function deps(overrides = {}) {
  return {
    gtdDone: async () => ({ ok: true, phase: 'completed' }),
    removeGtdThread: () => ({ snapshot: true }),
    restoreGtdThread: () => {},
    addNotification: () => {},
    refreshGtdSections: () => {},
    refreshMessages: () => {},
    refreshUnreadCounts: () => {},
    refreshFolders: () => {},
    t: key => key,
    ...overrides,
  };
}

describe('doneGtdRow', () => {
  afterEach(() => {
    for (const removal of [...pendingGtdRemovalMap.values(), ...completedGtdRemovalMap.values()]) {
      clearGtdRemovalGuard(removal.identity, removal.states, removal.accountId);
    }
  });

  it('guards and removes the row before the request settles, then completes the guard', async () => {
    const calls = [];
    let resolveRequest;
    const request = new Promise(resolve => { resolveRequest = resolve; });
    const result = doneGtdRow(thread, states, deps({
      removeGtdThread: (identity, removedStates, accountId) => {
        calls.push(['remove', identity, removedStates, accountId]);
        return { snapshot: true };
      },
      gtdDone: async (id, removedStates) => {
        calls.push(['api', id, removedStates]);
        return request;
      },
      refreshGtdSections: () => calls.push(['gtd']),
      refreshMessages: context => calls.push(['messages', context]),
      refreshUnreadCounts: () => calls.push(['unread']),
      refreshFolders: accountId => calls.push(['folders', accountId]),
    }));

    assert.deepEqual(calls, [
      ['remove', 'x', states, 'account-1'],
      ['api', 'row-x', states],
    ]);
    assert.equal(pendingGtdRemovalMap.size, 1);
    assert.equal(completedGtdRemovalMap.size, 0);

    resolveRequest({ ok: true, phase: 'completed' });
    assert.deepEqual(await result, { ok: true, phase: 'completed' });
    assert.equal(pendingGtdRemovalMap.size, 0);
    assert.equal(completedGtdRemovalMap.size, 1);
    assert.deepEqual(calls.slice(-4), [
      ['messages', { target: { id: 'row-x', accountId: 'account-1', messageId: 'x' } }],
      ['unread'],
      ['folders', 'account-1'],
      ['gtd'],
    ]);
  });

  it('clears the guard without restoring a possibly stale sidebar snapshot on failure', async () => {
    const snapshot = { identity: 'x', removedByState: { todo: [] } };
    const calls = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await doneGtdRow(thread, states, deps({
        removeGtdThread: () => snapshot,
        gtdDone: async () => { throw new Error('network failed'); },
        restoreGtdThread: value => calls.push(['restore', value]),
        addNotification: notification => calls.push(['notify', notification]),
        refreshGtdSections: () => calls.push(['gtd']),
        refreshMessages: context => calls.push(['messages', context]),
        refreshUnreadCounts: () => calls.push(['unread']),
        refreshFolders: accountId => calls.push(['folders', accountId]),
      }));

      assert.equal(result, null);
      assert.equal(pendingGtdRemovalMap.size, 0);
      assert.equal(completedGtdRemovalMap.size, 0);
      assert.deepEqual(calls, [
        ['notify', { title: 'gtd.doneFailed', body: 'A subject' }],
        ['messages', { target: { id: 'row-x', accountId: 'account-1', messageId: 'x' } }],
        ['unread'],
        ['folders', 'account-1'],
        ['gtd'],
      ]);
    } finally {
      console.error = originalError;
    }
  });

  it('does not resurrect removed sidebar labels after a partial archive failure', async () => {
    const calls = [];
    await doneGtdRow(thread, states, deps({
      gtdDone: async () => ({ ok: true, archiveFailed: true }),
      restoreGtdThread: snapshot => calls.push(['restore', snapshot]),
      addNotification: notification => calls.push(['notify', notification]),
    }));

    assert.deepEqual(calls, [
      ['notify', { title: 'gtd.doneArchiveFailed', body: 'A subject' }],
    ]);
    assert.equal(pendingGtdRemovalMap.size, 0);
    assert.equal(completedGtdRemovalMap.size, 0);
  });

  it('recognizes additive incomplete outcomes while preserving legacy archive-failure handling', () => {
    assert.equal(isGtdArchiveIncomplete({ archiveTargetCount: 2, inboxCleared: false }), true);
    assert.equal(isGtdArchiveIncomplete({ archiveTargetCount: 0, inboxCleared: true }), false);
    assert.equal(isGtdArchiveIncomplete({ archiveFailed: true }), true);
    assert.equal(isGtdArchiveIncomplete({ noArchiveFolder: true }), true);
  });
});

describe('doneGtdInboxRow', () => {
  it('invalidates both the folder list and an active search snapshot', () => {
    assert.deepEqual(
      gtdDoneRefreshPatch({
        messagesRefreshToken: 4,
        searchRefreshToken: 7,
        threadCacheVersion: 2,
        threadMessages: { 'thread-1': [{ id: 'stale-child' }] },
        expandedThreadId: 'thread-1',
        loadingThread: 'thread-1',
      }),
      {
        messagesRefreshToken: 5,
        searchRefreshToken: 8,
        threadCacheVersion: 3,
        threadMessages: {},
        expandedThreadId: null,
        loadingThread: null,
      },
    );
  });

  it('clears the selected completed GTD row from the same account while invalidating thread caches', () => {
    const state = {
      messagesRefreshToken: 4,
      searchRefreshToken: 7,
      threadCacheVersion: 2,
      selectedMessageId: 'row-x',
      messages: [],
      searchResults: [],
      threadMessages: { 'thread-1': [{ id: 'row-x', account_id: 'account-1' }] },
      expandedThreadId: 'thread-1',
      loadingThread: 'thread-1',
    };

    assert.deepEqual(
      gtdDoneRefreshPatch(state, { id: 'row-x', accountId: 'account-1' }),
      {
        messagesRefreshToken: 5,
        searchRefreshToken: 8,
        threadCacheVersion: 3,
        selectedMessageId: null,
        threadMessages: {},
        expandedThreadId: null,
        loadingThread: null,
      },
    );
  });

  it('preserves a newer or account-mismatched selection while still invalidating thread caches', () => {
    const base = {
      messagesRefreshToken: 1,
      searchRefreshToken: 1,
      threadCacheVersion: 1,
      messages: [],
      searchResults: [],
      expandedThreadId: 'thread-1',
      loadingThread: 'thread-1',
    };

    const newer = gtdDoneRefreshPatch({
      ...base,
      selectedMessageId: 'row-new',
      threadMessages: {
        old: [{ id: 'row-x', account_id: 'account-1' }],
        newer: [{ id: 'row-new', account_id: 'account-1' }],
      },
    }, { id: 'row-x', accountId: 'account-1' });
    assert.equal(Object.hasOwn(newer, 'selectedMessageId'), false);
    assert.deepEqual(newer.threadMessages, {});

    const wrongAccount = gtdDoneRefreshPatch({
      ...base,
      selectedMessageId: 'row-x',
      threadMessages: { old: [{ id: 'row-x', account_id: 'account-2' }] },
    }, { id: 'row-x', accountId: 'account-1' });
    assert.equal(Object.hasOwn(wrongAccount, 'selectedMessageId'), false);
    assert.deepEqual(wrongAccount.threadMessages, {});
  });

  it('preserves a recovered same-message selection and its thread material after stale-row Done', () => {
    const recovered = { id: 'row-new', account_id: 'account-1', message_id: '<same@message>' };
    const unrelated = { id: 'row-other', account_id: 'account-1', message_id: '<other@message>' };

    const patch = gtdDoneRefreshPatch({
      messagesRefreshToken: 1,
      searchRefreshToken: 1,
      threadCacheVersion: 1,
      selectedMessageId: recovered.id,
      messages: [],
      searchResults: [],
      threadMessages: {
        recovered: [recovered, unrelated],
        stale: [{ id: 'row-stale', account_id: 'account-1', message_id: '<same@message>' }],
      },
      expandedThreadId: null,
      loadingThread: null,
    }, {
      id: 'row-stale', accountId: 'account-1', messageId: '<same@message>',
    });

    assert.equal(Object.hasOwn(patch, 'selectedMessageId'), false);
    assert.deepEqual(patch.threadMessages, { recovered: [recovered, unrelated] });
  });

  it('preserves the selected row when no terminal Done target is supplied', () => {
    const patch = gtdDoneRefreshPatch({
      messagesRefreshToken: 1,
      searchRefreshToken: 1,
      threadCacheVersion: 1,
      selectedMessageId: 'row-x',
      messages: [],
      searchResults: [],
      threadMessages: { old: [{ id: 'row-x', account_id: 'account-1' }] },
    });

    assert.equal(Object.hasOwn(patch, 'selectedMessageId'), false);
    assert.deepEqual(patch.threadMessages, {});
  });

  it('reconciles messages, unread counts, and GTD sections after a complete response', async () => {
    const calls = [];
    const result = await doneGtdInboxRow(thread, {
      gtdDone: async id => { calls.push(['api', id]); return { ok: true, phase: 'completed', inboxCleared: true }; },
      refreshMessages: () => calls.push(['messages']),
      refreshUnreadCounts: () => calls.push(['unread']),
      refreshFolders: accountId => calls.push(['folders', accountId]),
      refreshGtdSections: () => calls.push(['gtd']),
      addNotification: value => calls.push(['notify', value]),
      t: key => key,
    });
    assert.deepEqual(result, { ok: true, phase: 'completed', inboxCleared: true });
    assert.deepEqual(calls, [['api', 'row-x'], ['messages'], ['unread'], ['folders', 'account-1'], ['gtd']]);
  });

  it('does not restore an ambiguous network failure and still reconciles', async () => {
    const calls = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await doneGtdInboxRow(thread, {
        gtdDone: async () => { throw new Error('request failed'); },
        restoreInbox: value => calls.push(['restore', value.id]),
        refreshMessages: () => calls.push(['messages']),
        refreshUnreadCounts: () => calls.push(['unread']),
        refreshFolders: accountId => calls.push(['folders', accountId]),
        refreshGtdSections: () => calls.push(['gtd']),
        addNotification: value => calls.push(['notify', value]),
        t: key => key,
      });
      assert.equal(result, null);
      assert.deepEqual(calls, [
        ['notify', { title: 'gtd.doneFailed', body: 'A subject' }],
        ['messages'],
        ['unread'],
        ['folders', 'account-1'],
        ['gtd'],
      ]);
    } finally {
      console.error = originalError;
    }
  });

  it('restores the optimistic Inbox row after a structured non-2xx says archive is incomplete', async () => {
    const calls = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      await doneGtdInboxRow(thread, {
        gtdDone: async () => { throw Object.assign(new Error('seen failed'), { phase: 'seen', inboxCleared: false }); },
        restoreInbox: value => calls.push(['restore', value.id]),
        refreshMessages: () => calls.push(['messages']),
        refreshUnreadCounts: () => calls.push(['unread']),
        refreshFolders: () => calls.push(['folders']),
        refreshGtdSections: () => calls.push(['gtd']),
        addNotification: () => calls.push(['notify']),
        t: key => key,
      });
      assert.deepEqual(calls, [['restore', 'row-x'], ['notify'], ['messages'], ['unread'], ['folders'], ['gtd']]);
    } finally {
      console.error = originalError;
    }
  });

  it('warns on an incomplete archive and then reconciles authoritatively', async () => {
    const calls = [];
    await doneGtdInboxRow(thread, {
      gtdDone: async () => ({ ok: true, archiveTargetCount: 2, inboxCleared: false }),
      restoreInbox: value => calls.push(['restore', value.id]),
      refreshMessages: () => calls.push(['messages']),
      refreshUnreadCounts: () => calls.push(['unread']),
      refreshFolders: accountId => calls.push(['folders', accountId]),
      refreshGtdSections: () => calls.push(['gtd']),
      addNotification: value => calls.push(['notify', value]),
      t: key => key,
    });
    assert.deepEqual(calls, [
      ['restore', 'row-x'],
      ['notify', { title: 'gtd.doneArchiveFailed', body: 'A subject' }],
      ['messages'],
      ['unread'],
      ['folders', 'account-1'],
      ['gtd'],
    ]);
  });

  it('reports a label-incomplete 2xx without restoring a cleared Inbox row', async () => {
    const calls = [];
    await doneGtdInboxRow(thread, {
      gtdDone: async () => ({ ok: false, phase: 'labels', inboxCleared: true }),
      restoreInbox: () => calls.push(['restore']),
      refreshMessages: () => {},
      refreshUnreadCounts: () => {},
      refreshFolders: () => {},
      refreshGtdSections: () => {},
      addNotification: value => calls.push(['notify', value]),
      t: key => key,
    });
    assert.deepEqual(calls, [['notify', { title: 'gtd.doneFailed', body: 'A subject' }]]);
  });

  it('reports a malformed 2xx and relies on authoritative refresh without restoring', async () => {
    const calls = [];
    await doneGtdInboxRow(thread, {
      gtdDone: async () => ({}),
      restoreInbox: () => calls.push(['restore']),
      refreshMessages: () => {},
      refreshUnreadCounts: () => {},
      refreshFolders: () => {},
      refreshGtdSections: () => {},
      addNotification: value => calls.push(['notify', value]),
      t: key => key,
    });
    assert.deepEqual(calls, [['notify', { title: 'gtd.doneFailed', body: 'A subject' }]]);
  });

  it('awaits every authoritative cache refresh before settling a terminal failure', async () => {
    const release = [];
    const pending = name => new Promise(resolve => release.push(() => resolve(name)));
    const settled = doneGtdInboxRow(thread, {
      gtdDone: async () => { throw new Error('uncertain'); },
      restoreInbox: () => {},
      refreshMessages: () => pending('messages'),
      refreshUnreadCounts: () => pending('unread'),
      refreshFolders: () => pending('folders'),
      refreshGtdSections: () => pending('gtd'),
      addNotification: () => {},
      t: key => key,
    });
    let finished = false;
    settled.then(() => { finished = true; });
    while (release.length < 4) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(finished, false);
    for (const resolve of release) resolve();
    await settled;
    assert.equal(finished, true);
  });
});
