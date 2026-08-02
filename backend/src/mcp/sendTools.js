import {
  deleteMessageRow,
  getAccountByEmail,
  getAccountRow,
  getComposeSource,
  getDraftRow,
  getOutboxRowByMessageId,
  getUserPreferences,
} from './accountAdapter.js';
import { newPaginatedResponseNoTotal, toRFC3339 } from './envelope.js';
import { errorResult, jsonResult } from './result.js';
import { buildWriteReceipt, writeError } from './writeResult.js';
import { normalizeRecipients } from '../services/mail/addresses.js';
import { resolveFromIdentity } from '../services/mail/identity.js';

const annotations = (readOnlyHint, destructiveHint, idempotentHint) => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint: false,
});

const attachmentSchema = {
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
};

const undoSendSecondsSchema = {
  type: 'integer',
  minimum: 0,
  maximum: 120,
  description: "Cancellation window in seconds (max 120). Defaults to the user's undo-send preference.",
};

const idempotencyKeySchema = {
  type: 'string',
  description: 'Stable key; a retry with the same key returns the original result instead of sending twice.',
};

export const sendEmailDef = {
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
      attachments: attachmentSchema,
      undo_send_seconds: undoSendSecondsSchema,
      idempotency_key: idempotencyKeySchema,
    },
  },
  annotations: annotations(false, true, false),
};

export const sendDraftDef = {
  name: 'send_draft',
  description: 'Reads the draft via `getDraftRow`, reconstructs the compose input (recipients from `to_addresses`/`cc_addresses`, body from `body_text`/`body_html`, threading from `in_reply_to`/`thread_references`), sends, and **deletes the draft only after delivery succeeds** (or after enqueue succeeds, with a `delete_draft_on_send` flag on the outbox payload the worker honors). Errors `draft_not_found` when the uid is absent or not a draft.',
  inputSchema: {
    type: 'object',
    required: ['account', 'draft_uid'],
    properties: {
      account: { type: 'string' },
      draft_uid: { type: 'integer' },
      folder: { type: 'string' },
      undo_send_seconds: undoSendSecondsSchema,
      idempotency_key: idempotencyKeySchema,
    },
  },
  annotations: annotations(false, true, false),
};

export const unsendEmailDef = {
  name: 'unsend_email',
  description: 'Cancel a queued email before it is delivered. Only works while the message is still in its undo window (see the send_at returned by send_email).',
  inputSchema: {
    type: 'object',
    required: ['outbox_id'],
    properties: {
      outbox_id: { type: 'string' },
    },
  },
  annotations: annotations(false, false, true),
};

export const listOutboxDef = {
  name: 'list_outbox',
  description: 'List emails still queued in the undo-send outbox. Entries can be cancelled with unsend_email before send_at.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: annotations(true, false, true),
};

export const recallEmailDef = {
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
  annotations: annotations(false, true, false),
};

function attachmentInput(attachment) {
  return {
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.content_type ?? attachment.contentType,
  };
}

