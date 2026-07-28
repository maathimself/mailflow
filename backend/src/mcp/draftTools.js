import {
  getAccountByEmail,
  getAccountRow,
  getComposeSource,
  getDraftRow,
  listDraftRows,
} from './accountAdapter.js';
import { newPaginatedResponse, toRFC3339 } from './envelope.js';
import { errorResult, jsonResult } from './result.js';
import { buildWriteReceipt, writeError } from './writeResult.js';
import { mapRecipientList } from '../services/mail/addresses.js';
import { resolveFromIdentity } from '../services/mail/identity.js';
import { buildReferences } from '../services/replyService.js';

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

const draftComposeProperties = {
  account: {
    type: 'string',
    description: 'Account email address (see get_stats for available accounts)',
  },
  to: {
    type: 'array',
    items: { type: 'string' },
    description: "Recipients as 'Name <email>' or bare 'email'",
  },
  cc: { type: 'array', items: { type: 'string' } },
  bcc: { type: 'array', items: { type: 'string' } },
  subject: { type: 'string' },
  body: { type: 'string', description: 'Plain-text body' },
  body_html: {
    type: 'string',
    description: 'HTML body. When set, takes precedence over body for the HTML part.',
  },
  reply_to_message_id: {
    type: 'string',
    description: 'Message id to thread this draft under; sets In-Reply-To and References.',
  },
  alias: {
    type: 'string',
    description: 'Send-as alias email. Must be a configured alias on the account — errors if unknown, never silently falls back.',
  },
  attachments: attachmentSchema,
};

export const createDraftDef = {
  name: 'create_draft',
  description: "Create a draft email in the account's Drafts folder. Does NOT send. Returns the draft's uid and folder for later update_draft/send_draft/delete_draft calls.",
  inputSchema: {
    type: 'object',
    required: ['account'],
    properties: draftComposeProperties,
  },
  annotations: annotations(false, false, false),
};

export const updateDraftDef = {
  name: 'update_draft',
  description: 'Update an existing draft. IMAP has no update-in-place for messages: this appends a new draft and deletes the old one, so the draft_uid CHANGES. Use the returned draft_uid for subsequent calls.',
  inputSchema: {
    type: 'object',
    required: ['account', 'draft_uid'],
    properties: {
      ...draftComposeProperties,
      draft_uid: { type: 'integer' },
      folder: { type: 'string' },
    },
  },
  annotations: annotations(false, true, false),
};

export const listDraftsDef = {
  name: 'list_drafts',
  description: 'List drafts, newest first. Paginate with offset/limit (default limit 20, max 100).',
  inputSchema: {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        description: 'Filter by account email address (use get_stats to list available accounts)',
      },
      limit: { type: 'integer', default: 20, maximum: 100 },
      offset: { type: 'integer', default: 0, minimum: 0 },
    },
  },
  annotations: annotations(true, false, true),
};

export const getDraftDef = {
  name: 'get_draft',
  description: 'Get a draft including body text, body HTML, threading headers, and attachment metadata.',
  inputSchema: {
    type: 'object',
    required: ['account', 'draft_uid'],
    properties: {
      account: {
        type: 'string',
        description: 'Account email address (see get_stats for available accounts)',
      },
      draft_uid: { type: 'integer' },
      folder: { type: 'string' },
    },
  },
  annotations: annotations(true, false, true),
};

export const deleteDraftDef = {
  name: 'delete_draft',
  description: 'PERMANENTLY deletes the draft from IMAP — it does not go to Trash and cannot be recovered.',
  inputSchema: {
    type: 'object',
    required: ['account', 'draft_uid'],
    properties: {
      account: {
        type: 'string',
        description: 'Account email address (see get_stats for available accounts)',
      },
      draft_uid: { type: 'integer' },
      folder: { type: 'string' },
    },
  },
  annotations: annotations(false, true, true),
};

function unsupported(deps) {
  if (deps?.draftService) return null;
  return writeError('unsupported', 'draft tools require draftService');
}

function draftFolder(account, requestedFolder) {
  return requestedFolder || account?.folder_mappings?.drafts || 'Drafts';
}

async function accountForEmail(email, scope) {
  const account = await getAccountByEmail(email, scope.accountIds);
  return account?.error ? { error: errorResult(account.error) } : { account };
}

