import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addComposeAttachmentDef,
  closeComposeSessionDef,
  createComposeSessionDef,
  discardComposeSessionDef,
  getComposeSessionDef,
  handleCloseComposeSession,
  handleCreateComposeSession,
  handleDiscardComposeSession,
  handleGetComposeSession,
  handleAddComposeAttachment,
  handleListComposeSessions,
  handleMinimizeComposeSession,
  handleRemoveComposeAttachment,
  handleRestoreComposeSession,
  handleSendComposeSession,
  handleUpdateComposeSession,
  listComposeSessionsDef,
  minimizeComposeSessionDef,
  removeComposeAttachmentDef,
  restoreComposeSessionDef,
  sendComposeSessionDef,
  updateComposeSessionDef,
} from './composeSessionTools.js';

const definitions = [
  listComposeSessionsDef,
  getComposeSessionDef,
  createComposeSessionDef,
  updateComposeSessionDef,
  minimizeComposeSessionDef,
  restoreComposeSessionDef,
  addComposeAttachmentDef,
  removeComposeAttachmentDef,
  closeComposeSessionDef,
  discardComposeSessionDef,
  sendComposeSessionDef,
];

const slotSchema = { type: 'integer', minimum: 1, maximum: 9 };
const revisionSchema = { type: 'integer', minimum: 1 };
const replyToMessageIdSchema = { type: 'string' };
const editableProperties = {
  to: { type: 'array', items: { type: 'string' } },
  cc: { type: 'array', items: { type: 'string' } },
  bcc: { type: 'array', items: { type: 'string' } },
  subject: { type: 'string' },
  body: { type: 'string' },
  body_html: { type: 'string' },
  alias: { type: 'string' },
  priority: { type: 'string', enum: ['high', 'normal', 'low'] },
};

describe('compose-session tool definitions', () => {
  it('publishes the exact definition inventory in approved order', () => {
    expect(definitions.map(definition => definition.name)).toEqual([
      'list_compose_sessions',
      'get_compose_session',
      'create_compose_session',
      'update_compose_session',
      'minimize_compose_session',
      'restore_compose_session',
      'add_compose_attachment',
      'remove_compose_attachment',
      'close_compose_session',
      'discard_compose_session',
      'send_compose_session',
    ]);
  });

  it('uses scope-neutral annotations with destructive operations identified', () => {
    expect(definitions.map(definition => [definition.name, definition.annotations])).toEqual([
      ['list_compose_sessions', annotations(true, false, true)],
      ['get_compose_session', annotations(true, false, true)],
      ['create_compose_session', annotations(false, false, false)],
      ['update_compose_session', annotations(false, false, true)],
      ['minimize_compose_session', annotations(false, false, true)],
      ['restore_compose_session', annotations(false, false, true)],
      ['add_compose_attachment', annotations(false, false, true)],
      ['remove_compose_attachment', annotations(false, true, true)],
      ['close_compose_session', annotations(false, false, true)],
      ['discard_compose_session', annotations(false, true, true)],
      ['send_compose_session', annotations(false, true, false)],
    ]);
  });

  it('defines the exact list, get, create, and update input schemas', () => {
    expect(listComposeSessionsDef.inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
    expect(getComposeSessionDef.inputSchema).toEqual({
      type: 'object',
      required: ['slot'],
      properties: { slot: slotSchema },
    });
    expect(createComposeSessionDef.inputSchema).toEqual({
      type: 'object',
      properties: {
        slot: slotSchema,
        account: { type: 'string' },
        ...editableProperties,
        reply_to_message_id: replyToMessageIdSchema,
      },
    });
    expect(updateComposeSessionDef.inputSchema).toEqual({
      type: 'object',
      required: ['slot', 'expected_revision'],
      properties: {
        slot: slotSchema,
        expected_revision: revisionSchema,
        ...editableProperties,
        reply_to_message_id: replyToMessageIdSchema,
      },
    });
  });

  it('defines revision-guarded presentation schemas', () => {
    const expected = {
      type: 'object',
      required: ['slot', 'expected_revision'],
      properties: {
        slot: slotSchema,
        expected_revision: revisionSchema,
      },
    };
    expect(minimizeComposeSessionDef.inputSchema).toEqual(expected);
    expect(restoreComposeSessionDef.inputSchema).toEqual(expected);
  });

  it('defines the exact attachment schemas', () => {
    expect(addComposeAttachmentDef.inputSchema).toEqual({
      type: 'object',
      required: ['slot', 'expected_revision', 'filename', 'content'],
      properties: {
        slot: slotSchema,
        expected_revision: revisionSchema,
        filename: { type: 'string' },
        content: { type: 'string', description: 'base64' },
        content_type: { type: 'string' },
      },
    });
    expect(removeComposeAttachmentDef.inputSchema).toEqual({
      type: 'object',
      required: ['slot', 'expected_revision', 'attachment_id'],
      properties: {
        slot: slotSchema,
        expected_revision: revisionSchema,
        attachment_id: { type: 'string' },
      },
    });
  });

  it('defines the exact close, discard, and send schemas', () => {
    expect(closeComposeSessionDef.inputSchema).toEqual({
      type: 'object',
      required: ['slot', 'expected_revision'],
      properties: {
        slot: slotSchema,
        expected_revision: revisionSchema,
        ...editableProperties,
        reply_to_message_id: replyToMessageIdSchema,
      },
    });
    expect(discardComposeSessionDef.inputSchema).toEqual({
      type: 'object',
      required: ['slot', 'expected_revision'],
      properties: {
        slot: slotSchema,
        expected_revision: revisionSchema,
      },
    });
    expect(sendComposeSessionDef.inputSchema).toEqual({
      type: 'object',
      required: ['slot', 'expected_revision'],
      properties: {
        slot: slotSchema,
        expected_revision: revisionSchema,
        undo_send_seconds: { type: 'integer', minimum: 0, maximum: 120 },
        idempotency_key: { type: 'string' },
      },
    });
  });

  it('keeps every definition plain JSON-serializable data', () => {
    expect(JSON.parse(JSON.stringify(definitions))).toEqual(definitions);
  });
});

function annotations(readOnlyHint, destructiveHint, idempotentHint) {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false };
}

