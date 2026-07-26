import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialExpandedMessageIds,
  newestConversationMessage,
  normalizeConversation,
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
