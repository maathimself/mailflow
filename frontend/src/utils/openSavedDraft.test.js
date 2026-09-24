import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedDraftToComposeData } from './openSavedDraft.js';

const draft = {
  id: 'draft-1', account_id: 'account-1', uid: 73, folder: 'Drafts',
  subject: 'Re: report', in_reply_to: '<root@example.test>',
  thread_references: '<root@example.test> <sent@example.test>',
  thread_id: '<root@example.test>',
  to_addresses: [{ name: 'Pat', address: 'pat@example.test' }],
  cc_addresses: ['cc@example.test'], bcc_addresses: [{ email: 'bcc@example.test' }],
};

test('maps a saved HTML reply with signature, recipients, headers and stable session', () => {
  const data = savedDraftToComposeData(draft, {
    html: '<p>reply</p><div data-mailflow-signature="1">Thanks</div><blockquote>original</blockquote>',
    attachments: [],
  });
  assert.equal(data.body, '<p>reply</p><blockquote>original</blockquote>');
  assert.equal(data.signature, 'Thanks');
  assert.deepEqual(data.to, ['Pat <pat@example.test>']);
  assert.deepEqual(data.cc, ['cc@example.test']);
  assert.deepEqual(data.bcc, ['bcc@example.test']);
  assert.equal(data.inReplyTo, draft.in_reply_to);
  assert.equal(data.references, draft.thread_references);
  assert.equal(data.threadId, draft.thread_id);
  assert.equal(data.sessionKey, 'saved:draft-1');
  assert.equal(data.persistedKey, 'account-1:Drafts:73');
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