const scope = {
  userId: 'user-1',
  accountIds: ['account-1'],
  scopes: ['read', 'write'],
};

const account = {
  id: 'account-1',
  email_address: 'sender@example.com',
  sender_name: 'Sender',
};

const identity = {
  fromName: 'Team',
  fromEmail: 'team@example.com',
  fromReplyTo: null,
  signature: null,
  aliasId: 'alias-1',
};

const session = {
  id: '11111111-1111-4111-8111-111111111111',
  slot: 2,
  revision: 7,
  presentationState: 'expanded',
  subject: 'Subject',
};

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function dependencies(overrides = {}) {
  const composeSessionService = {
    listComposeSessions: vi.fn().mockResolvedValue([]),
    getComposeSession: vi.fn().mockResolvedValue(session),
    createComposeSession: vi.fn().mockResolvedValue(session),
    patchComposeSession: vi.fn().mockResolvedValue(session),
    setComposePresentation: vi.fn().mockResolvedValue(session),
    addComposeAttachment: vi.fn().mockResolvedValue({
      sessionId: session.id,
      slot: session.slot,
      revision: session.revision + 1,
      attachment: {
        id: '22222222-2222-4222-8222-222222222222',
        filename: 'note.txt',
        contentType: 'text/plain',
        byteCount: 5,
        createdAt: '2026-08-01T00:00:00.000Z',
        content: Buffer.from('synthetic attachment bytes'),
      },
    }),
    removeComposeAttachment: vi.fn().mockResolvedValue({
      sessionId: session.id,
      slot: session.slot,
      revision: session.revision + 1,
      removedAttachmentId: '22222222-2222-4222-8222-222222222222',
    }),
  };
  const accountAdapter = {
    getAccountByEmail: vi.fn().mockResolvedValue(account),
    getAccountRow: vi.fn().mockResolvedValue(account),
    getComposeSource: vi.fn().mockResolvedValue({
      id: 'message-1',
      message_id: '<original@example.com>',
      thread_references: '<root@example.com>',
    }),
  };
  const composeSessionLifecycle = {
    closeComposeSession: vi.fn().mockResolvedValue({
      closed: true,
      slot: session.slot,
      draft: null,
    }),
    discardComposeSession: vi.fn().mockResolvedValue({
      discarded: true,
      slot: session.slot,
    }),
    sendComposeSession: vi.fn().mockResolvedValue({
      ok: true,
      messageId: '<sent@example.com>',
      sentCopySaved: true,
      receipt: {
        from: { name: 'Sender', email: 'sender@example.com' },
        to: [{ name: '', email: 'recipient@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Synthetic subject',
        attachments: [],
        messageId: '<sent@example.com>',
        sentCopySaved: true,
        folder: 'Sent',
      },
    }),
  };
  return {
    composeSessionService,
    composeSessionLifecycle,
    accountAdapter,
    resolveFromIdentity: vi.fn().mockResolvedValue(identity),
    buildReferences: vi.fn().mockReturnValue({
      inReplyTo: '<original@example.com>',
      references: '<root@example.com> <original@example.com>',
    }),
    draftService: {
      saveDraft: vi.fn(),
      deleteDraft: vi.fn(),
    },
    sendService: { sendOrEnqueue: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('compose-session read handlers', () => {
  it('lists summary sessions with occupied and available slots', async () => {
    const deps = dependencies();
    const summaries = [
      { ...session, slot: 2 },
      { ...session, id: '77777777-7777-4777-8777-777777777777', slot: 7 },
    ];
    deps.composeSessionService.listComposeSessions.mockResolvedValue(summaries);

    const result = payload(await handleListComposeSessions({}, scope, deps));

    expect(deps.composeSessionService.listComposeSessions).toHaveBeenCalledWith(
      { userId: 'user-1' },
      deps,
    );
    expect(result).toEqual({
      sessions: summaries,
      occupied_slots: [2, 7],
      available_slots: [1, 3, 4, 5, 6, 8, 9],
    });
  });

  it('gets a complete session by slot and returns the stable envelope', async () => {
    const deps = dependencies();

    const result = payload(await handleGetComposeSession({ slot: 2 }, scope, deps));

    expect(deps.composeSessionService.getComposeSession).toHaveBeenCalledWith(
      { userId: 'user-1', slot: 2 },
      deps,
    );
    expect(result).toEqual({
      session_id: session.id,
      slot: 2,
      revision: 7,
      state: 'expanded',
      session,
    });
  });

  it.each([0, 10, 2.5])('rejects invalid read slot %s before the service call', async (slot) => {
    const deps = dependencies();

    const result = await handleGetComposeSession({ slot }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'invalid_slot: slot must be an integer from 1 to 9',
    );
    expect(deps.composeSessionService.getComposeSession).not.toHaveBeenCalled();
  });

  it('returns a stable unsupported read error when the service dependency is missing', async () => {
    const result = await handleListComposeSessions({}, scope, {});

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'unsupported: compose session tools require composeSessionService',
    );
  });
});

describe('compose-session create handlers', () => {
  it('creates in the lowest free slot with no invented changes', async () => {
    const deps = dependencies();

    const result = payload(await handleCreateComposeSession({}, scope, deps));

    expect(deps.composeSessionService.createComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      changes: {},
      clientId: 'mcp:user-1',
    }, deps);
    expect(result).toEqual({
      session_id: session.id,
      slot: 2,
      revision: 7,
      state: 'expanded',
      session,
    });
  });

  it('creates in a requested slot and resolves account, alias, HTML body, and reply source', async () => {
    const deps = dependencies();

    await handleCreateComposeSession({
      slot: 4,
      account: 'sender@example.com',
      alias: 'team@example.com',
      to: ['recipient@example.com'],
      cc: [],
      bcc: [],
      subject: 'Threaded subject',
      body: 'plain fallback',
      body_html: '<p>HTML body</p>',
      priority: 'high',
      reply_to_message_id: 'message-1',
    }, { ...scope, tokenId: 'token-1' }, deps);

    expect(deps.accountAdapter.getAccountByEmail).toHaveBeenCalledWith(
      'sender@example.com',
      ['account-1'],
    );
    expect(deps.resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasEmail: 'team@example.com' },
      deps,
    );
    expect(deps.accountAdapter.getComposeSource).toHaveBeenCalledWith(
      'message-1',
      ['account-1'],
    );
    expect(deps.buildReferences).toHaveBeenCalledWith(expect.objectContaining({
      id: 'message-1',
    }));
    expect(deps.composeSessionService.createComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      requestedSlot: 4,
      changes: {
        accountId: 'account-1',
        aliasId: 'alias-1',
        to: ['recipient@example.com'],
        cc: [],
        bcc: [],
        subject: 'Threaded subject',
        body: '<p>HTML body</p>',
        bodyIsHtml: true,
        priority: 'high',
        inReplyTo: '<original@example.com>',
        references: ['<root@example.com>', '<original@example.com>'],
      },
      clientId: 'mcp:token-1',
    }, deps);
  });

  it('maps an explicitly empty plain body as a clear without inventing other fields', async () => {
    const deps = dependencies();

    await handleCreateComposeSession({ body: '' }, scope, deps);

    expect(deps.composeSessionService.createComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      changes: { body: '', bodyIsHtml: false },
      clientId: 'mcp:user-1',
    }, deps);
  });

  it('rejects an unknown scoped account without calling identity or session services', async () => {
    const deps = dependencies();
    deps.accountAdapter.getAccountByEmail.mockResolvedValue({
      error: 'account_not_found: missing@example.com',
    });

    const result = await handleCreateComposeSession({
      account: 'missing@example.com',
      alias: 'team@example.com',
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe('account_not_found: missing@example.com');
    expect(deps.resolveFromIdentity).not.toHaveBeenCalled();
    expect(deps.composeSessionService.createComposeSession).not.toHaveBeenCalled();
  });

  it('rejects an out-of-scope reply source before creating', async () => {
    const deps = dependencies();
    deps.accountAdapter.getComposeSource.mockResolvedValue(null);

    const result = await handleCreateComposeSession({
      reply_to_message_id: 'missing-message',
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe('message_not_found: missing-message');
    expect(deps.composeSessionService.createComposeSession).not.toHaveBeenCalled();
  });

  it('hard-fails an unknown alias through the shared identity path', async () => {
    const deps = dependencies();
    deps.resolveFromIdentity.mockRejectedValue(Object.assign(
      new Error('Alias not found'),
      { code: 'alias_not_found', expose: true },
    ));

    const result = await handleCreateComposeSession({
      account: 'sender@example.com',
      alias: 'unknown@example.com',
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe('alias_not_found: Alias not found');
    expect(deps.composeSessionService.createComposeSession).not.toHaveBeenCalled();
  });
});

describe('compose-session update handlers', () => {
  it('updates only explicitly present fields, including empty list and plain-body clears', async () => {
    const deps = dependencies();

    await handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      subject: '',
      to: [],
      cc: [],
      bcc: [],
      body: '',
      priority: 'low',
    }, scope, deps);

    expect(deps.composeSessionService.patchComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 2,
      expectedRevision: 7,
      changes: {
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        body: '',
        bodyIsHtml: false,
        priority: 'low',
      },
      clientId: 'mcp:user-1',
    }, deps);
  });

  it('maps HTML and reply updates without preserving an omitted plain body', async () => {
    const deps = dependencies();

    await handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      body_html: '',
      reply_to_message_id: 'message-1',
    }, scope, deps);

    expect(deps.composeSessionService.patchComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 2,
      expectedRevision: 7,
      changes: {
        body: '',
        bodyIsHtml: true,
        inReplyTo: '<original@example.com>',
        references: ['<root@example.com>', '<original@example.com>'],
      },
      clientId: 'mcp:user-1',
    }, deps);
  });

  it('resolves an alias against the current scoped session account', async () => {
    const deps = dependencies();
    deps.composeSessionService.getComposeSession.mockResolvedValue({
      ...session,
      accountId: 'account-1',
    });

    await handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      alias: 'team@example.com',
    }, scope, deps);

    expect(deps.composeSessionService.getComposeSession).toHaveBeenCalledWith(
      { userId: 'user-1', slot: 2 },
      deps,
    );
    expect(deps.accountAdapter.getAccountRow).toHaveBeenCalledWith(
      'account-1',
      ['account-1'],
    );
    expect(deps.resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasEmail: 'team@example.com' },
      deps,
    );
    expect(deps.composeSessionService.patchComposeSession).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { aliasId: 'alias-1' } }),
      deps,
    );
  });

  it('clears an alias explicitly without requiring an account lookup', async () => {
    const deps = dependencies();

    await handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      alias: '',
    }, scope, deps);

    expect(deps.composeSessionService.getComposeSession).not.toHaveBeenCalled();
    expect(deps.accountAdapter.getAccountRow).not.toHaveBeenCalled();
    expect(deps.resolveFromIdentity).not.toHaveBeenCalled();
    expect(deps.composeSessionService.patchComposeSession).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { aliasId: null } }),
      deps,
    );
  });

  it('clears reply threading explicitly without resolving a source', async () => {
    const deps = dependencies();

    await handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      reply_to_message_id: '',
    }, scope, deps);

    expect(deps.accountAdapter.getComposeSource).not.toHaveBeenCalled();
    expect(deps.buildReferences).not.toHaveBeenCalled();
    expect(deps.composeSessionService.patchComposeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: { inReplyTo: null, references: [] },
      }),
      deps,
    );
  });

  it('returns ordinary exposed update errors through writeError', async () => {
    const deps = dependencies();
    deps.composeSessionService.patchComposeSession.mockRejectedValue(Object.assign(
      new Error('Compose session not found'),
      { code: 'compose_session_not_found', expose: true },
    ));

    const result = await handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      subject: 'Updated',
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'compose_session_not_found: Compose session not found',
    );
  });

  it('returns compose conflicts as structured snake-case JSON', async () => {
    const deps = dependencies();
    deps.composeSessionService.patchComposeSession.mockRejectedValue(Object.assign(
      new Error('Compose session changed in the requested fields'),
      {
        code: 'compose_conflict',
        expose: true,
        details: {
          currentRevision: 8,
          conflictingFields: ['subject'],
          remoteValues: { subject: 'Remote subject' },
        },
      },
    ));

    const result = await handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      subject: 'Local subject',
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(payload(result)).toEqual({
      error: 'compose_conflict',
      message: 'Compose session changed in the requested fields',
      current_revision: 8,
      conflicting_fields: ['subject'],
      remote_values: { subject: 'Remote subject' },
    });
  });

  it('rethrows an unexposed coded compose conflict for the MCP internal-error boundary', async () => {
    const deps = dependencies();
    deps.composeSessionService.patchComposeSession.mockRejectedValue(Object.assign(
      new Error('internal conflict detail'),
      {
        code: 'compose_conflict',
        expose: false,
        details: {
          currentRevision: 8,
          conflictingFields: ['subject'],
          remoteValues: { subject: 'Remote subject' },
        },
      },
    ));

    await expect(handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      subject: 'Local subject',
    }, scope, deps)).rejects.toThrow('internal conflict detail');
  });

  it('rethrows an unexposed ordinary coded failure for the MCP internal-error boundary', async () => {
    const deps = dependencies();
    deps.composeSessionService.patchComposeSession.mockRejectedValue(Object.assign(
      new Error('duplicate key value exposes internals'),
      { code: '23505' },
    ));

    await expect(handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      subject: 'Updated',
    }, scope, deps)).rejects.toThrow('duplicate key value exposes internals');
  });

  it('rethrows unknown update failures for the MCP internal-error boundary', async () => {
    const deps = dependencies();
    deps.composeSessionService.patchComposeSession.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(handleUpdateComposeSession({
      slot: 2,
      expected_revision: 7,
      subject: 'Updated',
    }, scope, deps)).rejects.toThrow('database unavailable');
  });
});

