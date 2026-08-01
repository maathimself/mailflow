import { createHash } from 'node:crypto';
import * as defaultAccountAdapter from './accountAdapter.js';
import { errorResult, jsonResult } from './result.js';
import { writeError } from './writeResult.js';
import { resolveFromIdentity as defaultResolveFromIdentity } from '../services/mail/identity.js';
import { buildReferences as defaultBuildReferences } from '../services/replyService.js';

const annotations = (readOnlyHint, destructiveHint, idempotentHint) => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint: false,
});

const slotSchema = { type: 'integer', minimum: 1, maximum: 9 };
const expectedRevisionSchema = { type: 'integer', minimum: 1 };

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

const sessionMutationProperties = {
  slot: slotSchema,
  expected_revision: expectedRevisionSchema,
};

export function sessionRef(args) {
  const slot = Number(args.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
    throw Object.assign(new Error('slot must be an integer from 1 to 9'), {
      code: 'invalid_slot', status: 400, expose: true,
    });
  }
  return { slot };
}

export const listComposeSessionsDef = {
  name: 'list_compose_sessions',
  description: 'List the current user\'s live compose sessions and available slots.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: annotations(true, false, true),
};

export const getComposeSessionDef = {
  name: 'get_compose_session',
  description: 'Get a complete live compose session by its user-facing slot.',
  inputSchema: {
    type: 'object',
    required: ['slot'],
    properties: { slot: slotSchema },
  },
  annotations: annotations(true, false, true),
};

export const createComposeSessionDef = {
  name: 'create_compose_session',
  description: 'Create a live compose session in a requested or lowest available slot.',
  inputSchema: {
    type: 'object',
    properties: {
      slot: slotSchema,
      account: { type: 'string' },
      ...editableProperties,
      reply_to_message_id: { type: 'string' },
    },
  },
  annotations: annotations(false, false, false),
};

export const updateComposeSessionDef = {
  name: 'update_compose_session',
  description: 'Update explicitly provided fields on a live compose session.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision'],
    properties: {
      ...sessionMutationProperties,
      ...editableProperties,
      reply_to_message_id: { type: 'string' },
    },
  },
  annotations: annotations(false, false, true),
};

export const minimizeComposeSessionDef = {
  name: 'minimize_compose_session',
  description: 'Minimize a live compose session.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision'],
    properties: sessionMutationProperties,
  },
  annotations: annotations(false, false, true),
};

export const restoreComposeSessionDef = {
  name: 'restore_compose_session',
  description: 'Restore a minimized live compose session.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision'],
    properties: sessionMutationProperties,
  },
  annotations: annotations(false, false, true),
};

export const addComposeAttachmentDef = {
  name: 'add_compose_attachment',
  description: 'Add a base64-encoded attachment to a live compose session.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision', 'filename', 'content'],
    properties: {
      ...sessionMutationProperties,
      filename: { type: 'string' },
      content: { type: 'string', description: 'base64' },
      content_type: { type: 'string' },
    },
  },
  annotations: annotations(false, false, true),
};

export const removeComposeAttachmentDef = {
  name: 'remove_compose_attachment',
  description: 'Remove an attachment from a live compose session.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision', 'attachment_id'],
    properties: {
      ...sessionMutationProperties,
      attachment_id: { type: 'string' },
    },
  },
  annotations: annotations(false, true, true),
};

export const closeComposeSessionDef = {
  name: 'close_compose_session',
  description: 'Safely close a compose session, saving meaningful content as an IMAP draft.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision'],
    properties: {
      ...sessionMutationProperties,
      ...editableProperties,
      reply_to_message_id: { type: 'string' },
    },
  },
  annotations: annotations(false, false, true),
};

export const discardComposeSessionDef = {
  name: 'discard_compose_session',
  description: 'Permanently discard a live compose session and free its slot.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision'],
    properties: sessionMutationProperties,
  },
  annotations: annotations(false, true, true),
};

export const sendComposeSessionDef = {
  name: 'send_compose_session',
  description: 'Send a live compose session and free its slot after enqueue or delivery succeeds.',
  inputSchema: {
    type: 'object',
    required: ['slot', 'expected_revision'],
    properties: {
      ...sessionMutationProperties,
      undo_send_seconds: { type: 'integer', minimum: 0, maximum: 120 },
      idempotency_key: { type: 'string' },
    },
  },
  annotations: annotations(false, true, false),
};

const EDITABLE_FIELDS = ['to', 'cc', 'bcc', 'subject', 'priority'];
const ALL_SLOTS = Array.from({ length: 9 }, (_value, index) => index + 1);
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function unsupported() {
  return writeError('unsupported', 'compose session tools require composeSessionService');
}

function unsupportedLifecycle() {
  return writeError('unsupported', 'compose session tools require composeSessionLifecycle');
}

