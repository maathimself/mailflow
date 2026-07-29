import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as conversationModule from './conversation.js';
import {
  conversationMembershipKey,
  conversationReadTargets,
  conversationUnreadCount,
  inboxConversationReadTargets,
  initialExpandedMessageIds,
  newestConversationMessage,
  normalizeConversation,
  reconcileExpandedMessageIds,
  shouldUseConversationPane,
  unreadConversationIds,
} from './conversation.js';

const message = (id, date, overrides = {}) => ({
  id,
  message_id: `<${id}@example.test>`,
  date,
  is_read: true,
  ...overrides,
});

describe('normalizeConversation', () => {
  it('orders messages chronologically and removes duplicate RFC Message-ID copies', () => {
    const messages = [
      message('new-copy', '2026-07-26T12:00:00Z', { message_id: '<same@example.test>', folder: 'Sent' }),
      message('old', '2026-07-25T12:00:00Z'),
      message('inbox-copy', '2026-07-26T11:00:00Z', { message_id: '<same@example.test>', folder: 'INBOX' }),
    ];

    assert.deepEqual(normalizeConversation(messages).map(item => item.id), ['old', 'inbox-copy']);
  });

  it('uses row IDs to retain messages without an RFC Message-ID', () => {
    const messages = [
      message('row-2', '2026-07-26T12:00:00Z', { message_id: null }),
      message('row-1', '2026-07-26T11:00:00Z', { message_id: null }),
      message('row-1', '2026-07-26T13:00:00Z', { message_id: null }),
    ];

    assert.deepEqual(normalizeConversation(messages).map(item => item.id), ['row-1', 'row-2']);
  });
});

describe('conversation selection helpers', () => {
  const messages = [
    message('newest', '2026-07-26T12:00:00Z', { is_read: false }),
    message('oldest', '2026-07-24T12:00:00Z', { is_read: false }),
    message('middle', '2026-07-25T12:00:00Z'),
  ];

  it('selects the newest chronological message', () => {
    assert.equal(newestConversationMessage(messages)?.id, 'newest');
  });

  it('collects unread IDs in chronological order', () => {
    assert.deepEqual(unreadConversationIds(messages), ['oldest', 'newest']);
  });

  it('initially expands only the newest message', () => {
    assert.deepEqual([...initialExpandedMessageIds(messages)], ['newest']);
  });

  it('targets only messages whose read state must change', () => {
    assert.deepEqual(conversationReadTargets(messages, true).map(item => item.id), ['oldest', 'newest']);
    assert.deepEqual(conversationReadTargets(messages, false).map(item => item.id), ['middle']);
  });

  it('counts unread messages after normalization', () => {
    const duplicateUnread = message('duplicate', '2026-07-26T13:00:00Z', {
      message_id: messages[0].message_id,
      is_read: false,
    });

    assert.equal(conversationUnreadCount([...messages, duplicateUnread]), 2);
  });

  it('keeps the membership key stable when only read state changes', () => {
    const changedReadState = messages.map(item => ({ ...item, is_read: !item.is_read }));

    assert.equal(conversationMembershipKey(messages), conversationMembershipKey(changedReadState));
  });

  it('adjusts inbox counters only for matching read-state targets', () => {
    const mixedFolders = [
      message('inbox-unread', '2026-07-26T10:00:00Z', { is_read: false, folder: 'INBOX' }),
      message('sent-unread', '2026-07-26T11:00:00Z', { is_read: false, folder: 'Sent' }),
      message('inbox-read', '2026-07-26T12:00:00Z', { is_read: true, folder: 'INBOX' }),
    ];

    assert.deepEqual(inboxConversationReadTargets(mixedFolders, true).map(item => item.id), ['inbox-unread']);
    assert.deepEqual(inboxConversationReadTargets(mixedFolders, false).map(item => item.id), ['inbox-read']);
  });
});

describe('shouldUseConversationPane', () => {
  const threadedMessage = { thread_id: 'thread-1', message_count: '2' };

  it('routes pane mode multi-message threads to the conversation pane', () => {
    assert.equal(shouldUseConversationPane({ mode: 'pane', searchQuery: '', message: threadedMessage }), true);
  });

  it('routes threaded messages with an unknown aggregate count through conversation resolution', () => {
    assert.equal(shouldUseConversationPane({
      mode: 'pane',
      searchQuery: '',
      message: { thread_id: 'thread-1' },
    }), true);
  });

  it('keeps search results and single messages in the single-message pane', () => {
    assert.equal(shouldUseConversationPane({ mode: 'pane', searchQuery: 'invoice', message: threadedMessage }), false);
    assert.equal(shouldUseConversationPane({ mode: 'pane', searchQuery: '', message: { ...threadedMessage, message_count: 1 } }), false);
  });

  it('keeps off and list modes in the single-message pane', () => {
    assert.equal(shouldUseConversationPane({ mode: 'off', searchQuery: '', message: threadedMessage }), false);
    assert.equal(shouldUseConversationPane({ mode: 'list', searchQuery: '', message: threadedMessage }), false);
  });
});