describe('compose-session presentation handlers', () => {
  it('minimizes and restores with exact revision guards and a stable token client id', async () => {
    const deps = dependencies();
    deps.composeSessionService.setComposePresentation
      .mockResolvedValueOnce({ ...session, revision: 8, presentationState: 'minimized' })
      .mockResolvedValueOnce({ ...session, revision: 9, presentationState: 'expanded' });
    const tokenScope = { ...scope, tokenId: 'token-1' };

    const minimized = payload(await handleMinimizeComposeSession({
      slot: 2,
      expected_revision: 7,
    }, tokenScope, deps));
    const restored = payload(await handleRestoreComposeSession({
      slot: 2,
      expected_revision: 8,
    }, tokenScope, deps));

    expect(deps.composeSessionService.setComposePresentation.mock.calls).toEqual([
      [{
        userId: 'user-1',
        slot: 2,
        expectedRevision: 7,
        state: 'minimized',
        clientId: 'mcp:token-1',
      }, deps],
      [{
        userId: 'user-1',
        slot: 2,
        expectedRevision: 8,
        state: 'expanded',
        clientId: 'mcp:token-1',
      }, deps],
    ]);
    expect(minimized).toEqual({
      session_id: session.id,
      slot: 2,
      revision: 8,
      state: 'minimized',
    });
    expect(restored).toEqual({
      session_id: session.id,
      slot: 2,
      revision: 9,
      state: 'expanded',
    });
  });
});

