import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationActionIds,
  conversationSpamTargets,
  groupConversationMessagesByAccount,
  newestSnoozeTarget,
} from './conversationActions.js';

const message = (id, overrides = {}) => ({
  id,
  message_id: `<${id}@example.test>`,
  account_id: 'account-a',
  folder: 'INBOX',
  from_email: 'sender@example.test',
  date: '2026-07-26T10:00:00Z',
  ...overrides,
});

describe('conversation action targets', () => {
  it('returns one database ID for each distinct RFC message', () => {
    const messages = [
      message('inbox-copy', { message_id: '<same@example.test>' }),
      message('archive-copy', { message_id: '<same@example.test>', folder: 'Archive' }),
      message('other'),
    ];

    assert.deepEqual(conversationActionIds(messages), ['inbox-copy', 'other']);
  });

  it('groups normalized messages by account', () => {
    const grouped = groupConversationMessagesByAccount([
      message('a-1'),
      message('b-1', { account_id: 'account-b' }),
      message('a-2'),
    ]);

    assert.deepEqual(Object.fromEntries(
      Object.entries(grouped).map(([accountId, messages]) => [accountId, messages.map(item => item.id)])
    ), {
      'account-a': ['a-1', 'a-2'],
      'account-b': ['b-1'],
    });
  });

  it('excludes sent-folder and own-address messages from spam targets', () => {
    const accounts = [{
      id: 'account-a',
      email_address: 'me@example.test',
      aliases: [{ email: 'alias@example.test' }],
      folder_mappings: { sent: 'Sent Items' },
    }];
    const messages = [
      message('received'),
      message('sent-folder', { folder: 'Sent Items', from_email: 'other@example.test' }),
      message('sent-primary', { folder: 'Archive', from_email: 'ME@example.test' }),
      message('sent-alias', { folder: 'Archive', from_email: 'alias@example.test' }),
    ];

    assert.deepEqual(conversationSpamTargets(messages, accounts).map(item => item.id), ['received']);
  });

  it('selects the newest inbox message as the snooze target', () => {
    const messages = [
      message('older', { date: '2026-07-26T08:00:00Z' }),
      message('sent-newest', { folder: 'Sent', date: '2026-07-26T12:00:00Z' }),
      message('newer', { date: '2026-07-26T11:00:00Z' }),
    ];

    assert.equal(newestSnoozeTarget(messages)?.id, 'newer');
    assert.equal(newestSnoozeTarget([message('sent-only', { folder: 'Sent' })]), null);
  });
});
