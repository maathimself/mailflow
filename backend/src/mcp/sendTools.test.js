import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./accountAdapter.js', () => ({
  deleteMessageRow: vi.fn(),
  getAccountByEmail: vi.fn(),
  getAccountRow: vi.fn(),
  getComposeSource: vi.fn(),
  getDraftRow: vi.fn(),
  getOutboxRowByMessageId: vi.fn(),
  getUserPreferences: vi.fn(),
}));
vi.mock('../services/mail/identity.js', () => ({
  resolveFromIdentity: vi.fn(),
}));

import {
  deleteMessageRow,
  getAccountByEmail,
  getAccountRow,
  getComposeSource,
  getDraftRow,
  getOutboxRowByMessageId,
  getUserPreferences,
} from './accountAdapter.js';
import * as sendTools from './sendTools.js';
import { HANDLERS, TOOL_DEFS, TOOL_SCOPES } from './tools.js';
import { resolveFromIdentity } from '../services/mail/identity.js';

const scope = {
  userId: 'user-1',
  accountIds: ['account-1'],
  scopes: ['send'],
};
const account = {
  id: 'account-1',
  email_address: 'sender@example.com',
  sender_name: 'Sender',
  folder_mappings: { drafts: 'Drafts' },
};
const identity = {
  fromName: 'Sender',
  fromEmail: 'sender@example.com',
  fromReplyTo: null,
  signature: null,
  aliasId: null,
};
const immediateReceipt = {
  from: { name: 'Sender', email: 'sender@example.com' },
  to: [{ name: 'Recipient', email: 'recipient@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Subject',
  attachments: [{ filename: 'note.txt', size: 5 }],
  messageId: '<sent@example.com>',
  sentCopySaved: true,
  folder: 'Sent',
};

function deps(overrides = {}) {
  return {
    sendService: {
      sendOrEnqueue: vi.fn().mockResolvedValue({
        ok: true,
        messageId: '<sent@example.com>',
        sentCopySaved: true,
        receipt: immediateReceipt,
      }),
    },
    outboxService: {
      normalizeUndoWindow: vi.fn((requested, preference) => requested ?? preference ?? 0),
      cancel: vi.fn().mockResolvedValue({ cancelled: true }),
      listPending: vi.fn().mockResolvedValue([]),
    },
    draftService: {
      deleteDraft: vi.fn().mockResolvedValue({ ok: true }),
      saveDraft: vi.fn().mockResolvedValue({
        uid: 57,
        folder: 'Drafts',
        messageId: '<followup@example.com>',
      }),
    },
    imapManager: {
      permanentDeleteMessage: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccountByEmail.mockResolvedValue(account);
  getAccountRow.mockResolvedValue(account);
  getComposeSource.mockResolvedValue(null);
  getOutboxRowByMessageId.mockResolvedValue(null);
  getUserPreferences.mockResolvedValue({});
  deleteMessageRow.mockResolvedValue(undefined);
  resolveFromIdentity.mockResolvedValue(identity);
});

describe('send tool definitions and registration', () => {
  it('publishes the plan schemas, descriptions, annotations, scopes, and handlers', () => {
    expect(sendTools.sendEmailDef).toEqual({
      name: 'send_email',
      description: 'Send an email. When undo_send_seconds > 0 the message is QUEUED and can be cancelled with unsend_email until send_at; when 0 it is delivered immediately. Returns a receipt of exactly what was sent.',
      inputSchema: {
        type: 'object',
        required: ['account', 'to'],
        properties: {
          account: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
          body_html: { type: 'string' },
          alias: {
            type: 'string',
            description: 'Send-as alias email; must be configured on the account (hard error if not)',
          },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              required: ['filename', 'content'],
              properties: {
                filename: { type: 'string' },
                content: { type: 'string', description: 'base64' },
                content_type: { type: 'string' },
              },
            },
          },
          undo_send_seconds: {
            type: 'integer',
            minimum: 0,
            maximum: 120,
            description: "Cancellation window in seconds (max 120). Defaults to the user's undo-send preference.",
          },
          idempotency_key: {
            type: 'string',
            description: 'Stable key; a retry with the same key returns the original result instead of sending twice.',
          },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    });

    expect(sendTools.sendDraftDef).toEqual({
      name: 'send_draft',
      description: 'Reads the draft via `getDraftRow`, reconstructs the compose input (recipients from `to_addresses`/`cc_addresses`, body from `body_text`/`body_html`, threading from `in_reply_to`/`thread_references`), sends, and **deletes the draft only after delivery succeeds** (or after enqueue succeeds, with a `delete_draft_on_send` flag on the outbox payload the worker honors). Errors `draft_not_found` when the uid is absent or not a draft.',
      inputSchema: {
        type: 'object',
        required: ['account', 'draft_uid'],
        properties: {
          account: { type: 'string' },
          draft_uid: { type: 'integer' },
          folder: { type: 'string' },
          undo_send_seconds: {
            type: 'integer',
            minimum: 0,
            maximum: 120,
            description: "Cancellation window in seconds (max 120). Defaults to the user's undo-send preference.",
          },
          idempotency_key: {
            type: 'string',
            description: 'Stable key; a retry with the same key returns the original result instead of sending twice.',
          },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    });

    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const [name, handler] of [
      ['send_email', sendTools.handleSendEmail],
      ['send_draft', sendTools.handleSendDraft],
    ]) {
      expect(defs.get(name)).toBeTruthy();
      expect(TOOL_SCOPES[name]).toBe('send');
      expect(HANDLERS[name]).toBe(handler);
    }
  });

  it('publishes and registers the unsend, outbox-list, and recall tools', () => {
    expect(sendTools.unsendEmailDef).toEqual({
      name: 'unsend_email',
      description: 'Cancel a queued email before it is delivered. Only works while the message is still in its undo window (see the send_at returned by send_email).',
      inputSchema: {
        type: 'object',
        required: ['outbox_id'],
        properties: {
          outbox_id: { type: 'string' },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(sendTools.listOutboxDef).toEqual({
      name: 'list_outbox',
      description: 'List emails still queued in the undo-send outbox. Entries can be cancelled with unsend_email before send_at.',
      inputSchema: { type: 'object', properties: {} },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(sendTools.recallEmailDef).toEqual({
      name: 'recall_email',
      description: "Best-effort recall of an already-sent message. SMTP CANNOT retract delivered mail — recipients already have it. This tool (1) cancels the send if it is still queued, otherwise (2) deletes your Sent copy and (3) prepares a 'please disregard' follow-up DRAFT addressed to the original recipients, which it never sends automatically.",
      inputSchema: {
        type: 'object',
        properties: {
          message_id: {
            type: 'string',
            description: 'Id of the sent message (from search or the Sent folder)',
          },
          outbox_id: {
            type: 'string',
            description: "Alternative: a queued message's outbox id",
          },
          delete_sent_copy: { type: 'boolean', default: true },
          draft_followup: { type: 'boolean', default: true },
          followup_note: {
            type: 'string',
            description: "Body of the follow-up draft; defaults to a short 'please disregard' note.",
          },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    });

    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const [name, requiredScope, handler] of [
      ['unsend_email', 'send', sendTools.handleUnsendEmail],
      ['list_outbox', 'read', sendTools.handleListOutbox],
      ['recall_email', 'send', sendTools.handleRecallEmail],
    ]) {
      expect(defs.get(name)).toBeTruthy();
      expect(TOOL_SCOPES[name]).toBe(requiredScope);
      expect(HANDLERS[name]).toBe(handler);
    }
  });
});

describe('send_email', () => {
  it('does not reveal an out-of-scope account and never calls the service', async () => {
    const service = deps();
    getAccountByEmail.mockResolvedValue({ error: 'account_not_found: foreign@example.com' });

    const result = await sendTools.handleSendEmail({
      account: 'foreign@example.com',
      to: ['recipient@example.com'],
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account_not_found: foreign@example.com');
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('hard-fails an unknown alias and preserves its stable error code', async () => {
    const service = deps();
    resolveFromIdentity.mockRejectedValue(
      Object.assign(new Error('Alias not found'), { code: 'alias_not_found' }),
    );

    const result = await sendTools.handleSendEmail({
      account: 'sender@example.com',
      to: ['recipient@example.com'],
      alias: 'unknown@example.com',
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('alias_not_found: Alias not found');
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('maps malformed recipients to invalid_recipient before sending', async () => {
    const service = deps();

    const result = await sendTools.handleSendEmail({
      account: 'sender@example.com',
      to: ['victim@example.com\r\nBcc: attacker@example.com'],
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^invalid_recipient: /);
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('rejects more than 100 total recipients as too_many_recipients', async () => {
    const service = deps();

    const result = await sendTools.handleSendEmail({
      account: 'sender@example.com',
      to: Array.from({ length: 99 }, (_, i) => `to-${i}@example.com`),
      cc: ['copy@example.com'],
      bcc: ['blind@example.com'],
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'too_many_recipients: Too many recipients (max 100)',
    );
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('sends immediately with normalized input and returns the exact write receipt', async () => {
    const service = deps();
    const aliasIdentity = {
      ...identity,
      fromName: 'Team',
      fromEmail: 'team@example.com',
      aliasId: 'alias-1',
    };
    resolveFromIdentity.mockResolvedValue(aliasIdentity);
    getUserPreferences.mockResolvedValue({ undoSendSeconds: 60 });

    const wireResult = await sendTools.handleSendEmail({
      account: 'sender@example.com',
      to: [' Recipient <recipient@example.com> '],
      cc: [],
      bcc: [],
      subject: 'Subject',
      body: 'Plain fallback',
      body_html: '<p>Body</p>',
      alias: 'team@example.com',
      priority: 'high',
      attachments: [{
        filename: 'note.txt',
        content: 'aGVsbG8=',
        content_type: 'text/plain',
      }],
      undo_send_seconds: 0,
      idempotency_key: 'send-1',
    }, scope, service);
    expect(wireResult.isError).not.toBe(true);
    const result = payload(wireResult);

    expect(getAccountByEmail).toHaveBeenCalledWith('sender@example.com', ['account-1']);
    expect(resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasEmail: 'team@example.com' },
      service,
    );
    expect(getUserPreferences).toHaveBeenCalledWith('user-1');
    expect(service.outboxService.normalizeUndoWindow).toHaveBeenCalledWith(0, 60);
    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith({
      userId: 'user-1',
      account,
      aliasId: 'alias-1',
      aliasEmail: 'team@example.com',
      to: ['Recipient <recipient@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Subject',
      body: '<p>Body</p>',
      bodyIsHtml: true,
      priority: 'high',
      attachments: [{
        filename: 'note.txt',
        content: 'aGVsbG8=',
        contentType: 'text/plain',
      }],
      undoSeconds: 0,
      idempotencyKey: 'send-1',
    }, service);
    expect(result).toEqual({
      sent: true,
      message_id: '<sent@example.com>',
      from: { name: 'Sender', email: 'sender@example.com' },
      to: [{ name: 'Recipient', email: 'recipient@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Subject',
      attachments: [{ filename: 'note.txt', size: 5 }],
      sent_copy_saved: true,
      folder: 'Sent',
    });
  });

  it('uses the preference undo window and returns the exact queued result shape', async () => {
    const sendAt = new Date('2026-07-28T10:00:30.000Z');
    const service = deps({
      sendService: {
        sendOrEnqueue: vi.fn().mockResolvedValue({
          queued: true,
          outboxId: 'outbox-1',
          sendAt,
          undoSeconds: 30,
        }),
      },
    });
    getUserPreferences.mockResolvedValue({ undoSendSeconds: 30 });

    const wireResult = await sendTools.handleSendEmail({
      account: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Subject',
      idempotency_key: 'queued-1',
    }, scope, service);

    expect(wireResult.isError).not.toBe(true);
    expect(service.outboxService.normalizeUndoWindow).toHaveBeenCalledWith(undefined, 30);
    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        undoSeconds: 30,
        idempotencyKey: 'queued-1',
      }),
      service,
    );
    expect(payload(wireResult)).toEqual({
      queued: true,
      outbox_id: 'outbox-1',
      send_at: '2026-07-28T10:00:30Z',
      undo_seconds: 30,
      from: {},
      to: [],
      cc: [],
      bcc: [],
      subject: 'Subject',
      attachments: [],
      note: 'Cancel with unsend_email before send_at.',
    });
  });

  it('defaults the undo window to zero when no argument or preference exists', async () => {
    const service = deps();

    await sendTools.handleSendEmail({
      account: 'sender@example.com',
      to: ['recipient@example.com'],
    }, scope, service);

    expect(service.outboxService.normalizeUndoWindow).toHaveBeenCalledWith(
      undefined,
      undefined,
    );
    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ undoSeconds: 0 }),
      service,
    );
  });

  it.each([
    ['invalid_recipient', 'Recipient is invalid'],
    ['too_many_recipients', 'Too many recipients'],
  ])('preserves an underlying %s service error', async (code, message) => {
    const service = deps({
      sendService: {
        sendOrEnqueue: vi.fn().mockRejectedValue(
          Object.assign(new Error(message), { code }),
        ),
      },
    });

    const result = await sendTools.handleSendEmail({
      account: 'sender@example.com',
      to: ['recipient@example.com'],
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`${code}: ${message}`);
  });
});

describe('send_draft', () => {
  it('returns draft_not_found for an absent folder and uid match', async () => {
    const service = deps();
    getDraftRow.mockResolvedValue(null);

    const result = await sendTools.handleSendDraft({
      account: 'sender@example.com',
      draft_uid: 404,
      folder: 'Other Drafts',
    }, scope, service);

    expect(getDraftRow).toHaveBeenCalledWith('account-1', 'Other Drafts', 404);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('draft_not_found: 404');
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
    expect(service.draftService.deleteDraft).not.toHaveBeenCalled();
  });

  it('reconstructs and immediately sends a draft before deleting it', async () => {
    const service = deps();
    const draft = {
      uid: 7,
      folder: 'Drafts',
      from_email: 'team@example.com',
      to_addresses: [{ name: 'Recipient', email: 'recipient@example.com' }],
      cc_addresses: [{ name: '', email: 'copy@example.com' }],
      bcc_addresses: [{ name: '', email: 'blind@example.com' }],
      subject: 'Draft subject',
      body_text: 'Plain fallback',
      body_html: '<p>Draft body</p>',
      in_reply_to: '<parent@example.com>',
      thread_references: '<root@example.com> <parent@example.com>',
    };
    getDraftRow.mockResolvedValue(draft);
    getUserPreferences.mockResolvedValue({ undoSendSeconds: 60 });
    resolveFromIdentity.mockResolvedValue({
      ...identity,
      fromName: 'Team',
      fromEmail: 'team@example.com',
      aliasId: 'alias-1',
    });

    const wireResult = await sendTools.handleSendDraft({
      account: 'sender@example.com',
      draft_uid: 7,
      undo_send_seconds: 0,
      idempotency_key: 'draft-7',
    }, scope, service);

    expect(wireResult.isError).not.toBe(true);
    expect(resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasEmail: 'team@example.com' },
      service,
    );
    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith({
      userId: 'user-1',
      account,
      aliasId: 'alias-1',
      aliasEmail: 'team@example.com',
      to: ['Recipient <recipient@example.com>'],
      cc: ['copy@example.com'],
      bcc: ['blind@example.com'],
      subject: 'Draft subject',
      body: '<p>Draft body</p>',
      bodyIsHtml: true,
      inReplyTo: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
      undoSeconds: 0,
      idempotencyKey: 'draft-7',
    }, service);
    expect(service.draftService.deleteDraft).toHaveBeenCalledWith({
      account,
      uid: 7,
      folder: 'Drafts',
    }, service);
    expect(
      service.sendService.sendOrEnqueue.mock.invocationCallOrder[0],
    ).toBeLessThan(service.draftService.deleteDraft.mock.invocationCallOrder[0]);
    expect(payload(wireResult)).toEqual({
      sent: true,
      message_id: '<sent@example.com>',
      from: { name: 'Sender', email: 'sender@example.com' },
      to: [{ name: 'Recipient', email: 'recipient@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Subject',
      attachments: [{ filename: 'note.txt', size: 5 }],
      sent_copy_saved: true,
      folder: 'Sent',
    });
  });

  it('queues a draft with a delete-on-send marker and does not delete synchronously', async () => {
    const sendAt = new Date('2026-07-28T10:00:30.000Z');
    const service = deps({
      sendService: {
        sendOrEnqueue: vi.fn().mockResolvedValue({
          queued: true,
          outboxId: 'outbox-draft-7',
          sendAt,
          undoSeconds: 30,
        }),
      },
    });
    getDraftRow.mockResolvedValue({
      uid: 7,
      folder: 'Drafts',
      from_email: 'sender@example.com',
      to_addresses: [{ name: '', email: 'recipient@example.com' }],
      cc_addresses: [],
      bcc_addresses: [],
      subject: 'Queued draft',
      body_text: 'Queued body',
      body_html: '',
      in_reply_to: null,
      thread_references: null,
    });
    getUserPreferences.mockResolvedValue({ undoSendSeconds: 30 });

    const wireResult = await sendTools.handleSendDraft({
      account: 'sender@example.com',
      draft_uid: 7,
    }, scope, service);

    expect(wireResult.isError).not.toBe(true);
    expect(service.sendService.sendOrEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        undoSeconds: 30,
        deleteDraftOnSend: { uid: 7, folder: 'Drafts' },
      }),
      service,
    );
    expect(service.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(payload(wireResult)).toEqual({
      queued: true,
      outbox_id: 'outbox-draft-7',
      send_at: '2026-07-28T10:00:30Z',
      undo_seconds: 30,
      from: {},
      to: [],
      cc: [],
      bcc: [],
      subject: 'Queued draft',
      attachments: [],
      note: 'Cancel with unsend_email before send_at.',
    });
  });

  it('keeps a successful immediate send successful when draft cleanup fails', async () => {
    const service = deps();
    service.draftService.deleteDraft.mockRejectedValue(new Error('IMAP delete failed'));
    getDraftRow.mockResolvedValue({
      uid: 7,
      folder: 'Drafts',
      from_email: 'sender@example.com',
      to_addresses: [{ name: '', email: 'recipient@example.com' }],
      cc_addresses: [],
      bcc_addresses: [],
      subject: 'Draft subject',
      body_text: 'Draft body',
      body_html: '',
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendTools.handleSendDraft({
      account: 'sender@example.com',
      draft_uid: 7,
      undo_send_seconds: 0,
    }, scope, service);

    expect(result.isError).not.toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      'Draft cleanup after send failed:',
      'IMAP delete failed',
    );
  });
});

describe('queued draft payload transport', () => {
  it('preserves deleteDraftOnSend in the credential-free outbox payload', async () => {
    const { sendOrEnqueue } = await import('../services/sendService.js');
    const outboxService = {
      enqueue: vi.fn().mockResolvedValue({
        outbox_id: 'outbox-draft-7',
        send_at: new Date('2026-07-28T10:00:30.000Z'),
        undo_seconds: 30,
      }),
    };
    const service = {
      outboxService,
      resolveFromIdentity: vi.fn().mockResolvedValue(identity),
      randomBytes: vi.fn(() => Buffer.alloc(16, 1)),
    };

    await sendOrEnqueue({
      userId: 'user-1',
      account,
      to: ['recipient@example.com'],
      cc: [],
      bcc: [],
      subject: 'Queued draft',
      body: 'Queued body',
      bodyIsHtml: false,
      undoSeconds: 30,
      deleteDraftOnSend: { uid: 7, folder: 'Drafts' },
    }, service);

    expect(outboxService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          deleteDraftOnSend: { uid: 7, folder: 'Drafts' },
        }),
      }),
      service,
    );
  });
});

describe('unsend_email', () => {
  it('cancels a pending outbox row and returns its prefetched metadata', async () => {
    const service = deps();
    service.outboxService.listPending.mockResolvedValue([{
      id: 'outbox-1',
      subject: 'Queued subject',
      to_preview: ['recipient@example.com'],
      send_at: new Date('2026-07-28T10:00:30.000Z'),
    }]);

    const result = await sendTools.handleUnsendEmail(
      { outbox_id: 'outbox-1' },
      scope,
      service,
    );

    expect(service.outboxService.listPending).toHaveBeenCalledWith(
      { userId: 'user-1' },
      service,
    );
    expect(service.outboxService.cancel).toHaveBeenCalledWith(
      { id: 'outbox-1', userId: 'user-1' },
      service,
    );
    expect(payload(result)).toEqual({
      cancelled: true,
      outbox_id: 'outbox-1',
      subject: 'Queued subject',
      to: ['recipient@example.com'],
    });
  });

  it('returns already_sent when the undo window has closed', async () => {
    const service = deps();
    service.outboxService.cancel.mockResolvedValue({
      cancelled: false,
      reason: 'already_sent',
    });

    const result = await sendTools.handleUnsendEmail(
      { outbox_id: 'outbox-sent' },
      scope,
      service,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'already_sent: message outbox-sent is no longer pending and cannot be unsent',
    );
  });

  it('returns outbox_not_found for an absent or out-of-scope id', async () => {
    const service = deps();
    service.outboxService.cancel.mockResolvedValue({
      cancelled: false,
      reason: 'not_found',
    });

    const result = await sendTools.handleUnsendEmail(
      { outbox_id: 'outbox-missing' },
      scope,
      service,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('outbox_not_found: outbox-missing');
  });

  it('treats an already-cancelled row as an idempotent success', async () => {
    const service = deps();
    service.outboxService.cancel.mockResolvedValue({
      cancelled: false,
      reason: 'cancelled',
    });

    const result = await sendTools.handleUnsendEmail(
      { outbox_id: 'outbox-cancelled' },
      scope,
      service,
    );

    expect(payload(result)).toEqual({
      cancelled: true,
      outbox_id: 'outbox-cancelled',
      subject: '',
      to: [],
    });
  });
});

describe('list_outbox', () => {
  it('returns pending rows in a no-total pagination envelope', async () => {
    const service = deps();
    service.outboxService.listPending.mockResolvedValue([{
      id: 'outbox-1',
      subject: 'Queued subject',
      to_preview: ['recipient@example.com'],
      send_at: new Date('2026-07-28T10:00:30.000Z'),
    }]);

    const result = await sendTools.handleListOutbox({}, scope, service);

    expect(service.outboxService.listPending).toHaveBeenCalledWith(
      { userId: 'user-1' },
      service,
    );
    expect(payload(result)).toEqual({
      data: [{
        id: 'outbox-1',
        subject: 'Queued subject',
        to_preview: ['recipient@example.com'],
        send_at: '2026-07-28T10:00:30Z',
      }],
      total: -1,
      returned: 1,
      offset: 0,
      has_more: false,
    });
  });

  it('degrades to unsupported without outboxService.listPending', async () => {
    const result = await sendTools.handleListOutbox({}, scope, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'unsupported: list_outbox requires outboxService',
    );
  });
});

describe('recall_email', () => {
  const delivered = {
    id: 'message-1',
    account_id: 'account-1',
    uid: 42,
    folder: 'Sent',
    message_id: '<sent@example.com>',
    subject: 'Project update',
    to_addresses: [{ name: 'Recipient', email: 'recipient@example.com' }],
    cc_addresses: [{ name: '', email: 'copy@example.com' }],
  };

  it('cancels a pending row found by message id before touching a Sent copy', async () => {
    const service = deps();
    getOutboxRowByMessageId.mockResolvedValue({
      id: 'outbox-1',
      message_id: '<queued@example.com>',
      subject: 'Queued subject',
      to_preview: ['recipient@example.com'],
    });

    const result = await sendTools.handleRecallEmail(
      { message_id: '<queued@example.com>' },
      scope,
      service,
    );

    expect(getOutboxRowByMessageId).toHaveBeenCalledWith(
      '<queued@example.com>',
      'user-1',
    );
    expect(service.outboxService.cancel).toHaveBeenCalledWith(
      { id: 'outbox-1', userId: 'user-1' },
      service,
    );
    expect(payload(result)).toEqual({
      recalled: 'cancelled_before_send',
      outbox_id: 'outbox-1',
      subject: 'Queued subject',
      to: ['recipient@example.com'],
    });
    expect(getComposeSource).not.toHaveBeenCalled();
    expect(service.imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(service.draftService.saveDraft).not.toHaveBeenCalled();
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('deletes the Sent copy and creates, but never sends, a threaded follow-up draft', async () => {
    const service = deps();
    getComposeSource.mockResolvedValue(delivered);

    const result = await sendTools.handleRecallEmail(
      {
        message_id: 'message-1',
        followup_note: 'Please disregard the previous update.',
      },
      scope,
      service,
    );

    expect(getComposeSource).toHaveBeenCalledWith('message-1', ['account-1']);
    expect(getAccountRow).toHaveBeenCalledWith('account-1', ['account-1']);
    expect(service.imapManager.permanentDeleteMessage).toHaveBeenCalledWith(
      account,
      42,
      'Sent',
    );
    expect(deleteMessageRow).toHaveBeenCalledWith('account-1', 42, 'Sent');
    expect(service.draftService.saveDraft).toHaveBeenCalledWith({
      userId: 'user-1',
      account,
      to: ['Recipient <recipient@example.com>'],
      cc: ['copy@example.com'],
      bcc: [],
      subject: 'Re: Project update',
      body: 'Please disregard the previous update.',
      bodyIsHtml: false,
      attachments: [],
      inReplyTo: '<sent@example.com>',
    }, service);
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
    expect(payload(result)).toEqual({
      recalled: 'not_possible',
      note: 'SMTP cannot retract a delivered message. Recipients already received it; deleting your Sent copy does not affect their mailboxes.',
      sent_copy_deleted: true,
      followup_draft: {
        draft_uid: 57,
        folder: 'Drafts',
      },
    });
  });

  it('keeps the Sent copy when delete_sent_copy is false', async () => {
    const service = deps();
    getComposeSource.mockResolvedValue(delivered);

    const result = await sendTools.handleRecallEmail(
      { message_id: 'message-1', delete_sent_copy: false },
      scope,
      service,
    );

    expect(service.imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(deleteMessageRow).not.toHaveBeenCalled();
    expect(service.draftService.saveDraft).toHaveBeenCalled();
    expect(payload(result)).toMatchObject({
      recalled: 'not_possible',
      sent_copy_deleted: false,
      followup_draft: { draft_uid: 57, folder: 'Drafts' },
    });
  });

  it('does not create a follow-up when draft_followup is false', async () => {
    const service = deps();
    getComposeSource.mockResolvedValue(delivered);

    const result = await sendTools.handleRecallEmail(
      { message_id: 'message-1', draft_followup: false },
      scope,
      service,
    );

    expect(service.imapManager.permanentDeleteMessage).toHaveBeenCalled();
    expect(deleteMessageRow).toHaveBeenCalled();
    expect(service.draftService.saveDraft).not.toHaveBeenCalled();
    expect(service.sendService.sendOrEnqueue).not.toHaveBeenCalled();
    expect(payload(result)).toEqual({
      recalled: 'not_possible',
      note: 'SMTP cannot retract a delivered message. Recipients already received it; deleting your Sent copy does not affect their mailboxes.',
      sent_copy_deleted: true,
    });
  });

  it('returns message_not_found without destructive effects', async () => {
    const service = deps();

    const result = await sendTools.handleRecallEmail(
      { message_id: 'message-missing' },
      scope,
      service,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('message_not_found: message-missing');
    expect(service.imapManager.permanentDeleteMessage).not.toHaveBeenCalled();
    expect(deleteMessageRow).not.toHaveBeenCalled();
    expect(service.draftService.saveDraft).not.toHaveBeenCalled();
  });
});

describe('missing dependencies', () => {
  it.each([
    ['send_email/sendService', sendTools.handleSendEmail, {
      account: 'sender@example.com',
      to: ['recipient@example.com'],
    }, {
      outboxService: { normalizeUndoWindow: vi.fn() },
    }],
    ['send_draft/sendService', sendTools.handleSendDraft, {
      account: 'sender@example.com',
      draft_uid: 7,
    }, {
      draftService: { deleteDraft: vi.fn() },
      outboxService: { normalizeUndoWindow: vi.fn() },
    }],
    ['send_draft/draftService', sendTools.handleSendDraft, {
      account: 'sender@example.com',
      draft_uid: 7,
    }, {
      sendService: { sendOrEnqueue: vi.fn() },
      outboxService: { normalizeUndoWindow: vi.fn() },
    }],
    ['unsend_email/outboxService', sendTools.handleUnsendEmail, {
      outbox_id: 'outbox-1',
    }, {}],
    ['recall_email/outboxService', sendTools.handleRecallEmail, {
      message_id: 'message-1',
    }, {}],
  ])('%s degrades to unsupported', async (_name, handler, args, service) => {
    const result = await handler(args, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^unsupported: /);
  });
});