describe('compose-session attachment handlers', () => {
  const attachmentId = '22222222-2222-4222-8222-222222222222';

  it('keeps attachment removal explicitly destructive', () => {
    expect(removeComposeAttachmentDef.annotations).toEqual(
      annotations(false, true, true),
    );
  });

  it('decodes canonical base64 into a Buffer and forwards exact attachment scope', async () => {
    const deps = dependencies();
    const result = payload(await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: 'note.txt',
      content: Buffer.from('hello').toString('base64'),
      content_type: 'text/plain',
    }, { ...scope, tokenId: 'token-1' }, deps));

    expect(deps.composeSessionService.addComposeAttachment).toHaveBeenCalledTimes(1);
    const [input, serviceDeps] = deps.composeSessionService.addComposeAttachment.mock.calls[0];
    expect(serviceDeps).toBe(deps);
    expect(input).toEqual({
      userId: 'user-1',
      slot: 2,
      expectedRevision: 7,
      filename: 'note.txt',
      content: expect.any(Buffer),
      contentType: 'text/plain',
      clientId: 'mcp:token-1',
    });
    expect(Buffer.isBuffer(input.content)).toBe(true);
    expect(input.content.equals(Buffer.from('hello'))).toBe(true);
    expect(result).toEqual({
      session_id: session.id,
      slot: 2,
      revision: 8,
      attachment: {
        id: attachmentId,
        filename: 'note.txt',
        contentType: 'text/plain',
        byteCount: 5,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    });
    expect(JSON.stringify(result)).not.toContain('hello');
  });

  it('accepts a canonical unpadded encoding and lets the service apply its content-type default', async () => {
    const deps = dependencies();
    deps.composeSessionService.addComposeAttachment.mockResolvedValue({
      sessionId: session.id,
      slot: 2,
      revision: 8,
      attachment: {
        id: attachmentId,
        filename: 'one-byte.bin',
        contentType: 'application/octet-stream',
        byteCount: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    });

    const result = payload(await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: 'one-byte.bin',
      content: 'YQ',
    }, scope, deps));

    expect(deps.composeSessionService.addComposeAttachment).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 2,
      expectedRevision: 7,
      filename: 'one-byte.bin',
      content: Buffer.from('a'),
      contentType: undefined,
      clientId: 'mcp:user-1',
    }, deps);
    expect(result.attachment.contentType).toBe('application/octet-stream');
  });

  it.each([
    ['invalid alphabet', 'YWJj*'],
    ['URL-safe alphabet', '-_8='],
    ['embedded whitespace', 'Y WJj'],
    ['missing required padding characters', 'YQ='],
    ['excess padding', 'YQ==='],
    ['padding on an unpadded quantum', 'YWJj='],
    ['misplaced padding', '=YQ='],
    ['impossible encoded length', 'A'],
    ['non-canonical pad bits', 'YR=='],
  ])('rejects malformed attachment base64 with %s before service', async (_case, content) => {
    const deps = dependencies();

    const result = await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: 'bad.bin',
      content,
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'invalid_arguments: content must be canonical base64',
    );
    expect(deps.composeSessionService.addComposeAttachment).not.toHaveBeenCalled();
  });

  it('rejects an empty decoded attachment before service', async () => {
    const deps = dependencies();

    const result = await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: 'empty.bin',
      content: '',
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'invalid_arguments: attachment content must not be empty',
    );
    expect(deps.composeSessionService.addComposeAttachment).not.toHaveBeenCalled();
  });

  it('allows exactly 25 MiB and rejects one decoded byte more before service', async () => {
    const deps = dependencies();
    const maxBytes = 25 * 1024 * 1024;
    const exactContent = Buffer.alloc(maxBytes).toString('base64');

    await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: 'exact.bin',
      content: exactContent,
    }, scope, deps);

    expect(deps.composeSessionService.addComposeAttachment).toHaveBeenCalledTimes(1);
    const exactInput = deps.composeSessionService.addComposeAttachment.mock.calls[0][0];
    expect(Buffer.isBuffer(exactInput.content)).toBe(true);
    expect(exactInput.content.length).toBe(maxBytes);

    deps.composeSessionService.addComposeAttachment.mockClear();
    const tooLargeContent = Buffer.alloc(maxBytes + 1).toString('base64');
    const result = await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: 'too-large.bin',
      content: tooLargeContent,
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'attachment_too_large: attachment content must not exceed 25 MiB',
    );
    expect(deps.composeSessionService.addComposeAttachment).not.toHaveBeenCalled();
  });

  it('removes only the requested attachment from the user-owned slot and revision', async () => {
    const deps = dependencies();
    deps.composeSessionService.removeComposeAttachment.mockResolvedValue({
      sessionId: session.id,
      slot: 7,
      revision: 12,
      removedAttachmentId: attachmentId,
    });

    const result = payload(await handleRemoveComposeAttachment({
      slot: 7,
      expected_revision: 11,
      attachment_id: attachmentId,
    }, { ...scope, mcpTokenId: 'token-2' }, deps));

    expect(deps.composeSessionService.removeComposeAttachment).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 7,
      expectedRevision: 11,
      attachmentId,
      clientId: 'mcp:token-2',
    }, deps);
    expect(result).toEqual({
      session_id: session.id,
      slot: 7,
      revision: 12,
      removed_attachment_id: attachmentId,
    });
  });

  it.each([
    ['add', handleAddComposeAttachment, 'addComposeAttachment', {
      slot: 2,
      expected_revision: 7,
      filename: 'note.txt',
      content: 'aGVsbG8=',
    }],
    ['remove', handleRemoveComposeAttachment, 'removeComposeAttachment', {
      slot: 2,
      expected_revision: 7,
      attachment_id: attachmentId,
    }],
  ])('maps attachment %s revision conflicts through the shared result shape', async (
    _operation,
    handler,
    method,
    args,
  ) => {
    const deps = dependencies();
    deps.composeSessionService[method].mockRejectedValue(Object.assign(
      new Error('Compose session changed in the requested fields'),
      {
        code: 'compose_conflict',
        expose: true,
        details: {
          currentRevision: 8,
          conflictingFields: ['attachments'],
          remoteValues: { attachments: [attachmentId] },
        },
      },
    ));

    const result = await handler(args, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(payload(result)).toEqual({
      error: 'compose_conflict',
      message: 'Compose session changed in the requested fields',
      current_revision: 8,
      conflicting_fields: ['attachments'],
      remote_values: { attachments: [attachmentId] },
    });
  });

  it('maps exposed attachment errors and rethrows unexposed failures', async () => {
    const deps = dependencies();
    deps.composeSessionService.addComposeAttachment.mockRejectedValueOnce(Object.assign(
      new Error('Attachment filename must be a non-empty string'),
      { code: 'invalid_attachment_filename', expose: true },
    ));

    const exposed = await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: '',
      content: 'YQ==',
    }, scope, deps);

    expect(exposed).toMatchObject({ isError: true });
    expect(exposed.content[0].text).toBe(
      'invalid_attachment_filename: Attachment filename must be a non-empty string',
    );

    deps.composeSessionService.removeComposeAttachment.mockRejectedValueOnce(
      Object.assign(new Error('database unavailable'), { code: 'XX000' }),
    );
    await expect(handleRemoveComposeAttachment({
      slot: 2,
      expected_revision: 7,
      attachment_id: attachmentId,
    }, scope, deps)).rejects.toThrow('database unavailable');
  });

  it('validates attachment slots and reports missing injected methods before mutation', async () => {
    const deps = dependencies();

    const invalid = await handleRemoveComposeAttachment({
      slot: 10,
      expected_revision: 7,
      attachment_id: attachmentId,
    }, scope, deps);

    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content[0].text).toBe(
      'invalid_slot: slot must be an integer from 1 to 9',
    );
    expect(deps.composeSessionService.removeComposeAttachment).not.toHaveBeenCalled();

    const unsupportedResult = await handleAddComposeAttachment({
      slot: 2,
      expected_revision: 7,
      filename: 'note.txt',
      content: 'YQ==',
    }, scope, { composeSessionService: {} });
    expect(unsupportedResult).toMatchObject({ isError: true });
    expect(unsupportedResult.content[0].text).toBe(
      'unsupported: compose session tools require composeSessionService',
    );
  });
});

