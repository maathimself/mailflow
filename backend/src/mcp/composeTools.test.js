import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./accountAdapter.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAccountRow: vi.fn(),
    getComposeSource: vi.fn(),
    getUserPreferences: vi.fn(),
    listAliases: vi.fn(),
  };
});

import {
  getAccountRow,
  getComposeSource,
  getUserPreferences,
  listAliases,
} from './accountAdapter.js';
import * as composeTools from './composeTools.js';
import { HANDLERS, TOOL_DEFS, TOOL_SCOPES } from './tools.js';

const replyProperties = {
  message_id: {
    type: 'string',
    description: 'Id of the message being replied to (from search/list/get_message)',
  },
  body: { type: 'string' },
  body_html: { type: 'string' },
  to: {
    type: 'array',
    items: { type: 'string' },
    description: 'REPLACES the computed To. Displaced recipients move to Cc rather than being dropped. Mutually exclusive with to_add.',
  },
  cc: {
    type: 'array',
    items: { type: 'string' },
    description: 'REPLACES the computed Cc.',
  },
  bcc: { type: 'array', items: { type: 'string' } },
  to_add: {
    type: 'array',
    items: { type: 'string' },
    description: 'Appends to the computed To.',
  },
  cc_add: { type: 'array', items: { type: 'string' } },
  bcc_add: { type: 'array', items: { type: 'string' } },
  remove: {
    type: 'array',
    items: { type: 'string' },
    description: 'Email addresses to drop from To/Cc/Bcc after computation.',
  },
  no_quote: {
    type: 'boolean',
    description: 'Omit the quoted original.',
  },
  include_inline_images: {
    type: 'boolean',
    description: 'Re-fetch cid: images from the original so the quote renders (default: replaced with [inline image: name]).',
  },
  alias: { type: 'string' },
  attachments: {},
  undo_send_seconds: { type: 'integer', minimum: 0, maximum: 120 },
  idempotency_key: { type: 'string' },
};

const sendAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const scope = {
  userId: 'user-1',
  accountIds: ['account-1'],
  scopes: ['send'],
};
const account = {
  id: 'account-1',
  user_id: 'user-1',
  email_address: 'me@example.com',
  sender_name: 'Me',
};
const aliases = [{
  id: 'alias-1',
  email: 'team@example.com',
  reply_to: 'alias-replies@example.com',
}];
const message = {
  id: '11111111-1111-4111-8111-111111111111',
  account_id: 'account-1',
  uid: 42,
  folder: 'INBOX',
  subject: 'Topic',
  from_name: 'Sender',
  from_email: 'sender@example.com',
  reply_to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
  to_addresses: [
    { name: 'Me', email: 'me@example.com' },
    { name: 'Team', email: 'team@example.com' },
    { name: 'Other', email: 'other@example.com' },
  ],
  cc_addresses: [
    { name: 'Colleague', email: 'colleague@example.com' },
    { name: 'Alias Reply', email: 'alias-replies@example.com' },
  ],
  body_text: 'Original text',
  body_html: '<p>Original HTML</p>',
  attachments: [{
    part: '2',
    filename: 'deck.pdf',
    type: 'application/pdf',
    size: 2_144_000,
  }],
  message_id: '<original@example.com>',
  thread_references: '<root@example.com>',
};
const replyReceipt = {
  from: { name: 'Team', email: 'team@example.com' },
  to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Re: Topic',
  attachments: [],
  messageId: '<reply@example.com>',
  sentCopySaved: true,
  folder: 'Sent',
};

function deps(overrides = {}) {
  return {
    sendService: {
      sendOrEnqueue: vi.fn().mockResolvedValue({
        ok: true,
        messageId: '<reply@example.com>',
        sentCopySaved: true,
        receipt: replyReceipt,
      }),
    },
    ...overrides,
  };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  getComposeSource.mockResolvedValue(message);
  getAccountRow.mockResolvedValue(account);
  listAliases.mockResolvedValue(aliases);
  getUserPreferences.mockResolvedValue({});
});

