import { normalizeRecipients, sanitizeHeaderValue } from './mail/addresses.js';
import { UUID_RE } from '../utils/validation.js';

export const MAX_COMPOSE_SESSIONS = 9;
export const MAX_COMPOSE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_COMPOSE_ATTACHMENTS = 100;
export const PATCHABLE_FIELDS = Object.freeze([
  'accountId', 'aliasId', 'mode', 'to', 'cc', 'bcc', 'subject', 'body',
  'bodyIsHtml', 'quotedBody', 'quotedBodyHtml', 'editedSignature',
  'forwardedAttachments', 'priority', 'inReplyTo', 'references', 'fromChanged',
]);

const RECIPIENT_FIELDS = new Set(['to', 'cc', 'bcc']);
const NULLABLE_UUID_FIELDS = new Set(['accountId', 'aliasId']);
const NULLABLE_TEXT_FIELDS = new Set([
  'quotedBody', 'quotedBodyHtml', 'editedSignature', 'inReplyTo',
]);
const BOOLEAN_FIELDS = new Set(['bodyIsHtml', 'fromChanged']);
// Opaque transport correlation only: no whitespace, domains, paths, or free-form content.
const CLIENT_ID_RE = /^(?:[A-Za-z0-9_-]{1,64}|mcp:[A-Za-z0-9_-]{1,60})$/;

export function composeSessionError(code, message, status = 400, details = {}) {
  return Object.assign(new Error(message), { code, status, details, expose: true });
}

function invalidChanges(message) {
  throw composeSessionError('invalid_compose_changes', message);
}

function normalizeHeaderList(value, field) {
  if (!Array.isArray(value)) invalidChanges(`${field} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      invalidChanges(`${field}[${index}] must be a non-empty string`);
    }
    const normalized = sanitizeHeaderValue(item);
    if (!normalized) invalidChanges(`${field}[${index}] must be a non-empty string`);
    return normalized;
  });
}

function normalizeForwardedAttachments(value) {
  if (!Array.isArray(value)) invalidChanges('forwardedAttachments must be an array');
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)
        || typeof attachment.messageId !== 'string' || !UUID_RE.test(attachment.messageId)) {
      invalidChanges(`forwardedAttachments[${index}].messageId is invalid`);
    }
    if (typeof attachment.part !== 'string' || !attachment.part.trim()) {
      invalidChanges(`forwardedAttachments[${index}].part is required`);
    }
    const part = sanitizeHeaderValue(attachment.part);
    if (!part) invalidChanges(`forwardedAttachments[${index}].part is required`);
    return { messageId: attachment.messageId, part };
  });
}

export function normalizeComposeChanges(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalidChanges('changes must be an object');
  }
  const output = {};
  for (const field of PATCHABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const value = input[field];
    if (RECIPIENT_FIELDS.has(field)) {
      try {
        output[field] = normalizeRecipients(value, field);
      } catch (error) {
        invalidChanges(error.message);
      }
    } else if (NULLABLE_UUID_FIELDS.has(field)) {
      if (value !== null && (typeof value !== 'string' || !UUID_RE.test(value))) {
        invalidChanges(`${field} must be a UUID or null`);
      }
      output[field] = value;
    } else if (field === 'subject') {
      if (typeof value !== 'string') invalidChanges('subject must be a string');
      output[field] = sanitizeHeaderValue(value);
    } else if (field === 'body') {
      if (typeof value !== 'string') invalidChanges('body must be a string');
      output[field] = value;
    } else if (NULLABLE_TEXT_FIELDS.has(field)) {
      if (value !== null && typeof value !== 'string') {
        invalidChanges(`${field} must be a string or null`);
      }
      output[field] = field === 'inReplyTo' && value !== null
        ? sanitizeHeaderValue(value)
        : value;
    } else if (BOOLEAN_FIELDS.has(field)) {
      if (typeof value !== 'boolean') invalidChanges(`${field} must be a boolean`);
      output[field] = value;
    } else if (field === 'forwardedAttachments') {
      output[field] = normalizeForwardedAttachments(value);
    } else if (field === 'references') {
      output[field] = normalizeHeaderList(value, field);
    } else if (field === 'priority') {
      if (!['low', 'normal', 'high'].includes(value)) {
        invalidChanges('priority must be low, normal, or high');
      }
      output[field] = value;
    } else if (field === 'mode') {
      if (!['new', 'reply', 'reply_all', 'forward'].includes(value)) {
        invalidChanges('unsupported compose mode');
      }
      output[field] = value;
    }
  }
  return output;
}

export function normalizeReplyAllRecipients(value = []) {
  try {
    return normalizeRecipients(value, 'replyAllRecipients');
  } catch (error) {
    invalidChanges(error.message);
  }
}

export function normalizeComposeClientId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !CLIENT_ID_RE.test(value)) {
    throw composeSessionError(
      'invalid_client_id',
      'clientId must be 1-64 characters using letters, numbers, underscores, or hyphens',
    );
  }
  return value;
}

export function meaningfulComposeSession(session = {}) {
  const lists = ['to', 'cc', 'bcc', 'forwardedAttachments'];
  if (lists.some(key => Array.isArray(session[key]) && session[key].length > 0)) return true;
  if (['subject', 'body', 'quotedBody', 'quotedBodyHtml', 'editedSignature']
    .some(key => String(session[key] || '').trim() !== '')) return true;
  if (Number(session.attachmentCount || 0) > 0) return true;
  if (session.mode && session.mode !== 'new') return true;
  if (session.inReplyTo || session.fromChanged) return true;
  return session.priority != null && session.priority !== 'normal';
}

export function findComposeConflicts(fieldRevisions = {}, expectedRevision, fields = []) {
  return fields.filter(field => Number(fieldRevisions[field] || 0) > Number(expectedRevision));
}