function clientId(scope) {
  return `mcp:${scope.tokenId ?? scope.mcpTokenId ?? scope.userId}`;
}

function sessionResult(session) {
  return jsonResult({
    session_id: session.id,
    slot: session.slot,
    revision: session.revision,
    state: session.presentationState,
    session,
  });
}

function presentationResult(session) {
  return jsonResult({
    session_id: session.id,
    slot: session.slot,
    revision: session.revision,
    state: session.presentationState,
  });
}

function attachmentMetadata(attachment) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    byteCount: attachment.byteCount,
    createdAt: attachment.createdAt,
  };
}

function attachmentInputError(message) {
  throw Object.assign(new Error(message), {
    code: 'invalid_arguments', status: 400, expose: true,
  });
}

function decodeAttachmentContent(content) {
  if (typeof content !== 'string') {
    attachmentInputError('content must be canonical base64');
  }
  if (content === '') {
    attachmentInputError('attachment content must not be empty');
  }

  const match = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(content);
  if (!match) attachmentInputError('content must be canonical base64');
  const [, unpadded, padding] = match;
  const remainder = unpadded.length % 4;
  const validPadding = (remainder === 0 && padding.length === 0)
    || (remainder === 2 && (padding.length === 0 || padding.length === 2))
    || (remainder === 3 && (padding.length === 0 || padding.length === 1));
  if (!validPadding) attachmentInputError('content must be canonical base64');

  const decodedLength = Math.floor((unpadded.length * 3) / 4);
  if (decodedLength > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error('attachment content must not exceed 25 MiB'), {
      code: 'attachment_too_large', status: 413, expose: true,
    });
  }

  const decoded = Buffer.from(content, 'base64');
  const normalized = decoded.toString('base64').replace(/=+$/, '');
  if (normalized !== unpadded) attachmentInputError('content must be canonical base64');
  if (decoded.length === 0) attachmentInputError('attachment content must not be empty');
  return decoded;
}

function resultForError(error) {
  if (error?.expose === true && error.code === 'compose_conflict') {
    return errorResult(JSON.stringify({
      error: 'compose_conflict',
      message: error.message,
      current_revision: error.details?.currentRevision,
      conflicting_fields: error.details?.conflictingFields,
      remote_values: error.details?.remoteValues,
    }));
  }
  if (error?.expose === true && error.code) return writeError(error.code, error.message);
  throw error;
}

async function asToolResult(callback) {
  try {
    return await callback();
  } catch (error) {
    return resultForError(error);
  }
}

function serviceFor(deps, method) {
  const service = deps?.composeSessionService;
  return typeof service?.[method] === 'function' ? service : null;
}

function lifecycleFor(deps, method) {
  const lifecycle = deps?.composeSessionLifecycle;
  return typeof lifecycle?.[method] === 'function' ? lifecycle : null;
}

function referenceList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.match(/<[^>]+>/g) || [value.trim()];
}

async function threadingChanges(args, scope, deps) {
  if (!hasOwn(args, 'reply_to_message_id')) return {};
  if (args.reply_to_message_id === '') {
    return { inReplyTo: null, references: [] };
  }
  const accountAdapter = deps.accountAdapter || defaultAccountAdapter;
  const source = await accountAdapter.getComposeSource(
    args.reply_to_message_id,
    scope.accountIds,
  );
  if (!source) {
    throw Object.assign(new Error(args.reply_to_message_id), {
      code: 'message_not_found',
      expose: true,
    });
  }
  const buildReferences = deps.buildReferences || defaultBuildReferences;
  const threading = buildReferences(source);
  return {
    inReplyTo: threading.inReplyTo,
    references: referenceList(threading.references),
  };
}

async function editableChanges(args, scope, deps) {
  const changes = {};
  for (const field of EDITABLE_FIELDS) {
    if (hasOwn(args, field)) changes[field] = args[field];
  }
  if (hasOwn(args, 'body_html')) {
    changes.body = args.body_html;
    changes.bodyIsHtml = true;
  } else if (hasOwn(args, 'body')) {
    changes.body = args.body;
    changes.bodyIsHtml = false;
  }
  return { ...changes, ...await threadingChanges(args, scope, deps) };
}

async function aliasChanges(args, scope, deps, ref) {
  if (!hasOwn(args, 'alias')) return {};
  if (args.alias === '') return { aliasId: null };
  const service = serviceFor(deps, 'getComposeSession');
  if (!service) return null;
  const current = await service.getComposeSession({
    userId: scope.userId,
    ...ref,
  }, deps);
  const accountAdapter = deps.accountAdapter || defaultAccountAdapter;
  const account = await accountAdapter.getAccountRow(current.accountId, scope.accountIds);
  if (!account) {
    throw Object.assign(new Error(current.accountId), {
      code: 'account_not_found', expose: true,
    });
  }
  const resolveFromIdentity = deps.resolveFromIdentity || defaultResolveFromIdentity;
  const identity = await resolveFromIdentity(account, { aliasEmail: args.alias }, deps);
  return { aliasId: identity.aliasId };
}