describe('compose tool definitions and registration', () => {
  it('publishes the Phase 1 schemas, descriptions, annotations, scopes, and handlers', () => {
    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));

    expect(defs.get('reply_email')).toEqual({
      name: 'reply_email',
      description: 'Reply to the sender of a message.',
      inputSchema: {
        type: 'object',
        required: ['message_id', 'body'],
        properties: replyProperties,
      },
      annotations: sendAnnotations,
    });
    expect(defs.get('reply_all_email')).toEqual({
      name: 'reply_all_email',
      description: 'Reply to the sender and all original To/Cc recipients. Bcc recipients of the original are not recoverable (they are not stored). Your own addresses and aliases are excluded from the recipients automatically.',
      inputSchema: {
        type: 'object',
        required: ['message_id', 'body'],
        properties: replyProperties,
      },
      annotations: sendAnnotations,
    });
    expect(defs.get('forward_email')).toEqual({
      name: 'forward_email',
      description: "Forward a message. Carries the original's attachments by default via forwardedAttachments: [{messageId, part}] — re-fetched from IMAP inside sendService, never round-tripped through the MCP wire.",
      inputSchema: {
        type: 'object',
        required: ['message_id', 'to'],
        properties: {
          message_id: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          skip_attachments: { type: 'boolean' },
          alias: { type: 'string' },
          undo_send_seconds: { type: 'integer', minimum: 0, maximum: 120 },
          idempotency_key: { type: 'string' },
        },
      },
      annotations: sendAnnotations,
    });

    for (const [name, handler] of [
      ['reply_email', composeTools.handleReplyEmail],
      ['reply_all_email', composeTools.handleReplyAllEmail],
      ['forward_email', composeTools.handleForwardEmail],
    ]) {
      expect(TOOL_SCOPES[name]).toBe('send');
      expect(HANDLERS[name]).toBe(handler);
    }
  });
});

describe('reply_email', () => {
  it('returns message_not_found without disclosing an out-of-scope message', async () => {
    const service = deps();
    getComposeSource.mockResolvedValue(null);

    const result = await composeTools.handleReplyEmail({
      message_id: 'foreign-message',
      body: 'Reply',
    }, scope, service);

    expect(getComposeSource).toHaveBeenCalledWith('foreign-message', ['account-1']);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('message_not_found: foreign-message');
    expect(getAccountRow).not.toHaveBeenCalled();
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('returns account_not_found if the compose source account disappears', async () => {
    const service = deps();
    getAccountRow.mockResolvedValue(null);

    const result = await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Reply',
    }, scope, service);

    expect(getAccountRow).toHaveBeenCalledWith('account-1', ['account-1']);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account_not_found: account-1');
    expect(listAliases).not.toHaveBeenCalled();
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('preserves alias_not_found from replyService', async () => {
    const service = deps();

    const result = await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Reply',
      alias: 'missing@example.com',
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('alias_not_found: Alias not found');
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    [{
      to: Array.from({ length: 101 }, (_, i) => `person-${i}@example.com`),
    }, 'too_many_recipients: Too many recipients (max 100)'],
    [{
      to: ['replacement@example.com'],
      to_add: ['additional@example.com'],
    }, 'invalid_arguments: to and toAdd are mutually exclusive'],
  ])('preserves recipient computation errors for %j', async (recipientArgs, expected) => {
    const service = deps();

    const result = await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Reply',
      ...recipientArgs,
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(expected);
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('sends immediately and returns threading plus recipients_computed', async () => {
    const service = deps();

    const wireResult = await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Thanks',
      no_quote: true,
      undo_send_seconds: 0,
      idempotency_key: 'reply-1',
    }, scope, service);

    expect(wireResult.isError).not.toBe(true);
    expect(listAliases).toHaveBeenCalledWith('account-1');
    expect(getUserPreferences).toHaveBeenCalledWith('user-1');
    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith({
      account,
      aliasId: 'alias-1',
      userId: 'user-1',
      to: ['Reply Desk <reply@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Re: Topic',
      body: 'Thanks',
      bodyIsHtml: false,
      quotedBody: '',
      quotedBodyHtml: null,
      inReplyTo: '<original@example.com>',
      references: '<root@example.com> <original@example.com>',
      undoSeconds: 0,
      idempotencyKey: 'reply-1',
    }, service);
    expect(payload(wireResult)).toEqual({
      sent: true,
      recipients_computed: {
        reply_target: 'reply@example.com',
        excluded_self: [
          'alias-replies@example.com',
          'me@example.com',
          'team@example.com',
        ],
      },
      message_id: '<reply@example.com>',
      in_reply_to: '<original@example.com>',
      references: '<root@example.com> <original@example.com>',
      from: { name: 'Team', email: 'team@example.com' },
      to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Re: Topic',
      attachments: [],
      sent_copy_saved: true,
      folder: 'Sent',
    });
  });

  it('uses HTML body selection and passes additive recipient adjustments to replyService', async () => {
    const service = deps();

    await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Plain fallback',
      body_html: '<p>HTML reply</p>',
      to_add: ['additional@example.com'],
      cc_add: ['added-copy@example.com'],
      bcc_add: ['added-blind@example.com'],
      remove: ['reply@example.com'],
      no_quote: true,
    }, scope, service);

    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '<p>HTML reply</p>',
        bodyIsHtml: true,
        to: ['additional@example.com'],
        cc: ['added-copy@example.com'],
        bcc: ['added-blind@example.com'],
      }),
      service,
    );
  });

  it('maps a missing inline-image fetch dependency to unsupported', async () => {
    const service = deps();
    getComposeSource.mockResolvedValue({
      ...message,
      body_html: '<p>Original</p><img src="cid:image-1">',
      attachments: [{
        part: '2',
        cid: 'image-1',
        filename: 'inline.png',
        type: 'image/png',
      }],
    });

    const result = await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Reply',
      include_inline_images: true,
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'unsupported: include_inline_images requires imapManager',
    );
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('does not require imapManager when no_quote disables inline-image fetching', async () => {
    const service = deps();

    const result = await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Reply',
      no_quote: true,
      include_inline_images: true,
    }, scope, service);

    expect(result.isError).not.toBe(true);
    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledOnce();
  });

  it('returns the queued write shape with threading and recipient computation', async () => {
    const service = deps({
      sendService: {
        sendOrEnqueue: vi.fn().mockResolvedValue({
          queued: true,
          outboxId: 'outbox-reply-1',
          sendAt: new Date('2026-07-28T10:00:30.000Z'),
          undoSeconds: 30,
        }),
      },
    });
    getUserPreferences.mockResolvedValue({ undoSendSeconds: 30 });

    const wireResult = await composeTools.handleReplyEmail({
      message_id: message.id,
      body: 'Queued reply',
    }, scope, service);

    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        undoSeconds: 30,
        idempotencyKey: undefined,
      }),
      service,
    );
    expect(payload(wireResult)).toEqual({
      queued: true,
      outbox_id: 'outbox-reply-1',
      send_at: '2026-07-28T10:00:30Z',
      undo_seconds: 30,
      recipients_computed: {
        reply_target: 'reply@example.com',
        excluded_self: [
          'alias-replies@example.com',
          'me@example.com',
          'team@example.com',
        ],
      },
      in_reply_to: '<original@example.com>',
      references: '<root@example.com> <original@example.com>',
      from: {},
      to: [],
      cc: [],
      bcc: [],
      subject: 'Re: Topic',
      attachments: [],
      note: 'Cancel with unsend_email before send_at.',
    });
  });
});