describe('compose-session terminal handlers', () => {
  const immediateReceipt = {
    from: { name: 'Sender', email: 'sender@example.com' },
    to: [{ name: '', email: 'recipient@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Synthetic terminal subject',
    attachments: [{ filename: 'synthetic.txt', size: 9 }],
    messageId: '<terminal-send@example.com>',
    sentCopySaved: true,
    folder: 'Sent',
    sharedReceiptMarker: { preserve: true },
  };

  it('closes through one atomic lifecycle call with every explicit clear and HTML body mode', async () => {
    const deps = dependencies();
    deps.composeSessionLifecycle.closeComposeSession.mockResolvedValue({
      closed: true,
      slot: 4,
      draft: {
        accountId: 'account-1',
        account: 'sender@example.com',
        uid: 91,
        folder: 'Drafts',
        messageId: '<saved-draft@example.com>',
      },
    });

    const result = payload(await handleCloseComposeSession({
      slot: 4,
      expected_revision: 13,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      body: 'ignored because explicit HTML wins',
      body_html: '',
      alias: '',
      priority: 'normal',
      reply_to_message_id: '',
    }, scope, deps));

    expect(deps.composeSessionLifecycle.closeComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 4,
      expectedRevision: 13,
      changes: {
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        body: '',
        bodyIsHtml: true,
        aliasId: null,
        priority: 'normal',
        inReplyTo: null,
        references: [],
      },
    }, deps);
    expect(deps.composeSessionService.patchComposeSession).not.toHaveBeenCalled();
    expect(deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(result).toEqual({
      closed: true,
      freed_slot: 4,
      draft: {
        account: 'sender@example.com',
        draft_uid: 91,
        folder: 'Drafts',
        message_id: '<saved-draft@example.com>',
      },
    });
  });

  it.each([
    ['plain empty body', { body: '' }, { body: '', bodyIsHtml: false }],
    ['HTML empty body', { body_html: '' }, { body: '', bodyIsHtml: true }],
    ['no body field', { subject: 'Only this field' }, { subject: 'Only this field' }],
  ])('preserves close final-patch presence for %s without inventing dirty fields', async (
    _case,
    finalFields,
    expectedChanges,
  ) => {
    const deps = dependencies();

    await handleCloseComposeSession({
      slot: 2,
      expected_revision: 7,
      ...finalFields,
    }, scope, deps);

    expect(deps.composeSessionLifecycle.closeComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 2,
      expectedRevision: 7,
      changes: expectedChanges,
    }, deps);
    expect(deps.composeSessionService.patchComposeSession).not.toHaveBeenCalled();
  });

  it('resolves an explicit reply target and alias against the current owned account before atomic close', async () => {
    const deps = dependencies();
    deps.composeSessionService.getComposeSession.mockResolvedValue({
      ...session,
      accountId: 'account-1',
    });

    await handleCloseComposeSession({
      slot: 2,
      expected_revision: 7,
      alias: 'team@example.com',
      reply_to_message_id: 'message-1',
    }, scope, deps);

    expect(deps.composeSessionService.getComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 2,
    }, deps);
    expect(deps.accountAdapter.getAccountRow).toHaveBeenCalledWith(
      'account-1',
      ['account-1'],
    );
    expect(deps.resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasEmail: 'team@example.com' },
      deps,
    );
    expect(deps.accountAdapter.getComposeSource).toHaveBeenCalledWith(
      'message-1',
      ['account-1'],
    );
    expect(deps.composeSessionLifecycle.closeComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 2,
      expectedRevision: 7,
      changes: {
        aliasId: 'alias-1',
        inReplyTo: '<original@example.com>',
        references: ['<root@example.com>', '<original@example.com>'],
      },
    }, deps);
    expect(deps.composeSessionService.patchComposeSession).not.toHaveBeenCalled();
  });

  it('returns draft null for an empty close without post-terminal account work', async () => {
    const deps = dependencies();
    deps.composeSessionLifecycle.closeComposeSession.mockResolvedValue({
      closed: true,
      slot: 9,
      draft: null,
    });

    const result = payload(await handleCloseComposeSession({
      slot: 9,
      expected_revision: 3,
    }, scope, deps));

    expect(result).toEqual({ closed: true, freed_slot: 9, draft: null });
    expect(deps.accountAdapter.getAccountRow).not.toHaveBeenCalled();
  });

  it('discards with the exact revision and exposes only the freed-slot envelope', async () => {
    const deps = dependencies();
    deps.composeSessionLifecycle.discardComposeSession.mockResolvedValue({
      discarded: true,
      slot: 7,
    });

    const result = payload(await handleDiscardComposeSession({
      slot: 7,
      expected_revision: 11,
    }, scope, deps));

    expect(deps.composeSessionLifecycle.discardComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 7,
      expectedRevision: 11,
    }, deps);
    expect(result).toEqual({ discarded: true, freed_slot: 7 });
  });

  it.each([
    ['close', handleCloseComposeSession, 'closeComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
    ['discard', handleDiscardComposeSession, 'discardComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
    ['send', handleSendComposeSession, 'sendComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
  ])('leaves source-draft preservation and destructive work lifecycle-owned for %s', async (
    _operation,
    handler,
    method,
    args,
  ) => {
    const deps = dependencies();

    await handler(args, scope, deps);

    expect(deps.composeSessionLifecycle[method]).toHaveBeenCalledTimes(1);
    expect(deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(deps.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it('returns an immediate send identity while preserving the shared receipt verbatim', async () => {
    const deps = dependencies();
    deps.composeSessionLifecycle.sendComposeSession.mockResolvedValue({
      ok: true,
      messageId: '<terminal-send@example.com>',
      sentCopySaved: true,
      receipt: immediateReceipt,
    });

    const result = payload(await handleSendComposeSession({
      slot: 6,
      expected_revision: 21,
      undo_send_seconds: 0,
      idempotency_key: 'caller-stable-key',
    }, scope, deps));

    expect(deps.composeSessionLifecycle.sendComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 6,
      expectedRevision: 21,
      undoSendSeconds: 0,
      idempotencyKey: 'caller-stable-key',
    }, deps);
    expect(result).toEqual({
      sent: true,
      freed_slot: 6,
      message_id: '<terminal-send@example.com>',
      sent_copy_saved: true,
      receipt: immediateReceipt,
    });
    expect(result.receipt).toEqual(immediateReceipt);
  });

  it('returns queued outbox identity unchanged and forwards the upper undo boundary', async () => {
    const deps = dependencies();
    deps.composeSessionLifecycle.sendComposeSession.mockResolvedValue({
      queued: true,
      outboxId: '33333333-3333-4333-8333-333333333333',
      sendAt: '2026-08-01T00:02:00.000Z',
      undoSeconds: 120,
    });

    const result = payload(await handleSendComposeSession({
      slot: 8,
      expected_revision: 34,
      undo_send_seconds: 120,
      idempotency_key: 'queued-stable-key',
    }, scope, deps));

    expect(deps.composeSessionLifecycle.sendComposeSession).toHaveBeenCalledWith({
      userId: 'user-1',
      slot: 8,
      expectedRevision: 34,
      undoSendSeconds: 120,
      idempotencyKey: 'queued-stable-key',
    }, deps);
    expect(result).toEqual({
      queued: true,
      freed_slot: 8,
      outbox_id: '33333333-3333-4333-8333-333333333333',
      send_at: '2026-08-01T00:02:00.000Z',
      undo_seconds: 120,
    });
  });

  it('derives a deterministic bounded request key from stable MCP context when omitted', async () => {
    const deps = dependencies();
    const requestScope = {
      ...scope,
      requestId: 'request-1',
      tokenId: 'token-1',
    };
    const args = { slot: 3, expected_revision: 9 };

    await handleSendComposeSession(args, requestScope, deps);
    await handleSendComposeSession(args, requestScope, deps);
    await handleSendComposeSession({ ...args, expected_revision: 10 }, requestScope, deps);

    const keys = deps.composeSessionLifecycle.sendComposeSession.mock.calls
      .map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).toMatch(/^mcp-compose:[a-f0-9]{64}$/);
    expect(keys.every(key => key.length <= 128)).toBe(true);
    expect(JSON.stringify(keys)).not.toContain('request-1');
    expect(JSON.stringify(keys)).not.toContain('token-1');
    expect(JSON.stringify(keys)).not.toContain('user-1');
  });

  it.each([-1, 121, 1.5, '30', null, true])(
    'rejects invalid direct-call undo seconds %j before lifecycle',
    async (undoSendSeconds) => {
      const deps = dependencies();

      const result = await handleSendComposeSession({
        slot: 2,
        expected_revision: 7,
        undo_send_seconds: undoSendSeconds,
      }, scope, deps);

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toBe(
        'invalid_compose_undo_seconds: undo_send_seconds must be an integer from 0 to 120',
      );
      expect(deps.composeSessionLifecycle.sendComposeSession).not.toHaveBeenCalled();
    },
  );

  it('omits undo seconds but still supplies deterministic idempotency to lifecycle', async () => {
    const deps = dependencies();

    await handleSendComposeSession({
      slot: 2,
      expected_revision: 7,
    }, scope, deps);

    expect(deps.composeSessionLifecycle.sendComposeSession.mock.calls[0][0])
      .not.toHaveProperty('undoSendSeconds');
    expect(deps.composeSessionLifecycle.sendComposeSession.mock.calls[0][0].idempotencyKey)
      .toMatch(/^mcp-compose:[a-f0-9]{64}$/);
  });

  it.each([
    ['close', handleCloseComposeSession, 'closeComposeSession', {
      slot: 2,
      expected_revision: 7,
      subject: 'Changed',
    }],
    ['discard', handleDiscardComposeSession, 'discardComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
    ['send', handleSendComposeSession, 'sendComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
  ])('maps terminal %s conflicts through the shared structured shape', async (
    _operation,
    handler,
    method,
    args,
  ) => {
    const deps = dependencies();
    deps.composeSessionLifecycle[method].mockRejectedValue(Object.assign(
      new Error('Compose session changed in the requested fields'),
      {
        code: 'compose_conflict',
        expose: true,
        details: {
          currentRevision: 8,
          conflictingFields: ['subject'],
          remoteValues: { subject: 'Remote synthetic subject' },
        },
      },
    ));

    const result = await handler(args, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(payload(result)).toEqual({
      error: 'compose_conflict',
      message: 'Compose session changed in the requested fields',
      current_revision: 8,
      conflicting_fields: ['subject'],
      remote_values: { subject: 'Remote synthetic subject' },
    });
  });

  it.each([
    ['close', handleCloseComposeSession, 'closeComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
    ['discard', handleDiscardComposeSession, 'discardComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
    ['send', handleSendComposeSession, 'sendComposeSession', {
      slot: 2,
      expected_revision: 7,
    }],
  ])('maps exposed terminal %s errors and rethrows unexposed failures', async (
    _operation,
    handler,
    method,
    args,
  ) => {
    const deps = dependencies();
    deps.composeSessionLifecycle[method]
      .mockRejectedValueOnce(Object.assign(new Error('Synthetic exposed failure'), {
        code: 'compose_operation_in_progress',
        expose: true,
      }))
      .mockRejectedValueOnce(Object.assign(new Error('private database diagnostics'), {
        code: 'XX000',
      }));

    const exposed = await handler(args, scope, deps);
    expect(exposed).toMatchObject({ isError: true });
    expect(exposed.content[0].text).toBe(
      'compose_operation_in_progress: Synthetic exposed failure',
    );
    await expect(handler(args, scope, deps)).rejects.toThrow(
      'private database diagnostics',
    );
  });

  it.each([
    ['close', handleCloseComposeSession, 'closeComposeSession'],
    ['discard', handleDiscardComposeSession, 'discardComposeSession'],
    ['send', handleSendComposeSession, 'sendComposeSession'],
  ])('reports a missing injected lifecycle method for %s without other terminal work', async (
    _operation,
    handler,
    method,
  ) => {
    const deps = dependencies();
    delete deps.composeSessionLifecycle[method];

    const result = await handler({ slot: 2, expected_revision: 7 }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'unsupported: compose session tools require composeSessionLifecycle',
    );
    expect(deps.composeSessionService.patchComposeSession).not.toHaveBeenCalled();
    expect(deps.draftService.saveDraft).not.toHaveBeenCalled();
    expect(deps.draftService.deleteDraft).not.toHaveBeenCalled();
    expect(deps.sendService.sendOrEnqueue).not.toHaveBeenCalled();
  });

  it.each([0, 10, 2.5])('validates terminal slot %s before lifecycle', async (slot) => {
    const deps = dependencies();

    const result = await handleDiscardComposeSession({
      slot,
      expected_revision: 7,
    }, scope, deps);

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      'invalid_slot: slot must be an integer from 1 to 9',
    );
    expect(deps.composeSessionLifecycle.discardComposeSession).not.toHaveBeenCalled();
  });
});
