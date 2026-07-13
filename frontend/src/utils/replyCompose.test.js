import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyComposeData } from './replyCompose.js';
import { resolveSenderOrFallback } from './senderIdentity.js';

test('still opens a reply requiring manual sender selection when resolution fails', async () => {
  const resolved = await resolveSenderOrFallback(() => Promise.reject(new Error('resolve failed')));

  const data = buildReplyComposeData({
    message: {
      account_id: 'account-1',
      from_email: 'sender@example.net',
      reply_to: [],
      to_addresses: [],
      cc_addresses: [],
      subject: 'Needs a from address',
      message_id: '<degraded@example.net>',
    },
    account: { id: 'account-1', email_address: 'owner@example.com', aliases: [] },
    resolved,
    replyAll: false,
  });

  assert.equal(data.sender, null);
  assert.equal(data.senderRequired, true);
});

test('builds reply-all compose data from the resolved Fastmail sender', () => {
  const message = {
    account_id: 'account-1',
    from_name: 'Original Sender',
    from_email: 'original@example.net',
    reply_to: JSON.stringify([{ name: 'Reply Target', email: 'reply@example.net' }]),
    to_addresses: [
      { name: 'Mailbox Owner', email: 'owner@example.com' },
      { name: 'Resolved Sender', email: 'selected@example.com' },
      { name: 'Teammate', email: 'teammate@example.net' },
      { name: 'Reply Target', email: 'reply@example.net' },
    ],
    cc_addresses: JSON.stringify([
      { name: 'Configured Alias', email: 'alias@example.com' },
      { name: 'Another Teammate', email: 'other@example.net' },
    ]),
    subject: 'Status update',
    in_reply_to: '<previous@example.net>',
    message_id: '<current@example.net>',
  };
  const account = {
    id: 'account-1',
    email_address: 'owner@example.com',
    aliases: [{ email: 'alias@example.com' }],
  };
  const resolved = {
    sender: {
      accountId: 'account-1',
      aliasId: 'wildcard-identity',
      fromEmail: 'selected@example.com',
    },
    requiresSelection: false,
  };

  assert.deepEqual(buildReplyComposeData({ message, account, resolved, replyAll: true }), {
    to: [{ name: 'Reply Target', email: 'reply@example.net' }],
    cc: [
      { name: 'Teammate', email: 'teammate@example.net' },
      { name: 'Another Teammate', email: 'other@example.net' },
    ],
    subject: 'Re: Status update',
    body: '',
    quotedBody: '',
    quotedBodyHtml: null,
    inReplyTo: '<current@example.net>',
    references: '<previous@example.net> <current@example.net>',
    sender: resolved.sender,
    senderRequired: false,
    accountId: 'account-1',
    isReply: true,
    isReplyAll: true,
    originalFrom: [{ name: 'Reply Target', email: 'reply@example.net' }],
    allRecipients: [
      { name: 'Teammate', email: 'teammate@example.net' },
      { name: 'Another Teammate', email: 'other@example.net' },
    ],
  });
});

test('includes the loaded message body in the reply quote', () => {
  const message = {
    account_id: 'account-1',
    from_name: 'Original\r\nSender',
    from_email: 'original@example.net',
    reply_to: [],
    to_addresses: [],
    cc_addresses: [],
    subject: 'Re: Existing subject',
    message_id: '<current@example.net>',
    date: '2026-07-12T12:00:00.000Z',
  };
  const body = { text: 'First line\nSecond line', html: '<p>HTML body</p>' };
  const date = new Date(message.date).toLocaleString();

  const result = buildReplyComposeData({
    message,
    account: { email_address: 'owner@example.com', aliases: [] },
    resolved: { sender: null, requiresSelection: true },
    replyAll: false,
    body,
  });

  assert.equal(
    result.quotedBody,
    `\n\n---\nOn ${date}, Original Sender <original@example.net> wrote:\n> First line\n> Second line`,
  );
  assert.equal(
    result.quotedBodyHtml,
    `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${date}, Original Sender <original@example.net> wrote:</p><p>HTML body</p></div>`,
  );
});

test('excludes every address covered by an owned Fastmail wildcard from Reply All', () => {
  const result = buildReplyComposeData({
    message: {
      account_id: 'account-1',
      from_email: 'sender@example.net',
      reply_to: [],
      to_addresses: [
        { email: 'first@catchall.example' },
        { email: 'second@catchall.example' },
        { email: 'teammate@example.net' },
      ],
      cc_addresses: [],
      subject: 'Wildcard delivery',
      message_id: '<wildcard@example.net>',
    },
    account: {
      id: 'account-1',
      email_address: 'owner@example.com',
      aliases: [{
        email: '*@catchall.example',
        provenance: 'fastmail',
        fastmail_identity_id: 'wildcard-identity',
      }],
    },
    resolved: {
      sender: {
        accountId: 'account-1',
        aliasId: 'wildcard-alias',
        fromEmail: 'first@catchall.example',
      },
      requiresSelection: false,
    },
    replyAll: true,
  });

  assert.deepEqual(result.allRecipients, [{ email: 'teammate@example.net' }]);
  assert.deepEqual(result.cc, result.allRecipients);
});

test('excludes a stale resolved exact Fastmail identity from Reply All', () => {
  const result = buildReplyComposeData({
    message: {
      account_id: 'account-1',
      from_email: 'sender@example.net',
      reply_to: [],
      to_addresses: [
        { email: 'stale-alias@example.com' },
        { email: 'teammate@example.net' },
      ],
      cc_addresses: [],
      subject: 'Exact alias delivery',
      message_id: '<exact-alias@example.net>',
    },
    account: {
      id: 'account-1',
      email_address: 'owner@example.com',
      aliases: [],
    },
    resolved: {
      sender: {
        accountId: 'account-1',
        aliasId: 'stale-alias',
        fromEmail: null,
        displayEmail: 'stale-alias@example.com',
      },
      requiresSelection: false,
    },
    replyAll: true,
  });

  assert.deepEqual(result.allRecipients, [{ email: 'teammate@example.net' }]);
  assert.deepEqual(result.cc, result.allRecipients);
});