function addressString(address) {
  if (typeof address === 'string') return address;
  if (!address?.email) return '';
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function addressStrings(value) {
  return (Array.isArray(value) ? value : []).map(addressString).filter(Boolean);
}

function attachmentInput(attachment) {
  return {
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.content_type ?? attachment.contentType,
  };
}

function attachmentSize(attachment) {
  if (Number.isFinite(Number(attachment?.size))) return Number(attachment.size);
  if (typeof attachment?.content !== 'string') return 0;
  try {
    return Buffer.from(attachment.content, 'base64').length;
  } catch {
    return 0;
  }
}

function receiptForDraft(identity, compose, saved) {
  return buildWriteReceipt({
    messageId: saved.messageId,
    from: {
      name: identity?.fromName || '',
      email: identity?.fromEmail || '',
    },
    to: mapRecipientList(compose.to),
    cc: mapRecipientList(compose.cc),
    bcc: mapRecipientList(compose.bcc),
    subject: compose.subject || '',
    attachments: (compose.attachments || []).map(attachment => ({
      filename: attachment.filename,
      size: attachmentSize(attachment),
    })),
  });
}

function draftResult(saved, identity, compose) {
  return jsonResult({
    draft_uid: saved.uid,
    folder: saved.folder,
    message_id: saved.messageId,
    receipt: receiptForDraft(identity, compose, saved),
  });
}

function errorFrom(exception) {
  if (exception?.code) return writeError(exception.code, exception.message);
  if (/drafts folder/i.test(exception?.message || '')) {
    return writeError('no_drafts_folder', exception.message);
  }
  return writeError('invalid_arguments', exception?.message || 'draft operation failed');
}

async function threadingFor(messageId, scope) {
  if (!messageId) return {};
  const source = await getComposeSource(messageId, scope.accountIds);
  if (!source) return { error: writeError('message_not_found', messageId) };
  return buildReferences(source);
}

export async function handleCreateDraft(args, scope, deps = {}) {
  const missing = unsupported(deps);
  if (missing) return missing;
  try {
    const resolved = await accountForEmail(args.account, scope);
    if (resolved.error) return resolved.error;
    const identity = await resolveFromIdentity(
      resolved.account,
      { aliasEmail: args.alias },
      deps,
    );
    const threading = await threadingFor(args.reply_to_message_id, scope);
    if (threading.error) return threading.error;
    const compose = {
      userId: scope.userId,
      account: resolved.account,
      aliasEmail: args.alias,
      to: args.to || [],
      cc: args.cc || [],
      bcc: args.bcc || [],
      subject: args.subject || '',
      body: args.body_html !== undefined ? args.body_html : (args.body || ''),
      bodyIsHtml: args.body_html !== undefined,
      attachments: (args.attachments || []).map(attachmentInput),
      inReplyTo: threading.inReplyTo,
      references: threading.references,
    };
    const saved = await deps.draftService.saveDraft(compose, deps);
    return draftResult(saved, identity, compose);
  } catch (err) {
    return errorFrom(err);
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function mergedCompose(args, existing, account) {
  const explicitBody = hasOwn(args, 'body');
  const explicitHtml = hasOwn(args, 'body_html');
  const useHtml = explicitHtml || (!explicitBody && Boolean(existing.body_html));
  const body = explicitHtml
    ? args.body_html
    : explicitBody
      ? args.body
      : useHtml
        ? existing.body_html
        : (existing.body_text || '');
  return {
    userId: undefined,
    account,
    aliasEmail: hasOwn(args, 'alias')
      ? args.alias
      : (existing.from_email && existing.from_email !== account.email_address
          ? existing.from_email
          : undefined),
    to: hasOwn(args, 'to') ? args.to : addressStrings(existing.to_addresses),
    cc: hasOwn(args, 'cc') ? args.cc : addressStrings(existing.cc_addresses),
    bcc: hasOwn(args, 'bcc') ? args.bcc : addressStrings(existing.bcc_addresses),
    subject: hasOwn(args, 'subject') ? args.subject : (existing.subject || ''),
    body,
    bodyIsHtml: useHtml,
    attachments: hasOwn(args, 'attachments')
      ? (args.attachments || []).map(attachmentInput)
      : (existing.attachments || []).map(attachmentInput),
    inReplyTo: existing.in_reply_to || undefined,
    references: existing.thread_references || undefined,
  };
}

export async function handleUpdateDraft(args, scope, deps = {}) {
  const missing = unsupported(deps);
  if (missing) return missing;
  try {
    const resolved = await accountForEmail(args.account, scope);
    if (resolved.error) return resolved.error;
    const folder = draftFolder(resolved.account, args.folder);
    const existing = await getDraftRow(resolved.account.id, folder, args.draft_uid);
    if (!existing) return writeError('draft_not_found', args.draft_uid);

    const compose = mergedCompose(args, existing, resolved.account);
    compose.userId = scope.userId;
    if (args.reply_to_message_id) {
      const threading = await threadingFor(args.reply_to_message_id, scope);
      if (threading.error) return threading.error;
      compose.inReplyTo = threading.inReplyTo;
      compose.references = threading.references;
    }
    const identity = await resolveFromIdentity(
      resolved.account,
      { aliasEmail: compose.aliasEmail },
      deps,
    );
    compose.existingUid = existing.uid;
    compose.existingFolder = existing.folder;
    const saved = await deps.draftService.saveDraft(compose, deps);
    return draftResult(saved, identity, compose);
  } catch (err) {
    return errorFrom(err);
  }
}

function draftSummary(row) {
  return {
    draft_uid: row.uid,
    folder: row.folder,
    subject: row.subject || '',
    to: row.to_addresses || [],
    cc: row.cc_addresses || [],
    snippet: row.snippet || '',
    date: toRFC3339(row.date),
    has_attachments: Boolean(
      row.has_attachments || (Array.isArray(row.attachments) && row.attachments.length),
    ),
  };
}

async function listAccounts(args, scope) {
  if (args.account) {
    const resolved = await accountForEmail(args.account, scope);
    return resolved.error ? resolved : { accounts: [resolved.account] };
  }
  const accounts = [];
  for (const accountId of scope.accountIds || []) {
    const account = await getAccountRow(accountId, scope.accountIds);
    if (account) accounts.push(account);
  }
  return { accounts };
}

export async function handleListDrafts(args, scope, deps = {}) {
  const missing = unsupported(deps);
  if (missing) return missing;
  try {
    const resolved = await listAccounts(args, scope);
    if (resolved.error) return resolved.error;
    const rows = [];
    for (const account of resolved.accounts) {
      const accountRows = await listDraftRows(account.id, {
        limit: Number.MAX_SAFE_INTEGER,
        offset: 0,
        folder: draftFolder(account),
      });
      rows.push(...accountRows);
    }
    rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const limit = Math.min(Math.max(Number.parseInt(args.limit, 10) || 20, 1), 100);
    const offset = Math.max(Number.parseInt(args.offset, 10) || 0, 0);
    const page = rows.slice(offset, offset + limit).map(draftSummary);
    return jsonResult(newPaginatedResponse(page, rows.length, offset));
  } catch (err) {
    return errorFrom(err);
  }
}

function fullDraft(row) {
  return {
    draft_uid: row.uid,
    folder: row.folder,
    subject: row.subject || '',
    to: row.to_addresses || [],
    cc: row.cc_addresses || [],
    bcc: row.bcc_addresses || [],
    body_text: row.body_text || '',
    body_html: row.body_html || '',
    in_reply_to: row.in_reply_to || null,
    references: row.thread_references || null,
    attachments: row.attachments || [],
  };
}

export async function handleGetDraft(args, scope, deps = {}) {
  const missing = unsupported(deps);
  if (missing) return missing;
  try {
    const resolved = await accountForEmail(args.account, scope);
    if (resolved.error) return resolved.error;
    const folder = draftFolder(resolved.account, args.folder);
    const row = await getDraftRow(resolved.account.id, folder, args.draft_uid);
    if (!row) return writeError('draft_not_found', args.draft_uid);
    return jsonResult(fullDraft(row));
  } catch (err) {
    return errorFrom(err);
  }
}

export async function handleDeleteDraft(args, scope, deps = {}) {
  const missing = unsupported(deps);
  if (missing) return missing;
  try {
    const resolved = await accountForEmail(args.account, scope);
    if (resolved.error) return resolved.error;
    const folder = draftFolder(resolved.account, args.folder);
    const row = await getDraftRow(resolved.account.id, folder, args.draft_uid);
    if (!row) return writeError('draft_not_found', args.draft_uid);
    await deps.draftService.deleteDraft({
      account: resolved.account,
      uid: row.uid,
      folder: row.folder,
    }, deps);
    return jsonResult({ deleted: true, draft_uid: row.uid, folder: row.folder });
  } catch (err) {
    return errorFrom(err);
  }
}
