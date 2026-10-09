import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedDraftToComposeData } from './openSavedDraft.js';

const draft = {
  id: 'draft-1', account_id: 'account-1', uid: 73, folder: 'Drafts',
  subject: 'Re: report', in_reply_to: '<root@example.test>',
  thread_references: '<root@example.test> <sent@example.test>',
  thread_id: '<root@example.test>',
  message_id: '<draft@example.test>', attachments_complete: true,
  to_addresses: [{ name: 'Example Recipient', address: 'recipient@example.test' }],
  cc_addresses: ['cc@example.test'], bcc_addresses: [{ email: 'bcc@example.test' }],
};

test('maps a saved HTML reply with signature, recipients, headers and persisted identity', () => {
  const data = savedDraftToComposeData(draft, {
    html: '<p>reply</p><div data-mailflow-signature="1">Thanks</div><blockquote>original</blockquote>',
    attachments: [],
  });
  assert.equal(data.body, '<p>reply</p><blockquote>original</blockquote>');
  assert.equal(data.signature, 'Thanks');
  assert.deepEqual(data.to, [{ name: 'Example Recipient', email: 'recipient@example.test' }]);
  assert.deepEqual(data.cc, ['cc@example.test']);
  assert.deepEqual(data.bcc, [{ name: '', email: 'bcc@example.test' }]);
  assert.equal(data.inReplyTo, draft.in_reply_to);
  assert.equal(data.references, draft.thread_references);
  assert.equal(data.threadId, draft.thread_id);
  assert.equal(data.persistedKey, 'account-1:Drafts:73:<draft@example.test>:');
});

test('keeps comma display names as objects and suppresses an unmarked external signature', () => {
  const data = savedDraftToComposeData({ ...draft, to_addresses: [{ name: 'Example, Recipient', email: 'recipient@example.test' }] },
    { html: '<p>Reply</p><p>Existing signature</p>', attachments: [] });
  assert.deepEqual(data.to, [{ name: 'Example, Recipient', email: 'recipient@example.test' }]);
  assert.equal(data.signature, '');
});

test('marks unsupported From and incomplete attachment metadata so destructive actions can block', () => {
  const data = savedDraftToComposeData({ ...draft, from_email: 'unconfigured@example.test', has_attachments: true },
    { text: 'Reply', attachments: [] }, [{ id: draft.account_id, email_address: 'supported@example.test' }]);
  assert.equal(data.unsupportedFrom, 'unconfigured@example.test');
  assert.equal(data.unresolvedExternalAttachments, true);
});

test('maps plain text and flags external attachments for safe handling', () => {
  const data = savedDraftToComposeData({ ...draft, id: 'external', has_attachments: true }, {
    text: 'plain reply', attachments: [{ part: '2', filename: 'file.txt', size: 12 }],
  });
  assert.equal(data.body, 'plain reply');
  assert.equal(data.bodyIsHtml, false);
  assert.equal(data.externalAttachments.length, 1);
  assert.deepEqual(data.forwardedAttachments, [{ messageId: 'external', part: '2', filename: 'file.txt', size: 12 }]);
});

test('reopens a draft from a configured alias with that same sender', () => {
  const data = savedDraftToComposeData({ ...draft, from_email: 'alias@example.test' },
    { text: 'reply' }, [{ id: 'account-1', email_address: 'main@example.test',
      aliases: [{ id: 'alias-1', email: 'alias@example.test' }] }]);
  assert.equal(data.aliasId, 'alias-1');
});
