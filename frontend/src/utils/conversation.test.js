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

  it('keeps search results and single messages in the single-message pane', () => {
    assert.equal(shouldUseConversationPane({ mode: 'pane', searchQuery: 'invoice', message: threadedMessage }), false);
    assert.equal(shouldUseConversationPane({ mode: 'pane', searchQuery: '', message: { ...threadedMessage, message_count: 1 } }), false);
  });

  it('keeps off and list modes in the single-message pane', () => {
    assert.equal(shouldUseConversationPane({ mode: 'off', searchQuery: '', message: threadedMessage }), false);
    assert.equal(shouldUseConversationPane({ mode: 'list', searchQuery: '', message: threadedMessage }), false);
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