describe('reply_all_email', () => {
  it('excludes account and alias identities while preserving non-self recipients', async () => {
    const service = deps();

    const result = await composeTools.handleReplyAllEmail({
      message_id: message.id,
      body: 'Reply all',
      no_quote: true,
    }, scope, service);

    const [input] = service.sendService.sendOrEnqueue.mock.calls[0];
    expect(input.to).toEqual(['Reply Desk <reply@example.com>']);
    expect(input.cc).toEqual([
      'Other <other@example.com>',
      'Colleague <colleague@example.com>',
    ]);
    expect(payload(result).recipients_computed).toEqual({
      reply_target: 'reply@example.com',
      excluded_self: [
        'alias-replies@example.com',
        'me@example.com',
        'team@example.com',
      ],
    });
  });
});

describe('forward_email', () => {
  it('passes forward options and tags delivered attachments as forwarded', async () => {
    const forwardReceipt = {
      ...replyReceipt,
      to: [{ name: 'Recipient', email: 'recipient@example.com' }],
      subject: 'Fwd: Topic',
      attachments: [{ filename: 'deck.pdf', size: 2_144_000 }],
      messageId: '<forward@example.com>',
    };
    const service = deps({
      sendService: {
        sendOrEnqueue: vi.fn().mockResolvedValue({
          ok: true,
          messageId: '<forward@example.com>',
          sentCopySaved: true,
          receipt: forwardReceipt,
        }),
      },
    });

    const wireResult = await composeTools.handleForwardEmail({
      message_id: message.id,
      to: ['Recipient <recipient@example.com>'],
      note: 'Please review.',
      alias: 'team@example.com',
      undo_send_seconds: 0,
      idempotency_key: 'forward-1',
    }, scope, service);

    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        aliasId: 'alias-1',
        userId: 'user-1',
        to: ['Recipient <recipient@example.com>'],
        cc: [],
        bcc: [],
        subject: 'Fwd: Topic',
        body: 'Please review.',
        bodyIsHtml: false,
        forwardedAttachments: [{
          messageId: message.id,
          part: '2',
        }],
        undoSeconds: 0,
        idempotencyKey: 'forward-1',
      }),
      service,
    );
    expect(payload(wireResult).attachments).toEqual([{
      filename: 'deck.pdf',
      size: 2_144_000,
      source: 'forwarded',
    }]);
  });
});

describe('missing dependencies', () => {
  it.each([
    ['reply_email', composeTools.handleReplyEmail, {
      message_id: message.id,
      body: 'Reply',
    }],
    ['reply_all_email', composeTools.handleReplyAllEmail, {
      message_id: message.id,
      body: 'Reply all',
    }],
    ['forward_email', composeTools.handleForwardEmail, {
      message_id: message.id,
      to: ['recipient@example.com'],
    }],
  ])('%s degrades to unsupported when sendService is missing', async (_name, handler, args) => {
    const result = await handler(args, scope, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'unsupported: compose tools require sendService',
    );
    expect(getComposeSource).not.toHaveBeenCalled();
  });
});
