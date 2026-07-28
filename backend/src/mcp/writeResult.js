import { toRFC3339 } from './envelope.js';
import { errorResult } from './result.js';

export const WRITE_ERROR_CODES = [
  'account_not_found',
  'alias_not_found',
  'message_not_found',
  'draft_not_found',
  'outbox_not_found',
  'invalid_recipient',
  'too_many_recipients',
  'attachment_too_large',
  'no_drafts_folder',
  'no_sent_folder',
  'smtp_failed',
  'already_sent',
  'invalid_arguments',
  'unsupported',
];

const CAMEL_TO_WIRE = {
  draftUid: 'draft_uid',
  inReplyTo: 'in_reply_to',
  messageId: 'message_id',
  outboxId: 'outbox_id',
  recipientsComputed: 'recipients_computed',
  sendAt: 'send_at',
  sentCopySaved: 'sent_copy_saved',
  undoSeconds: 'undo_seconds',
};

function wireTime(value) {
  if (value instanceof Date) return toRFC3339(value.toISOString());
  return toRFC3339(value);
}

function copyResultFields(target, fields) {
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    const wireKey = CAMEL_TO_WIRE[key] || key;
    target[wireKey] = wireKey === 'send_at' ? wireTime(value) : value;
  }
}

export function buildWriteReceipt(receipt = {}, resultFields = {}) {
  const result = {};
  copyResultFields(result, resultFields);

  for (const key of ['messageId', 'inReplyTo', 'references']) {
    if (receipt[key] !== undefined) copyResultFields(result, { [key]: receipt[key] });
  }

  result.from = receipt.from || {};
  result.to = receipt.to || [];
  result.cc = receipt.cc || [];
  result.bcc = receipt.bcc || [];
  result.subject = receipt.subject || '';
  result.attachments = (receipt.attachments || []).map(attachment => ({
    filename: attachment.filename,
    size: attachment.size,
    ...(attachment.source !== undefined ? { source: attachment.source } : {}),
  }));

  for (const key of ['sentCopySaved', 'folder']) {
    if (receipt[key] !== undefined) copyResultFields(result, { [key]: receipt[key] });
  }
  return result;
}

export function writeError(code, detail) {
  return errorResult(`${code}: ${detail}`);
}