function addressString(address) {
  if (typeof address === 'string') return address;
  if (!address?.email) return '';
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function addressStrings(value) {
  return (Array.isArray(value) ? value : []).map(addressString).filter(Boolean);
}

function normalizedRecipients(args) {
  try {
    const normalized = {
      to: normalizeRecipients(args.to, 'to'),
      cc: normalizeRecipients(args.cc || [], 'cc'),
      bcc: normalizeRecipients(args.bcc || [], 'bcc'),
    };
    if (normalized.to.length + normalized.cc.length + normalized.bcc.length > 100) {
      throw Object.assign(new Error('Too many recipients (max 100)'), {
        code: 'too_many_recipients',
      });
    }
    return normalized;
  } catch (err) {
    err.code ||= 'invalid_recipient';
    throw err;
  }
}

function sendResult(result, subject) {
  if (result.queued) {
    return jsonResult(buildWriteReceipt({ subject }, {
      queued: true,
      outboxId: result.outboxId,
      sendAt: result.sendAt,
      undoSeconds: result.undoSeconds,
      note: 'Cancel with unsend_email before send_at.',
    }));
  }
  return jsonResult(buildWriteReceipt(result.receipt, { sent: true }));
}

function errorFrom(err) {
  if (err?.code) return writeError(err.code, err.message);
  return writeError('invalid_arguments', err?.message || 'send failed');
}

export async function handleSendEmail(args, scope, deps = {}) {
  if (!deps.sendService || !deps.outboxService?.normalizeUndoWindow) {
    return writeError('unsupported', 'send tools require sendService and outboxService');
  }
  try {
    const account = await getAccountByEmail(args.account, scope.accountIds);
    if (account?.error) return errorResult(account.error);
    let identity;
    if (args.alias) {
      identity = await resolveFromIdentity(account, { aliasEmail: args.alias }, deps);
    }
    const recipients = normalizedRecipients(args);
    const preferences = await getUserPreferences(scope.userId);
    const undoSeconds = deps.outboxService.normalizeUndoWindow(
      args.undo_send_seconds,
      preferences.undoSendSeconds,
    );
    const bodyIsHtml = args.body_html !== undefined;
    const result = await deps.sendService.sendOrEnqueue({
      userId: scope.userId,
      account,
      aliasId: identity?.aliasId,
      aliasEmail: args.alias,
      ...recipients,
      subject: args.subject || '',
      body: bodyIsHtml ? args.body_html : (args.body || ''),
      bodyIsHtml,
      priority: args.priority,
      attachments: (args.attachments || []).map(attachmentInput),
      undoSeconds,
      idempotencyKey: args.idempotency_key,
    }, deps);
    return sendResult(result, args.subject || '');
  } catch (err) {
    return errorFrom(err);
  }
}

export async function handleSendDraft(args, scope, deps = {}) {
  if (
    !deps.sendService ||
    !deps.draftService ||
    !deps.outboxService?.normalizeUndoWindow
  ) {
    return writeError(
      'unsupported',
      'send_draft requires sendService, draftService, and outboxService',
    );
  }
  try {
    const account = await getAccountByEmail(args.account, scope.accountIds);
    if (account?.error) return errorResult(account.error);
    const folder = args.folder || account?.folder_mappings?.drafts || 'Drafts';
    const draft = await getDraftRow(account.id, folder, args.draft_uid);
    if (!draft) return writeError('draft_not_found', args.draft_uid);
    const aliasEmail = draft.from_email && draft.from_email !== account.email_address
      ? draft.from_email
      : undefined;
    const identity = aliasEmail
      ? await resolveFromIdentity(account, { aliasEmail }, deps)
      : undefined;
    const preferences = await getUserPreferences(scope.userId);
    const undoSeconds = deps.outboxService.normalizeUndoWindow(
      args.undo_send_seconds,
      preferences.undoSendSeconds,
    );
    const bodyIsHtml = Boolean(draft.body_html);
    const result = await deps.sendService.sendOrEnqueue({
      userId: scope.userId,
      account,
      aliasId: identity?.aliasId,
      aliasEmail,
      to: addressStrings(draft.to_addresses),
      cc: addressStrings(draft.cc_addresses),
      bcc: addressStrings(draft.bcc_addresses),
      subject: draft.subject || '',
      body: bodyIsHtml ? draft.body_html : (draft.body_text || ''),
      bodyIsHtml,
      inReplyTo: draft.in_reply_to || undefined,
      references: draft.thread_references || undefined,
      undoSeconds,
      idempotencyKey: args.idempotency_key,
      ...(undoSeconds
        ? { deleteDraftOnSend: { uid: draft.uid, folder: draft.folder } }
        : {}),
    }, deps);
    if (!result.queued) {
      try {
        await deps.draftService.deleteDraft({
          account,
          uid: draft.uid,
          folder: draft.folder,
        }, deps);
      } catch (err) {
        console.error('Draft cleanup after send failed:', err.message);
      }
    }
    return sendResult(result, draft.subject || '');
  } catch (err) {
    return errorFrom(err);
  }
}

function cancelledOutbox(outboxId, row) {
  return {
    cancelled: true,
    outbox_id: outboxId,
    subject: row?.subject || '',
    to: row?.to_preview || [],
  };
}

function recalledOutbox(outboxId, row) {
  return {
    recalled: 'cancelled_before_send',
    outbox_id: outboxId,
    subject: row?.subject || '',
    to: row?.to_preview || [],
  };
}

function cancelFailure(outboxId, reason) {
  if (reason === 'already_sent') {
    return writeError(
      'already_sent',
      `message ${outboxId} is no longer pending and cannot be unsent`,
    );
  }
  return writeError('outbox_not_found', outboxId);
}

async function pendingOutboxById(outboxId, scope, deps) {
  if (!deps.outboxService?.listPending) return null;
  const rows = await deps.outboxService.listPending({ userId: scope.userId }, deps);
  return rows.find(row => row.id === outboxId) || null;
}

async function cancelOutbox(outboxId, row, scope, deps, resultBuilder) {
  const result = await deps.outboxService.cancel({
    id: outboxId,
    userId: scope.userId,
  }, deps);
  if (result.cancelled || result.reason === 'cancelled') {
    return jsonResult(resultBuilder(outboxId, row));
  }
  return cancelFailure(outboxId, result.reason);
}

export async function handleUnsendEmail(args, scope, deps = {}) {
  if (!deps.outboxService?.cancel) {
    return writeError('unsupported', 'unsend_email requires outboxService');
  }
  try {
    const row = await pendingOutboxById(args.outbox_id, scope, deps);
    return await cancelOutbox(
      args.outbox_id,
      row,
      scope,
      deps,
      cancelledOutbox,
    );
  } catch (err) {
    return errorFrom(err);
  }
}

function wireOutboxRow(row) {
  const sendAt = row?.send_at instanceof Date
    ? row.send_at.toISOString()
    : row?.send_at;
  return {
    ...row,
    ...(sendAt !== undefined ? { send_at: toRFC3339(sendAt) } : {}),
  };
}

export async function handleListOutbox(_args, scope, deps = {}) {
  if (!deps.outboxService?.listPending) {
    return writeError('unsupported', 'list_outbox requires outboxService');
  }
  try {
    const rows = await deps.outboxService.listPending({ userId: scope.userId }, deps);
    return jsonResult(newPaginatedResponseNoTotal(
      rows.map(wireOutboxRow),
      0,
      false,
    ));
  } catch (err) {
    return errorFrom(err);
  }
}

function followupSubject(subject) {
  const value = subject || '';
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}

async function recallDelivered(args, message, account, scope, deps) {
  const deleteSentCopy = args.delete_sent_copy !== false;
  const draftFollowup = args.draft_followup !== false;
  if (deleteSentCopy && !deps.imapManager?.permanentDeleteMessage) {
    return writeError('unsupported', 'recall_email requires imapManager');
  }
  if (draftFollowup && !deps.draftService?.saveDraft) {
    return writeError('unsupported', 'recall_email requires draftService');
  }

  if (deleteSentCopy) {
    await deps.imapManager.permanentDeleteMessage(
      account,
      message.uid,
      message.folder,
    );
    await deleteMessageRow(message.account_id, message.uid, message.folder);
  }

  let followupDraft;
  if (draftFollowup) {
    const saved = await deps.draftService.saveDraft({
      userId: scope.userId,
      account,
      to: addressStrings(message.to_addresses),
      cc: addressStrings(message.cc_addresses),
      bcc: [],
      subject: followupSubject(message.subject),
      body: args.followup_note ?? 'Please disregard my previous email.',
      bodyIsHtml: false,
      attachments: [],
      inReplyTo: message.message_id,
    }, deps);
    followupDraft = {
      draft_uid: saved.uid,
      folder: saved.folder,
    };
  }

  return jsonResult({
    recalled: 'not_possible',
    note: 'SMTP cannot retract a delivered message. Recipients already received it; deleting your Sent copy does not affect their mailboxes.',
    sent_copy_deleted: deleteSentCopy,
    ...(followupDraft ? { followup_draft: followupDraft } : {}),
  });
}

export async function handleRecallEmail(args, scope, deps = {}) {
  if (!deps.outboxService?.cancel) {
    return writeError('unsupported', 'recall_email requires outboxService');
  }
  try {
    if (!args.outbox_id && !args.message_id) {
      return writeError(
        'invalid_arguments',
        'recall_email requires message_id or outbox_id',
      );
    }

    if (args.outbox_id) {
      const row = await pendingOutboxById(args.outbox_id, scope, deps);
      return await cancelOutbox(
        args.outbox_id,
        row,
        scope,
        deps,
        recalledOutbox,
      );
    }

    const pending = await getOutboxRowByMessageId(
      args.message_id,
      scope.userId,
    );
    if (pending) {
      return await cancelOutbox(
        pending.id,
        pending,
        scope,
        deps,
        recalledOutbox,
      );
    }

    const message = await getComposeSource(args.message_id, scope.accountIds);
    if (!message) return writeError('message_not_found', args.message_id);
    const account = await getAccountRow(message.account_id, scope.accountIds);
    if (!account) return writeError('account_not_found', message.account_id);
    return recallDelivered(args, message, account, scope, deps);
  } catch (err) {
    return errorFrom(err);
  }
}