function invalidUndoSeconds() {
  throw Object.assign(
    new Error('undo_send_seconds must be an integer from 0 to 120'),
    { code: 'invalid_compose_undo_seconds', status: 400, expose: true },
  );
}

function deterministicSendKey(args, scope, ref) {
  const context = JSON.stringify({
    requestId: scope.requestId ?? scope.mcpRequestId ?? null,
    tokenId: scope.tokenId ?? scope.mcpTokenId ?? null,
    userId: scope.userId,
    slot: ref.slot,
    expectedRevision: args.expected_revision,
  });
  return `mcp-compose:${createHash('sha256').update(context, 'utf8').digest('hex')}`;
}

export async function handleListComposeSessions(_args, scope, deps = {}) {
  const service = serviceFor(deps, 'listComposeSessions');
  if (!service) return unsupported();
  return asToolResult(async () => {
    const sessions = await service.listComposeSessions({ userId: scope.userId }, deps);
    const occupiedSlots = [...new Set(sessions.map(item => item.slot))].sort((a, b) => a - b);
    const occupied = new Set(occupiedSlots);
    return jsonResult({
      sessions,
      occupied_slots: occupiedSlots,
      available_slots: ALL_SLOTS.filter(slot => !occupied.has(slot)),
    });
  });
}

export async function handleGetComposeSession(args, scope, deps = {}) {
  const service = serviceFor(deps, 'getComposeSession');
  if (!service) return unsupported();
  return asToolResult(async () => {
    const session = await service.getComposeSession({
      userId: scope.userId,
      ...sessionRef(args),
    }, deps);
    return sessionResult(session);
  });
}

export async function handleCreateComposeSession(args, scope, deps = {}) {
  const service = serviceFor(deps, 'createComposeSession');
  if (!service) return unsupported();
  return asToolResult(async () => {
    const requestedSlot = hasOwn(args, 'slot') ? sessionRef(args).slot : undefined;
    let account;
    if (hasOwn(args, 'account')) {
      const accountAdapter = deps.accountAdapter || defaultAccountAdapter;
      account = await accountAdapter.getAccountByEmail(args.account, scope.accountIds);
      if (account?.error) return errorResult(account.error);
    }
    let aliasId;
    if (hasOwn(args, 'alias')) {
      if (args.alias === '') {
        aliasId = null;
      } else {
        if (!account) {
          return writeError('invalid_arguments', 'alias requires account');
        }
        const resolveFromIdentity = deps.resolveFromIdentity || defaultResolveFromIdentity;
        const identity = await resolveFromIdentity(account, { aliasEmail: args.alias }, deps);
        aliasId = identity.aliasId;
      }
    }
    const changes = await editableChanges(args, scope, deps);
    if (account) changes.accountId = account.id;
    if (hasOwn(args, 'alias')) changes.aliasId = aliasId;
    const input = {
      userId: scope.userId,
      changes,
      clientId: clientId(scope),
    };
    if (requestedSlot !== undefined) input.requestedSlot = requestedSlot;
    const session = await service.createComposeSession(input, deps);
    return sessionResult(session);
  });
}

export async function handleUpdateComposeSession(args, scope, deps = {}) {
  const service = serviceFor(deps, 'patchComposeSession');
  if (!service) return unsupported();
  return asToolResult(async () => {
    const ref = sessionRef(args);
    const changes = await editableChanges(args, scope, deps);
    if (hasOwn(args, 'alias')) {
      if (args.alias === '') {
        changes.aliasId = null;
      } else {
        if (typeof service.getComposeSession !== 'function') return unsupported();
        const current = await service.getComposeSession({
          userId: scope.userId,
          ...ref,
        }, deps);
        const accountAdapter = deps.accountAdapter || defaultAccountAdapter;
        const account = await accountAdapter.getAccountRow(current.accountId, scope.accountIds);
        if (!account) return writeError('account_not_found', current.accountId);
        const resolveFromIdentity = deps.resolveFromIdentity || defaultResolveFromIdentity;
        const identity = await resolveFromIdentity(account, { aliasEmail: args.alias }, deps);
        changes.aliasId = identity.aliasId;
      }
    }
    const session = await service.patchComposeSession({
      userId: scope.userId,
      ...ref,
      expectedRevision: args.expected_revision,
      changes,
      clientId: clientId(scope),
    }, deps);
    return sessionResult(session);
  });
}

