import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./accountAdapter.js', () => ({
  getAccountByEmail: vi.fn(),
  getAccountRow: vi.fn(),
  getComposeSource: vi.fn(),
  getDraftRow: vi.fn(),
  listDraftRows: vi.fn(),
}));
vi.mock('../services/mail/identity.js', () => ({
  resolveFromIdentity: vi.fn(),
}));
vi.mock('../services/replyService.js', () => ({
  buildReferences: vi.fn(),
}));

import {
  getAccountByEmail,
  getAccountRow,
  getComposeSource,
  getDraftRow,
  listDraftRows,
} from './accountAdapter.js';
import {
  createDraftDef,
  deleteDraftDef,
  getDraftDef,
  handleCreateDraft,
  handleDeleteDraft,
  handleGetDraft,
  handleListDrafts,
  handleUpdateDraft,
  listDraftsDef,
  updateDraftDef,
} from './draftTools.js';
import { HANDLERS, TOOL_DEFS, TOOL_SCOPES } from './tools.js';
import { resolveFromIdentity } from '../services/mail/identity.js';
import { buildReferences } from '../services/replyService.js';

const scope = {
  userId: 'user-1',
  accountIds: ['account-1'],
  scopes: ['read', 'write'],
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

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function deps(overrides = {}) {
  return {
    draftService: {
      saveDraft: vi.fn().mockResolvedValue({
        uid: 42,
        folder: 'Drafts',
        messageId: '<draft@example.com>',
      }),
      deleteDraft: vi.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccountByEmail.mockResolvedValue(account);
  getAccountRow.mockResolvedValue(account);
  resolveFromIdentity.mockResolvedValue(identity);
  buildReferences.mockReturnValue({
    inReplyTo: '<original@example.com>',
    references: '<root@example.com> <original@example.com>',
  });
});

describe('draft tool definitions and registration', () => {
  it('publishes the plan schemas, descriptions, annotations, scopes, and handlers', () => {
    expect(createDraftDef).toEqual({
      name: 'create_draft',
      description: "Create a draft email in the account's Drafts folder. Does NOT send. Returns the draft's uid and folder for later update_draft/send_draft/delete_draft calls.",
      inputSchema: {
        type: 'object',
        required: ['account'],
        properties: {
          account: { type: 'string', description: 'Account email address (see get_stats for available accounts)' },
          to: { type: 'array', items: { type: 'string' }, description: "Recipients as 'Name <email>' or bare 'email'" },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain-text body' },
          body_html: { type: 'string', description: 'HTML body. When set, takes precedence over body for the HTML part.' },
          reply_to_message_id: { type: 'string', description: 'Message id to thread this draft under; sets In-Reply-To and References.' },
          alias: { type: 'string', description: 'Send-as alias email. Must be a configured alias on the account — errors if unknown, never silently falls back.' },
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
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    expect(updateDraftDef.description).toContain(
      'IMAP has no update-in-place for messages: this appends a new draft and deletes the old one, so the draft_uid CHANGES. Use the returned draft_uid for subsequent calls.',
    );
    expect(updateDraftDef.inputSchema.required).toEqual(['account', 'draft_uid']);
    expect(updateDraftDef.inputSchema.properties).toEqual(expect.objectContaining({
      draft_uid: { type: 'integer' },
      folder: { type: 'string' },
    }));
    expect(listDraftsDef.inputSchema.properties.limit).toEqual({
      type: 'integer',
      default: 20,
      maximum: 100,
    });
    expect(getDraftDef.inputSchema.required).toEqual(['account', 'draft_uid']);
    expect(deleteDraftDef.description).toContain(
      'PERMANENTLY deletes the draft from IMAP — it does not go to Trash and cannot be recovered.',
    );

    const defs = new Map(TOOL_DEFS.map(def => [def.name, def]));
    for (const [name, requiredScope, handler] of [
      ['create_draft', 'write', handleCreateDraft],
      ['update_draft', 'write', handleUpdateDraft],
      ['list_drafts', 'read', handleListDrafts],
      ['get_draft', 'read', handleGetDraft],
      ['delete_draft', 'write', handleDeleteDraft],
    ]) {
      expect(defs.get(name)).toBeTruthy();
      expect(TOOL_SCOPES[name]).toBe(requiredScope);
      expect(HANDLERS[name]).toBe(handler);
    }
  });
});

describe('create_draft', () => {
  it('resolves the scoped account and alias, threads the draft, saves it, and returns a write receipt', async () => {
    const service = deps();
    getComposeSource.mockResolvedValue({
      id: 'message-1',
      message_id: '<original@example.com>',
      thread_references: '<root@example.com>',
    });
    resolveFromIdentity.mockResolvedValue({
      ...identity,
      fromName: 'Team',
      fromEmail: 'team@example.com',
      aliasId: 'alias-1',
    });

    const result = payload(await handleCreateDraft({
      account: 'sender@example.com',
      to: ['Recipient <recipient@example.com>'],
      cc: ['copy@example.com'],
      subject: 'Subject',
      body: 'plain fallback',
      body_html: '<p>Hello</p>',
      reply_to_message_id: 'message-1',
      alias: 'team@example.com',
      attachments: [{
        filename: 'note.txt',
        content: 'aGVsbG8=',
        content_type: 'text/plain',
      }],
    }, scope, service));

    expect(getAccountByEmail).toHaveBeenCalledWith('sender@example.com', ['account-1']);
    expect(resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasEmail: 'team@example.com' },
      service,
    );
    expect(getComposeSource).toHaveBeenCalledWith('message-1', ['account-1']);
    expect(buildReferences).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1' }));
    expect(service.draftService.saveDraft).toHaveBeenCalledWith({
      userId: 'user-1',
      account,
      aliasEmail: 'team@example.com',
      to: ['Recipient <recipient@example.com>'],
      cc: ['copy@example.com'],
      bcc: [],
      subject: 'Subject',
      body: '<p>Hello</p>',
      bodyIsHtml: true,
      attachments: [{
        filename: 'note.txt',
        content: 'aGVsbG8=',
        contentType: 'text/plain',
      }],
      inReplyTo: '<original@example.com>',
      references: '<root@example.com> <original@example.com>',
    }, service);
    expect(result).toEqual({
      draft_uid: 42,
      folder: 'Drafts',
      message_id: '<draft@example.com>',
      receipt: {
        message_id: '<draft@example.com>',
        from: { name: 'Team', email: 'team@example.com' },
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
        cc: [{ name: '', email: 'copy@example.com' }],
        bcc: [],
        subject: 'Subject',
        attachments: [{ filename: 'note.txt', size: 5 }],
      },
    });
  });

  it('does not reveal an out-of-scope account and never calls the service', async () => {
    const service = deps();
    getAccountByEmail.mockResolvedValue({ error: 'account_not_found: foreign@example.com' });

    const result = await handleCreateDraft(
      { account: 'foreign@example.com' },
      scope,
      service,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('account_not_found: foreign@example.com');
    expect(service.draftService.saveDraft).not.toHaveBeenCalled();
  });

  it('hard-fails an unknown alias and preserves its stable error code', async () => {
    const service = deps();
    resolveFromIdentity.mockRejectedValue(
      Object.assign(new Error('Alias not found'), { code: 'alias_not_found' }),
    );

    const result = await handleCreateDraft({
      account: 'sender@example.com',
      alias: 'unknown@example.com',
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('alias_not_found: Alias not found');
    expect(service.draftService.saveDraft).not.toHaveBeenCalled();
  });

  it('returns message_not_found for an out-of-scope reply source', async () => {
    const service = deps();
    getComposeSource.mockResolvedValue(null);

    const result = await handleCreateDraft({
      account: 'sender@example.com',
      reply_to_message_id: 'foreign-message',
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('message_not_found: foreign-message');
    expect(service.draftService.saveDraft).not.toHaveBeenCalled();
  });
});

describe('update_draft', () => {
  it('carries over every unsupplied compose field and returns the replacement uid', async () => {
    const service = deps();
    getDraftRow.mockResolvedValue({
      uid: 9,
      folder: 'Drafts',
      to_addresses: [{ name: 'Original', email: 'original@example.com' }],
      cc_addresses: [{ name: '', email: 'copy@example.com' }],
      bcc_addresses: [{ name: '', email: 'blind@example.com' }],
      subject: 'Original subject',
      body_text: 'Original body',
      body_html: null,
      in_reply_to: '<parent@example.com>',
      thread_references: '<root@example.com> <parent@example.com>',
      attachments: [],
    });

    const result = payload(await handleUpdateDraft({
      account: 'sender@example.com',
      draft_uid: 9,
      body: 'Edited body only',
    }, scope, service));

    expect(getDraftRow).toHaveBeenCalledWith('account-1', 'Drafts', 9);
    expect(service.draftService.saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      account,
      to: ['Original <original@example.com>'],
      cc: ['copy@example.com'],
      bcc: ['blind@example.com'],
      subject: 'Original subject',
      body: 'Edited body only',
      bodyIsHtml: false,
      inReplyTo: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
      existingUid: 9,
      existingFolder: 'Drafts',
    }), service);
    expect(result.draft_uid).toBe(42);
    expect(result.draft_uid).not.toBe(9);
    expect(result.receipt.to).toEqual([{ name: 'Original', email: 'original@example.com' }]);
  });

  it('returns draft_not_found without saving when the existing row is absent', async () => {
    const service = deps();
    getDraftRow.mockResolvedValue(null);

    const result = await handleUpdateDraft({
      account: 'sender@example.com',
      draft_uid: 404,
    }, scope, service);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('draft_not_found: 404');
    expect(service.draftService.saveDraft).not.toHaveBeenCalled();
  });
});

describe('list_drafts and get_draft', () => {
  it('lists shaped draft summaries with the shared pagination envelope', async () => {
    listDraftRows.mockResolvedValue([
      {
        uid: 7,
        folder: 'Drafts',
        subject: 'Draft subject',
        to_addresses: [{ name: '', email: 'to@example.com' }],
        cc_addresses: [],
        snippet: 'Draft snippet',
        date: '2026-07-28T10:00:00.000Z',
        has_attachments: true,
      },
    ]);

    const result = payload(await handleListDrafts({
      account: 'sender@example.com',
      limit: 20,
      offset: 0,
    }, scope, deps()));

    expect(listDraftRows).toHaveBeenCalledWith('account-1', {
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
      folder: 'Drafts',
    });
    expect(result).toEqual({
      data: [{
        draft_uid: 7,
        folder: 'Drafts',
        subject: 'Draft subject',
        to: [{ name: '', email: 'to@example.com' }],
        cc: [],
        snippet: 'Draft snippet',
        date: '2026-07-28T10:00:00Z',
        has_attachments: true,
      }],
      total: 1,
      returned: 1,
      offset: 0,
      has_more: false,
    });
  });

  it('uses every scoped account when list_drafts omits account', async () => {
    const multiScope = { ...scope, accountIds: ['account-1', 'account-2'] };
    getAccountRow
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce({
        ...account,
        id: 'account-2',
        email_address: 'other@example.com',
      });
    listDraftRows
      .mockResolvedValueOnce([{ uid: 1, folder: 'Drafts', date: '2026-01-01T00:00:00Z' }])
      .mockResolvedValueOnce([{ uid: 2, folder: 'Drafts', date: '2026-02-01T00:00:00Z' }]);

    const result = payload(await handleListDrafts({}, multiScope, deps()));

    expect(getAccountRow).toHaveBeenCalledTimes(2);
    expect(result.data.map(row => row.draft_uid)).toEqual([2, 1]);
    expect(result.total).toBe(2);
  });

  it('returns a full shaped draft without leaking storage-only fields', async () => {
    getDraftRow.mockResolvedValue({
      uid: 7,
      folder: 'Drafts',
      subject: 'Draft subject',
      to_addresses: [{ name: '', email: 'to@example.com' }],
      cc_addresses: [],
      bcc_addresses: [],
      body_text: 'Hello',
      body_html: '<p>Hello</p>',
      in_reply_to: '<parent@example.com>',
      thread_references: '<root@example.com> <parent@example.com>',
      attachments: [{ filename: 'note.txt', size: 5, part: '2' }],
      account_id: 'account-1',
      auth_pass: 'must-not-leak',
    });

    const result = payload(await handleGetDraft({
      account: 'sender@example.com',
      draft_uid: 7,
    }, scope, deps()));

    expect(result).toEqual({
      draft_uid: 7,
      folder: 'Drafts',
      subject: 'Draft subject',
      to: [{ name: '', email: 'to@example.com' }],
      cc: [],
      bcc: [],
      body_text: 'Hello',
      body_html: '<p>Hello</p>',
      in_reply_to: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
      attachments: [{ filename: 'note.txt', size: 5, part: '2' }],
    });
  });
});

describe('delete_draft and missing dependencies', () => {
  it('permanently deletes a scoped draft and returns its identifier', async () => {
    const service = deps();
    getDraftRow.mockResolvedValue({ uid: 7, folder: 'Drafts' });

    const result = payload(await handleDeleteDraft({
      account: 'sender@example.com',
      draft_uid: 7,
    }, scope, service));

    expect(service.draftService.deleteDraft).toHaveBeenCalledWith({
      account,
      uid: 7,
      folder: 'Drafts',
    }, service);
    expect(result).toEqual({ deleted: true, draft_uid: 7, folder: 'Drafts' });
  });

  it.each([
    ['create', handleCreateDraft, { account: 'sender@example.com' }],
    ['update', handleUpdateDraft, { account: 'sender@example.com', draft_uid: 1 }],
    ['list', handleListDrafts, { account: 'sender@example.com' }],
    ['get', handleGetDraft, { account: 'sender@example.com', draft_uid: 1 }],
    ['delete', handleDeleteDraft, { account: 'sender@example.com', draft_uid: 1 }],
  ])('%s degrades to unsupported when draftService is absent', async (_name, handler, args) => {
    const result = await handler(args, scope, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^unsupported: /);
  });
});