describe('conversation pane selection', () => {
  it('uses refreshed list metadata while preserving a cached selected message', () => {
    assert.equal(typeof conversationModule.resolveConversationSelection, 'function');

    const cachedSelected = message('old-reply', '2026-07-26T12:00:00Z', {
      thread_id: 'thread-1',
    });
    const refreshedHead = message('new-reply', '2026-07-26T13:00:00Z', {
      thread_id: 'thread-1',
      message_count: 3,
    });
    const result = conversationModule.resolveConversationSelection({
      selectedMessageId: cachedSelected.id,
      pool: [refreshedHead],
      threadMessages: { 'thread-1': [cachedSelected] },
    });

    assert.equal(result.selectedMessage, cachedSelected);
    assert.equal(result.conversationMessage, refreshedHead);
    assert.equal(result.refreshKey, 'thread-1:new-reply:3');
  });

  it('changes the refresh key when the grouped head changes', () => {
    assert.equal(typeof conversationModule.conversationRefreshKey, 'function');
    assert.notEqual(
      conversationModule.conversationRefreshKey({ thread_id: 'thread-1', id: 'old', message_count: 2 }),
      conversationModule.conversationRefreshKey({ thread_id: 'thread-1', id: 'new', message_count: 3 }),
    );
  });

  it('falls back to the single-message pane after resolving a singleton thread', () => {
    assert.equal(typeof conversationModule.shouldFallbackToSingleMessagePane, 'function');
    assert.equal(conversationModule.shouldFallbackToSingleMessagePane({ loading: true, error: null, messages: [] }), false);
    assert.equal(conversationModule.shouldFallbackToSingleMessagePane({ loading: false, error: null, messages: [message('only', '2026-07-26T12:00:00Z')] }), true);
    assert.equal(conversationModule.shouldFallbackToSingleMessagePane({ loading: false, error: null, messages: [message('one', '2026-07-26T12:00:00Z'), message('two', '2026-07-26T13:00:00Z')] }), false);
  });

  it('leaves GTD-owned automatic read scheduling to the GTD triage flow', () => {
    assert.equal(typeof conversationModule.conversationPaneOwnsAutoRead, 'function');
    assert.equal(conversationModule.conversationPaneOwnsAutoRead('gtd'), false);
    assert.equal(conversationModule.conversationPaneOwnsAutoRead(null), true);
  });

  it('tracks the current selection source and clears it for ordinary or closed selections', () => {
    assert.equal(typeof conversationModule.selectedMessageTransition, 'function');
    assert.deepEqual(conversationModule.selectedMessageTransition('message-1', 'gtd'), {
      selectedMessageId: 'message-1',
      lastViewedMessageId: 'message-1',
      selectedMessageSource: 'gtd',
    });
    assert.deepEqual(conversationModule.selectedMessageTransition('message-2'), {
      selectedMessageId: 'message-2',
      lastViewedMessageId: 'message-2',
      selectedMessageSource: null,
    });
    assert.deepEqual(conversationModule.selectedMessageTransition(null), {
      selectedMessageId: null,
      selectedMessageSource: null,
    });
  });
});

describe('conversation list scope', () => {
  const mixedFolders = [
    message('inbox-read', '2026-07-26T10:00:00Z', { account_id: 'account-1', folder: 'INBOX', is_read: true }),
    message('sent-unread', '2026-07-26T11:00:00Z', { account_id: 'account-1', folder: 'Sent', is_read: false }),
    message('other-inbox-unread', '2026-07-26T12:00:00Z', { account_id: 'account-2', folder: 'INBOX', is_read: false }),
  ];

  it('matches the unified inbox aggregate instead of all thread members', () => {
    assert.equal(typeof conversationModule.conversationListScopeMessages, 'function');
    assert.deepEqual(
      conversationModule.conversationListScopeMessages(mixedFolders, { selectedAccountId: null, selectedFolder: 'INBOX' }).map(item => item.id),
      ['inbox-read', 'other-inbox-unread'],
    );
  });

  it('matches the selected account and folder aggregate', () => {
    assert.deepEqual(
      conversationModule.conversationListScopeMessages(mixedFolders, { selectedAccountId: 'account-1', selectedFolder: 'Sent' }).map(item => item.id),
      ['sent-unread'],
    );
  });
});

describe('reconcileExpandedMessageIds', () => {
  it('expands a newly appended newest message and replaces only the automatic expansion', () => {
    const previous = [message('old', '2026-07-26T12:00:00Z')];
    const next = [...previous, message('reply', '2026-07-26T13:00:00Z')];
    const result = reconcileExpandedMessageIds({
      previousMessages: previous,
      nextMessages: next,
      expandedIds: new Set(['old', 'historical']),
      automaticExpandedId: 'old',
    });

    assert.deepEqual([...result.expandedIds].sort(), ['historical', 'reply']);
    assert.equal(result.automaticExpandedId, 'reply');
  });

  it('does not reset expansion when metadata is refreshed without a new message', () => {
    const result = reconcileExpandedMessageIds({
      previousMessages: [message('old', '2026-07-26T12:00:00Z')],
      nextMessages: [message('old', '2026-07-26T12:00:00Z', { snippet: 'updated' })],
      expandedIds: new Set(['old']),
      automaticExpandedId: 'old',
    });

    assert.deepEqual([...result.expandedIds], ['old']);
    assert.equal(result.automaticExpandedId, 'old');
  });
});

describe('resolveConversationMessageDisclosure', () => {
  it('keeps a never-opened collapsed message body unmounted', () => {
    assert.equal(typeof conversationModule.resolveConversationMessageDisclosure, 'function');

    assert.deepEqual(
      conversationModule.resolveConversationMessageDisclosure({ expanded: false, hasBeenExpanded: false }),
      { renderShell: true, renderContent: false },
    );
  });

  it('makes expanded message content visible and interactive', () => {
    assert.deepEqual(
      conversationModule.resolveConversationMessageDisclosure({ expanded: true, hasBeenExpanded: false }),
      { renderShell: true, renderContent: true, ariaHidden: false, inert: undefined },
    );
  });

  it('keeps previously opened collapsed content mounted but inert', () => {
    assert.deepEqual(
      conversationModule.resolveConversationMessageDisclosure({ expanded: false, hasBeenExpanded: true }),
      { renderShell: true, renderContent: true, ariaHidden: true, inert: '' },
    );
  });
});