async function handlePresentation(args, scope, deps, state) {
  const service = serviceFor(deps, 'setComposePresentation');
  if (!service) return unsupported();
  return asToolResult(async () => {
    const session = await service.setComposePresentation({
      userId: scope.userId,
      ...sessionRef(args),
      expectedRevision: args.expected_revision,
      state,
      clientId: clientId(scope),
    }, deps);
    return presentationResult(session);
  });
}

export async function handleMinimizeComposeSession(args, scope, deps = {}) {
  return handlePresentation(args, scope, deps, 'minimized');
}

export async function handleRestoreComposeSession(args, scope, deps = {}) {
  return handlePresentation(args, scope, deps, 'expanded');
}

export async function handleAddComposeAttachment(args, scope, deps = {}) {
  const service = serviceFor(deps, 'addComposeAttachment');
  if (!service) return unsupported();
  return asToolResult(async () => {
    const ref = sessionRef(args);
    const content = decodeAttachmentContent(args.content);
    const result = await service.addComposeAttachment({
      userId: scope.userId,
      ...ref,
      expectedRevision: args.expected_revision,
      filename: args.filename,
      content,
      contentType: args.content_type,
      clientId: clientId(scope),
    }, deps);
    return jsonResult({
      session_id: result.sessionId,
      slot: result.slot,
      revision: result.revision,
      attachment: attachmentMetadata(result.attachment),
    });
  });
}

export async function handleRemoveComposeAttachment(args, scope, deps = {}) {
  const service = serviceFor(deps, 'removeComposeAttachment');
  if (!service) return unsupported();
  return asToolResult(async () => {
    const result = await service.removeComposeAttachment({
      userId: scope.userId,
      ...sessionRef(args),
      expectedRevision: args.expected_revision,
      attachmentId: args.attachment_id,
      clientId: clientId(scope),
    }, deps);
    return jsonResult({
      session_id: result.sessionId,
      slot: result.slot,
      revision: result.revision,
      removed_attachment_id: result.removedAttachmentId,
    });
  });
}

export async function handleCloseComposeSession(args, scope, deps = {}) {
  const lifecycle = lifecycleFor(deps, 'closeComposeSession');
  if (!lifecycle) return unsupportedLifecycle();
  return asToolResult(async () => {
    const ref = sessionRef(args);
    const changes = await editableChanges(args, scope, deps);
    const alias = await aliasChanges(args, scope, deps, ref);
    if (alias === null) return unsupported();
    Object.assign(changes, alias);
    const result = await lifecycle.closeComposeSession({
      userId: scope.userId,
      ...ref,
      expectedRevision: args.expected_revision,
      changes,
    }, deps);
    return jsonResult({
      closed: result.closed,
      freed_slot: result.slot,
      draft: result.draft ? {
        account: result.draft.account,
        draft_uid: result.draft.uid,
        folder: result.draft.folder,
        message_id: result.draft.messageId,
      } : null,
    });
  });
}

export async function handleDiscardComposeSession(args, scope, deps = {}) {
  const lifecycle = lifecycleFor(deps, 'discardComposeSession');
  if (!lifecycle) return unsupportedLifecycle();
  return asToolResult(async () => {
    const result = await lifecycle.discardComposeSession({
      userId: scope.userId,
      ...sessionRef(args),
      expectedRevision: args.expected_revision,
    }, deps);
    return jsonResult({ discarded: result.discarded, freed_slot: result.slot });
  });
}

export async function handleSendComposeSession(args, scope, deps = {}) {
  const lifecycle = lifecycleFor(deps, 'sendComposeSession');
  if (!lifecycle) return unsupportedLifecycle();
  return asToolResult(async () => {
    const ref = sessionRef(args);
    if (hasOwn(args, 'undo_send_seconds') && (
      !Number.isInteger(args.undo_send_seconds)
      || args.undo_send_seconds < 0
      || args.undo_send_seconds > 120
    )) invalidUndoSeconds();
    const input = {
      userId: scope.userId,
      ...ref,
      expectedRevision: args.expected_revision,
      idempotencyKey: hasOwn(args, 'idempotency_key')
        ? args.idempotency_key
        : deterministicSendKey(args, scope, ref),
    };
    if (hasOwn(args, 'undo_send_seconds')) input.undoSendSeconds = args.undo_send_seconds;
    const result = await lifecycle.sendComposeSession(input, deps);
    if (result.queued === true) {
      return jsonResult({
        queued: true,
        freed_slot: ref.slot,
        outbox_id: result.outboxId,
        send_at: result.sendAt,
        undo_seconds: result.undoSeconds,
      });
    }
    return jsonResult({
      sent: true,
      freed_slot: ref.slot,
      message_id: result.messageId,
      sent_copy_saved: result.sentCopySaved,
      receipt: result.receipt,
    });
  });
}
