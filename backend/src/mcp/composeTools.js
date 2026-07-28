import {
  getAccountRow,
  getComposeSource,
  getUserPreferences,
  listAliases,
} from './accountAdapter.js';
import { jsonResult } from './result.js';
import { buildWriteReceipt, writeError } from './writeResult.js';
import { normalizeUndoWindow } from '../services/outboxService.js';
import * as replyService from '../services/replyService.js';

const annotations = (readOnlyHint, destructiveHint, idempotentHint) => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint: false,
});

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

export const replyEmailDef = {
  name: 'reply_email',
  description: 'Reply to the sender of a message.',
  inputSchema: {
    type: 'object',
    required: ['message_id', 'body'],
    properties: replyProperties,
  },
  annotations: annotations(false, true, false),
};

export const replyAllEmailDef = {
  name: 'reply_all_email',
  description: 'Reply to the sender and all original To/Cc recipients. Bcc recipients of the original are not recoverable (they are not stored). Your own addresses and aliases are excluded from the recipients automatically.',
  inputSchema: {
    type: 'object',
    required: ['message_id', 'body'],
    properties: replyProperties,
  },
  annotations: annotations(false, true, false),
};

export const forwardEmailDef = {
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
  annotations: annotations(false, true, false),
};

function errorFrom(err) {
  if (err?.code) return writeError(err.code, err.message);
  return writeError('invalid_arguments', err?.message || 'compose operation failed');
}

async function composeContext(messageId, scope) {
  const message = await getComposeSource(messageId, scope.accountIds);
  if (!message) {
    return { error: writeError('message_not_found', messageId) };
  }
  const account = await getAccountRow(message.account_id, scope.accountIds);
  if (!account) {
    return { error: writeError('account_not_found', message.account_id) };
  }
  const aliases = await listAliases(account.id);
  return { message, account, aliases };
}

function recipientsComputed(message, account, aliases) {
  return {
    reply_target: replyService.pickReplyTarget(message).email || '',
    excluded_self: [...replyService.selfAddressSet(account, aliases)].sort(),
  };
}

function receiptForResult(result, compose, forwarded) {
  const receipt = {
    ...result.receipt,
    ...(compose.inReplyTo !== undefined ? { inReplyTo: compose.inReplyTo } : {}),
    ...(compose.references !== undefined ? { references: compose.references } : {}),
  };
  if (forwarded) {
    receipt.attachments = (receipt.attachments || []).map(attachment => ({
      ...attachment,
      source: 'forwarded',
    }));
  }
  return receipt;
}

function sendResult(result, compose, resultFields = {}, forwarded = false) {
  if (result.queued) {
    return jsonResult(buildWriteReceipt({
      subject: compose.subject,
      inReplyTo: compose.inReplyTo,
      references: compose.references,
    }, {
      queued: true,
      outboxId: result.outboxId,
      sendAt: result.sendAt,
      undoSeconds: result.undoSeconds,
      ...resultFields,
      note: 'Cancel with unsend_email before send_at.',
    }));
  }
  return jsonResult(buildWriteReceipt(
    receiptForResult(result, compose, forwarded),
    { sent: true, ...resultFields },
  ));
}

async function sendCompose(compose, args, scope, deps, resultFields, forwarded = false) {
  const preferences = await getUserPreferences(scope.userId);
  const result = await deps.sendService.sendOrEnqueue({
    ...compose,
    undoSeconds: normalizeUndoWindow(
      args.undo_send_seconds,
      preferences?.undoSendSeconds,
    ),
    idempotencyKey: args.idempotency_key,
  }, deps);
  return sendResult(result, compose, resultFields, forwarded);
}

function replyInput(args, context, replyAll) {
  const bodyIsHtml = args.body_html !== undefined;
  return {
    message: context.message,
    account: context.account,
    aliases: context.aliases,
    replyAll,
    body: bodyIsHtml ? args.body_html : (args.body || ''),
    bodyIsHtml,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    toAdd: args.to_add,
    ccAdd: args.cc_add,
    bccAdd: args.bcc_add,
    remove: args.remove,
    noQuote: args.no_quote,
    includeInlineImages: args.include_inline_images,
    alias: args.alias,
  };
}

async function handleReply(args, scope, deps, replyAll) {
  if (!deps?.sendService) {
    return writeError('unsupported', 'compose tools require sendService');
  }
  try {
    const context = await composeContext(args.message_id, scope);
    if (context.error) return context.error;
    if (
      args.include_inline_images &&
      !args.no_quote &&
      !deps.imapManager?.fetchAttachment
    ) {
      return writeError('unsupported', 'include_inline_images requires imapManager');
    }
    const compose = await replyService.buildReply(
      replyInput(args, context, replyAll),
      deps,
    );
    return sendCompose(compose, args, scope, deps, {
      recipientsComputed: recipientsComputed(
        context.message,
        context.account,
        context.aliases,
      ),
    });
  } catch (err) {
    return errorFrom(err);
  }
}

export async function handleReplyEmail(args, scope, deps = {}) {
  return handleReply(args, scope, deps, false);
}

export async function handleReplyAllEmail(args, scope, deps = {}) {
  return handleReply(args, scope, deps, true);
}

export async function handleForwardEmail(args, scope, deps = {}) {
  if (!deps?.sendService) {
    return writeError('unsupported', 'compose tools require sendService');
  }
  try {
    const context = await composeContext(args.message_id, scope);
    if (context.error) return context.error;
    const compose = await replyService.buildForward({
      message: context.message,
      account: context.account,
      aliases: context.aliases,
      to: args.to,
      note: args.note,
      skipAttachments: args.skip_attachments,
      alias: args.alias,
    }, deps);
    return sendCompose(compose, args, scope, deps, {}, true);
  } catch (err) {
    return errorFrom(err);
  }
}
