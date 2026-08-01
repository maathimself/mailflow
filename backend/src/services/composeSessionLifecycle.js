import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_COMPOSE_ATTACHMENT_BYTES,
  MAX_COMPOSE_ATTACHMENTS,
  composeSessionError,
  meaningfulComposeSession,
  normalizeReplyAllRecipients,
} from './composeSessionModel.js';
import * as composeSessionService from './composeSessionService.js';
import * as draftService from './draftService.js';
import * as sendService from './sendService.js';
import * as outboxService from './outboxService.js';
import { sanitizeHeaderValue } from './mail/addresses.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { UUID_RE } from '../utils/validation.js';

const VALID_MODES = new Set(['new', 'reply', 'reply_all', 'forward']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);

function normalizedList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function normalizedForwardedAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map(attachment => ({
    messageId: attachment.messageId,
    part: attachment.part,
  }));
}

function attachmentFingerprint(attachment) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    byteCount: Number(attachment.byteCount),
  };
}

function invalidAttachmentContent() {
  return Object.assign(new Error('Compose attachment content is missing or unsupported'), {
    code: 'invalid_compose_attachment_content',
    status: 500,
    expose: false,
  });
}

function isCanonicalBase64(value) {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function attachmentInput(attachment) {
  let content = attachment.content;
  if (Buffer.isBuffer(content)) {
    content = content.toString('base64');
  } else if (content instanceof Uint8Array) {
    content = Buffer.from(content).toString('base64');
  } else if (typeof content !== 'string' || !isCanonicalBase64(content)) {
    throw invalidAttachmentContent();
  }
  return {
    filename: attachment.filename,
    content,
    contentType: typeof attachment.contentType === 'string'
      ? attachment.contentType
      : 'application/octet-stream',
  };
}

function attachmentContentSha256(attachment) {
  const encoded = attachmentInput(attachment).content;
  return createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex');
}

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function recipientStrings(value) {
  const recipients = jsonValue(value, []);
  if (!Array.isArray(recipients)) return [];
  return recipients.map((recipient) => {
    if (typeof recipient === 'string') return sanitizeHeaderValue(recipient);
    if (!recipient || typeof recipient !== 'object') return '';
    const email = sanitizeHeaderValue(recipient.email || recipient.address || '');
    const name = sanitizeHeaderValue(recipient.name || '');
    if (!email) return '';
    return name ? `${name} <${email}>` : email;
  }).filter(Boolean);
}

function referenceStrings(value) {
  if (Array.isArray(value)) return value.map(sanitizeHeaderValue).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  const parsed = jsonValue(value, null);
  if (Array.isArray(parsed)) return parsed.map(sanitizeHeaderValue).filter(Boolean);
  const messageIds = value.match(/<[^>]+>/g);
  return messageIds?.length ? messageIds.map(sanitizeHeaderValue) : [sanitizeHeaderValue(value)];
}

function requireClaimInput(input) {
  if (typeof input.accountId !== 'string' || !UUID_RE.test(input.accountId)) {
    throw composeSessionError(
      'invalid_compose_account_id',
      'accountId must be a UUID',
      400,
    );
  }
  if (typeof input.folder !== 'string'
      || !input.folder.trim()
      || input.folder.length > 500
      || sanitizeHeaderValue(input.folder) !== input.folder) {
    throw composeSessionError(
      'invalid_compose_draft_folder',
      'folder must be a non-empty folder path',
      400,
    );
  }
  if (!Number.isSafeInteger(input.uid) || input.uid < 1) {
    throw composeSessionError(
      'invalid_compose_draft_uid',
      'uid must be a positive integer',
      400,
    );
  }
  const requestedSlot = input.requestedSlot ?? null;
  if (requestedSlot !== null
      && (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > 9)) {
    throw composeSessionError(
      'invalid_compose_slot',
      'requestedSlot must be an integer from 1 to 9',
      400,
    );
  }
  return requestedSlot;
}

function accountFromJoinedRow(row, accountId) {
  return { ...row, id: accountId };
}

async function requireDraftsFolder(row, input, deps) {
  const mappings = jsonValue(row.folder_mappings, {});
  if (mappings?.drafts === input.folder) return;
  const specialUse = await deps.query(
    `SELECT path FROM folders
      WHERE account_id=$1 AND path=$2 AND special_use='\\Drafts'
      LIMIT 1`,
    [input.accountId, input.folder],
  );
  if (!specialUse.rows.length) {
    throw composeSessionError(
      'compose_source_not_draft',
      'The selected message is not in this account\'s Drafts folder',
      400,
    );
  }
}

async function resolveClaimAlias(row, account, deps) {
  const fromEmail = typeof row.from_email === 'string' ? row.from_email.trim() : '';
  const accountEmail = typeof account.email_address === 'string'
    ? account.email_address.trim()
    : '';
  if (!fromEmail || fromEmail.toLowerCase() === accountEmail.toLowerCase()) return null;
  const alias = await deps.query(
    `SELECT id FROM account_aliases
      WHERE account_id=$1 AND LOWER(email)=LOWER($2)
      LIMIT 1`,
    [account.id, fromEmail],
  );
  return alias.rows[0]?.id || null;
}

function attachmentDescriptors(value) {
  const descriptors = jsonValue(value, []);
  return Array.isArray(descriptors) ? descriptors : [];
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedClaimAttachment(descriptor, content, id) {
  if (!Buffer.isBuffer(content)) {
    throw composeSessionError(
      'compose_source_attachment_unavailable',
      'A source draft attachment could not be fetched',
      409,
    );
  }
  const filename = sanitizeHeaderValue(descriptor?.filename || 'attachment') || 'attachment';
  const candidateType = sanitizeHeaderValue(descriptor?.type || descriptor?.contentType || '');
  const contentType = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(candidateType)
    ? candidateType
    : 'application/octet-stream';
  return {
    id,
    part: String(descriptor?.part || ''),
    filename,
    contentType,
    byteCount: content.length,
    content: Buffer.from(content),
  };
}

function claimedSession(values, row, attachments, sourceInitialRevision) {
  return {
    id: row.id,
    slot: Number(row.slot),
    accountId: values.accountId,
    aliasId: values.aliasId,
    mode: 'new',
    to: values.to,
    cc: values.cc,
    bcc: [],
    subject: values.subject,
    body: values.body,
    bodyIsHtml: values.bodyIsHtml,
    quotedBody: null,
    quotedBodyHtml: null,
    editedSignature: null,
    forwardedAttachments: [],
    priority: 'normal',
    inReplyTo: values.inReplyTo,
    references: values.references,
    fromChanged: false,
    replyAllRecipients: values.replyAllRecipients,
    sourceDraftAccountId: values.accountId,
    sourceDraftFolder: values.folder,
    sourceDraftUid: values.uid,
    sourceDraftMessageId: values.messageId,
    sourceInitialRevision,
    presentationState: row.presentation_state,
    operationState: row.operation_state,
    operationToken: row.operation_token,
    revision: Number(row.revision),
    fieldRevisions: jsonValue(row.field_revisions, {}),
    lastFocusedAt: row.last_focused_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: attachments.map(attachment => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteCount: attachment.byteCount,
      createdAt: attachment.createdAt,
    })),
  };
}

export function canonicalCompose(session = {}) {
  const attachments = Array.isArray(session.attachments)
    ? session.attachments.map(attachmentFingerprint)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    : [];

  return {
    accountId: session.accountId ?? null,
    aliasId: session.aliasId ?? null,
    mode: VALID_MODES.has(session.mode) ? session.mode : 'new',
    to: normalizedList(session.to),
    cc: normalizedList(session.cc),
    bcc: normalizedList(session.bcc),
    subject: typeof session.subject === 'string' ? session.subject : '',
    body: typeof session.body === 'string' ? session.body : '',
    bodyIsHtml: typeof session.bodyIsHtml === 'boolean' ? session.bodyIsHtml : true,
    quotedBody: nullableString(session.quotedBody),
    quotedBodyHtml: nullableString(session.quotedBodyHtml),
    editedSignature: nullableString(session.editedSignature),
    forwardedAttachments: normalizedForwardedAttachments(session.forwardedAttachments),
    priority: VALID_PRIORITIES.has(session.priority) ? session.priority : 'normal',
    inReplyTo: nullableString(session.inReplyTo),
    references: normalizedList(session.references),
    fromChanged: session.fromChanged === true,
    attachments,
  };
}

export async function claimDraftIntoComposeSession(input, deps) {
  const requestedSlot = requireClaimInput(input);
  const replyAllRecipients = normalizeReplyAllRecipients(input.replyAllRecipients ?? []);
  const source = await deps.query(
    `SELECT m.*, a.*
       FROM messages m
       JOIN email_accounts a ON a.id=m.account_id
      WHERE m.account_id=$1 AND m.folder=$2 AND m.uid=$3
        AND a.user_id=$4 AND m.is_deleted=false
      LIMIT 1`,
    [input.accountId, input.folder, input.uid, input.userId],
  );
  if (!source.rows.length) {
    throw composeSessionError(
      'compose_source_draft_not_found',
      'Source draft not found',
      404,
    );
  }

  const draft = source.rows[0];
  const account = accountFromJoinedRow(draft, input.accountId);
  await requireDraftsFolder(draft, input, deps);
  const aliasId = await resolveClaimAlias(draft, account, deps);

  let bodyHtml = draft.body_html;
  let bodyText = draft.body_text;
  let descriptors = attachmentDescriptors(draft.attachments);
  const hasCachedBody = nonemptyString(bodyHtml) || nonemptyString(bodyText);
  const missingDeclaredDescriptors = draft.has_attachments === true && descriptors.length === 0;
  if (!hasCachedBody || missingDeclaredDescriptors) {
    const fetched = await deps.imapManager.fetchMessageBody(
      account,
      input.uid,
      input.folder,
    );
    if (!hasCachedBody) {
      const fetchedHtml = nonemptyString(fetched?.html)
        ? sanitizeEmail(fetched.html)
        : null;
      if (nonemptyString(fetchedHtml)) {
        bodyHtml = fetchedHtml;
        bodyText = fetched?.text ?? null;
      } else if (nonemptyString(fetched?.text)) {
        bodyHtml = null;
        bodyText = fetched.text;
      }
    }
    if (Array.isArray(fetched?.attachments) && fetched.attachments.length) {
      descriptors = fetched.attachments;
    }
  }
  if (missingDeclaredDescriptors && descriptors.length === 0) {
    throw composeSessionError(
      'compose_source_attachments_incomplete',
      'Source draft attachment metadata could not be recovered',
      409,
    );
  }
  if (descriptors.length > MAX_COMPOSE_ATTACHMENTS) {
    throw composeSessionError(
      'attachment_count_limit',
      'Compose sessions support at most 100 attachments',
      413,
    );
  }

  const makeUuid = typeof deps.randomUUID === 'function' ? deps.randomUUID : randomUUID;
  const attachments = await Promise.all(descriptors.map(async (descriptor) => {
    const part = typeof descriptor?.part === 'string' ? descriptor.part.trim() : '';
    if (!part) {
      throw composeSessionError(
        'compose_source_attachment_unavailable',
        'A source draft attachment has no fetchable IMAP part',
        409,
      );
    }
    const content = await deps.imapManager.fetchAttachment(
      account,
      input.uid,
      input.folder,
      part,
    );
    return normalizedClaimAttachment({ ...descriptor, part }, content, makeUuid());
  }));
  const totalAttachmentBytes = attachments.reduce(
    (total, attachment) => total + attachment.byteCount,
    0,
  );
  if (totalAttachmentBytes > MAX_COMPOSE_ATTACHMENT_BYTES) {
    throw composeSessionError(
      'attachment_limit',
      'Compose attachments exceed the 25 MiB limit',
      413,
    );
  }

  const values = {
    accountId: input.accountId,
    aliasId,
    mode: 'new',
    to: recipientStrings(draft.to_addresses),
    cc: recipientStrings(draft.cc_addresses),
    bcc: [],
    subject: sanitizeHeaderValue(draft.subject || ''),
    body: nonemptyString(bodyHtml) ? bodyHtml : (bodyText ?? ''),
    bodyIsHtml: nonemptyString(bodyHtml),
    quotedBody: null,
    quotedBodyHtml: null,
    editedSignature: null,
    forwardedAttachments: [],
    priority: 'normal',
    inReplyTo: draft.in_reply_to ? sanitizeHeaderValue(draft.in_reply_to) : null,
    references: referenceStrings(draft.thread_references),
    fromChanged: false,
    replyAllRecipients,
    attachments,
    folder: input.folder,
    uid: input.uid,
    messageId: draft.message_id ? sanitizeHeaderValue(draft.message_id) : null,
  };
  // Attachment ids are allocated before this snapshot and used verbatim by the
  // subsequent inserts, so equality checks refer to the persisted child rows.
  const sourceInitialRevision = canonicalCompose(values);

  const result = await deps.withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`compose-slots:${input.userId}`],
    );
    const alreadyClaimed = await client.query(
      `SELECT id FROM compose_sessions
        WHERE user_id=$1
          AND source_draft_account_id=$2
          AND source_draft_folder=$3
          AND source_draft_uid=$4
        LIMIT 1`,
      [input.userId, input.accountId, input.folder, input.uid],
    );
    if (alreadyClaimed.rows.length) {
      throw composeSessionError(
        'compose_draft_claimed',
        'Source draft is already open in a compose session',
        409,
      );
    }

    const allocated = await client.query(
      `SELECT candidate.slot
         FROM generate_series(1, 9) AS candidate(slot)
        WHERE ($2::smallint IS NULL OR candidate.slot=$2)
          AND NOT EXISTS (
            SELECT 1 FROM compose_sessions existing
             WHERE existing.user_id=$1 AND existing.slot=candidate.slot
          )
        ORDER BY candidate.slot
        LIMIT 1`,
      [input.userId, requestedSlot],
    );
    const slot = allocated.rows[0]?.slot;
    if (!slot) {
      if (requestedSlot !== null) {
        throw composeSessionError(
          'compose_slot_occupied',
          `Compose slot ${requestedSlot} is already occupied`,
          409,
        );
      }
      throw composeSessionError(
        'compose_session_limit',
        'Nine compose sessions are already open',
        409,
      );
    }

    const inserted = await client.query(
      `INSERT INTO compose_sessions (
         user_id, slot, account_id, alias_id,
         to_recipients, cc_recipients, bcc_recipients,
         subject, body, body_is_html, in_reply_to, thread_references,
         reply_all_recipients,
         source_draft_account_id, source_draft_folder, source_draft_uid,
         source_draft_message_id, source_initial_revision
       ) VALUES (
         $1, $2, $3, $4,
         $5::jsonb, $6::jsonb, '[]'::jsonb,
         $7, $8, $9, $10, $11::jsonb,
         $12::jsonb,
         $13, $14, $15, $16, $17::jsonb
       )
       RETURNING *`,
      [
        input.userId,
        Number(slot),
        values.accountId,
        values.aliasId,
        JSON.stringify(values.to),
        JSON.stringify(values.cc),
        values.subject,
        values.body,
        values.bodyIsHtml,
        values.inReplyTo,
        JSON.stringify(values.references),
        JSON.stringify(values.replyAllRecipients),
        values.accountId,
        values.folder,
        values.uid,
        values.messageId,
        JSON.stringify(sourceInitialRevision),
      ],
    );

    const persistedAttachments = [];
    for (const attachment of attachments) {
      const persisted = await client.query(
        `INSERT INTO compose_session_attachments (
           id, session_id, filename, content_type, byte_count, content
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, filename, content_type, byte_count, created_at`,
        [
          attachment.id,
          inserted.rows[0].id,
          attachment.filename,
          attachment.contentType,
          attachment.byteCount,
          attachment.content,
        ],
      );
      persistedAttachments.push({
        id: persisted.rows[0].id,
        filename: persisted.rows[0].filename,
        contentType: persisted.rows[0].content_type,
        byteCount: Number(persisted.rows[0].byte_count),
        createdAt: persisted.rows[0].created_at,
      });
    }
    return claimedSession(values, inserted.rows[0], persistedAttachments, sourceInitialRevision);
  });

  if (typeof deps.broadcast === 'function') {
    deps.broadcast({
      type: 'compose_sessions_updated',
      action: 'claimed',
      sessionId: result.id,
      slot: result.slot,
      revision: result.revision,
    }, input.userId);
  }
  return result;
}

export function sourceDraftChanged(session = {}) {
  return !isDeepStrictEqual(canonicalCompose(session), session.sourceInitialRevision);
}

export function sessionToComposeInput(session = {}, account, options = {}) {
  const canonical = canonicalCompose(session);
  const uploadedAttachments = Array.isArray(session.attachments)
    ? session.attachments.map(attachmentInput)
    : [];
  const materializedForwarded = options.materializedForwardedAttachments;
  const attachments = materializedForwarded === undefined
    ? uploadedAttachments
    : [
      ...uploadedAttachments,
      ...(Array.isArray(materializedForwarded)
        ? materializedForwarded.map(attachmentInput)
        : []),
    ];

  return {
    userId: options.userId,
    account,
    aliasId: canonical.aliasId,
    to: canonical.to,
    cc: canonical.cc,
    bcc: canonical.bcc,
    subject: canonical.subject,
    body: canonical.body,
    bodyIsHtml: canonical.bodyIsHtml,
    quotedBody: canonical.quotedBody,
    quotedBodyHtml: canonical.quotedBodyHtml,
    editedSignature: canonical.editedSignature,
    priority: canonical.priority,
    inReplyTo: canonical.inReplyTo,
    references: canonical.references,
    attachments,
    forwardedAttachments: materializedForwarded === undefined
      ? canonical.forwardedAttachments
      : [],
  };
}

function lifecycleMethod(deps, name, fallback) {
  return typeof deps[name] === 'function' ? deps[name] : fallback;
}

function draftMethod(deps, name, fallback) {
  return typeof deps.draftService?.[name] === 'function'
    ? deps.draftService[name]
    : fallback;
}

function sendMethod(deps, name, fallback) {
  return typeof deps.sendService?.[name] === 'function'
    ? deps.sendService[name]
    : fallback;
}

function outboxMethod(deps, name, fallback) {
  return typeof deps.outboxService?.[name] === 'function'
    ? deps.outboxService[name]
    : fallback;
}

function broadcastLifecycleInvalidation(deps, userId, action, session) {
  if (typeof deps.broadcast !== 'function') return;
  try {
    deps.broadcast({
      type: 'compose_sessions_updated',
      action,
      sessionId: session.id,
      slot: session.slot,
      revision: session.revision,
    }, userId);
  } catch (error) {
    console.error('Compose session invalidation failed', { code: error?.code || 'unknown' });
  }
}

async function resolveOwnedAccount(accountId, userId, deps) {
  const result = await deps.query(
    'SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2 LIMIT 1',
    [accountId, userId],
  );
  if (!result.rows.length) {
    throw composeSessionError(
      'compose_account_not_found',
      'Compose account not found',
      404,
    );
  }
  return result.rows[0];
}

function forwardedDescriptors(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function materializeForwardedAttachments(session, deps) {
  const refs = Array.isArray(session.forwardedAttachments)
    ? session.forwardedAttachments
    : [];
  const materialized = [];
  for (const forwarded of refs) {
    const result = await deps.query(
      `SELECT m.uid, m.folder, m.attachments, to_jsonb(a) AS account
         FROM messages m
         JOIN email_accounts a ON a.id=m.account_id
        WHERE m.id=$1 AND a.user_id=$2 AND m.is_deleted=false
        LIMIT 1`,
      [forwarded.messageId, session.userId],
    );
    if (!result.rows.length) {
      throw composeSessionError(
        'compose_forwarded_message_not_found',
        'Forwarded message not found',
        404,
      );
    }
    const message = result.rows[0];
    const descriptor = forwardedDescriptors(message.attachments)
      .find(candidate => String(candidate?.part) === forwarded.part);
    if (!descriptor) {
      throw composeSessionError(
        'compose_forwarded_attachment_not_found',
        'Forwarded attachment not found',
        404,
      );
    }
    const content = await deps.imapManager.fetchAttachment(
      message.account,
      message.uid,
      message.folder,
      forwarded.part,
    );
    if (!Buffer.isBuffer(content)) {
      throw composeSessionError(
        'compose_forwarded_attachment_unavailable',
        'Forwarded attachment content is unavailable',
        409,
      );
    }
    const filename = sanitizeHeaderValue(descriptor.filename || 'attachment') || 'attachment';
    const candidateType = sanitizeHeaderValue(descriptor.type || descriptor.contentType || '');
    const contentType = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(candidateType)
      ? candidateType
      : 'application/octet-stream';
    materialized.push({ filename, contentType, content: Buffer.from(content) });
  }

  const uploadedBytes = Array.isArray(session.attachments)
    ? session.attachments.reduce((total, attachment) => total + Number(attachment.byteCount || 0), 0)
    : 0;
  const forwardedBytes = materialized.reduce(
    (total, attachment) => total + attachment.content.length,
    0,
  );
  if (uploadedBytes + forwardedBytes > MAX_COMPOSE_ATTACHMENT_BYTES) {
    throw composeSessionError(
      'attachment_limit',
      'Compose attachments exceed the 25 MiB limit',
      413,
    );
  }
  return materialized;
}

async function releaseClaim(input, session, deps, originalError) {
  const release = lifecycleMethod(
    deps,
    'releaseComposeOperation',
    composeSessionService.releaseComposeOperation,
  );
  try {
    const released = await release({
      userId: input.userId,
      id: session.id,
      token: session.operationToken,
    }, deps);
    if (released) {
      broadcastLifecycleInvalidation(deps, input.userId, 'operation_released', session);
    }
  } catch (releaseError) {
    console.error('Compose session operation release failed', {
      originalCode: originalError?.code || 'unknown',
      releaseCode: releaseError?.code || 'unknown',
    });
  }
}

function normalizeExternalLifecycleError(error) {
  if (error?.expose !== true || typeof error.code === 'string') return error;
  if (error.status === 422) {
    return composeSessionError(
      'compose_drafts_folder_not_found',
      'No Drafts folder is available for this account',
      422,
    );
  }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status
    : 500;
  return composeSessionError(
    'compose_draft_operation_failed',
    'Draft operation failed',
    status,
  );
}

function lifecycleAcceptedCleanupPending(operation) {
  const close = operation === 'close';
  return composeSessionError(
    close
      ? 'compose_close_accepted_cleanup_pending'
      : 'compose_discard_accepted_cleanup_pending',
    close
      ? 'Draft was saved but compose cleanup is still pending; do not retry'
      : 'Draft was deleted but compose cleanup is still pending; do not retry',
    409,
  );
}

async function deleteTerminalComposeSession(input, session, deps, allowAlreadyAbsent) {
  const deleteClaimed = lifecycleMethod(
    deps,
    'deleteClaimedComposeSession',
    composeSessionService.deleteClaimedComposeSession,
  );
  const deleted = await deleteClaimed({
    userId: input.userId,
    id: session.id,
    token: session.operationToken,
  }, deps);
  if (deleted) return;

  if (allowAlreadyAbsent) {
    const remaining = await deps.query(
      `SELECT operation_state, operation_token
         FROM compose_sessions
        WHERE id=$1 AND user_id=$2
        LIMIT 1`,
      [session.id, input.userId],
    );
    if (!remaining.rows.length) return;
  }

  throw Object.assign(new Error('Claimed compose session could not be deleted'), {
    code: 'compose_claim_lost',
    status: 500,
    expose: false,
  });
}

export async function closeComposeSession(input, deps) {
  const claim = lifecycleMethod(
    deps,
    'claimComposeOperation',
    composeSessionService.claimComposeOperation,
  );
  const claimed = await claim({
    userId: input.userId,
    id: input.id,
    slot: input.slot,
    expectedRevision: input.expectedRevision,
    operation: 'closing',
    changes: input.changes === undefined ? {} : input.changes,
  }, deps);
  const session = { ...claimed, userId: input.userId };
  let saved = null;
  let saveAccount = null;
  let accepted = false;
  try {
    const hasSource = session.sourceDraftUid != null
      && session.sourceDraftFolder
      && session.sourceDraftAccountId;
    const shouldSave = hasSource
      ? sourceDraftChanged(session)
      : meaningfulComposeSession({
        ...session,
        attachmentCount: Array.isArray(session.attachments) ? session.attachments.length : 0,
      });
    if (shouldSave) {
      saveAccount = await resolveOwnedAccount(session.accountId, input.userId, deps);
      const crossesAccounts = hasSource && session.sourceDraftAccountId !== saveAccount.id;
      const sourceAccount = crossesAccounts
        ? await resolveOwnedAccount(session.sourceDraftAccountId, input.userId, deps)
        : saveAccount;
      const materializedForwardedAttachments = await materializeForwardedAttachments(session, deps);
      const save = draftMethod(deps, 'saveDraft', draftService.saveDraft);
      saved = await save({
        ...sessionToComposeInput(session, saveAccount, {
          userId: input.userId,
          materializedForwardedAttachments,
        }),
        ...(hasSource && !crossesAccounts ? {
          existingUid: session.sourceDraftUid,
          existingFolder: session.sourceDraftFolder,
          reportSourceDraftDeletion: true,
        } : {}),
      }, deps);
      accepted = true;
      if (!crossesAccounts && saved?.sourceDraftDeleted === false) {
        throw lifecycleAcceptedCleanupPending('close');
      }
      if (crossesAccounts) {
        const deleteDraft = draftMethod(deps, 'deleteDraft', draftService.deleteDraft);
        await deleteDraft({
          account: sourceAccount,
          uid: session.sourceDraftUid,
          folder: session.sourceDraftFolder,
        }, deps);
      }
    }

    await deleteTerminalComposeSession(input, session, deps, accepted);
  } catch (error) {
    if (accepted) {
      if (error?.code === 'compose_close_accepted_cleanup_pending') throw error;
      throw lifecycleAcceptedCleanupPending('close');
    }
    const exposedError = normalizeExternalLifecycleError(error);
    await releaseClaim(input, session, deps, exposedError);
    throw exposedError;
  }

  broadcastLifecycleInvalidation(deps, input.userId, 'closed', session);
  return {
    closed: true,
    slot: session.slot,
    draft: saved ? {
      accountId: saveAccount.id,
      account: saveAccount.email_address,
      uid: saved.uid,
      folder: saved.folder,
      messageId: saved.messageId,
    } : null,
  };
}

function sourceDraftDeleteContract(session) {
  if (session.sourceDraftUid == null
      || !session.sourceDraftFolder
      || !session.sourceDraftAccountId) return null;
  return {
    accountId: session.sourceDraftAccountId,
    uid: session.sourceDraftUid,
    folder: session.sourceDraftFolder,
  };
}

function composeSessionRestoreContract(session) {
  const canonical = canonicalCompose(session);
  const changes = { ...canonical };
  delete changes.attachments;
  return {
    version: 1,
    originalSessionId: session.id,
    preferredSlot: session.slot,
    // Uploaded bytes are restored as child rows, never as editable fields.
    changes,
    replyAllRecipients: normalizedList(session.replyAllRecipients),
    sourceDraft: session.sourceDraftAccountId
      && session.sourceDraftFolder
      && session.sourceDraftUid != null
      ? {
        accountId: session.sourceDraftAccountId,
        folder: session.sourceDraftFolder,
        uid: session.sourceDraftUid,
        messageId: session.sourceDraftMessageId ?? null,
        initialRevision: session.sourceInitialRevision ?? null,
      }
      : null,
    attachments: (Array.isArray(session.attachments) ? session.attachments : []).map(attachment => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteCount: attachment.byteCount,
      contentSha256: attachmentContentSha256(attachment),
    })),
  };
}

const COMPOSE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeComposeIdempotencyKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !COMPOSE_IDEMPOTENCY_KEY_RE.test(value)) {
    throw composeSessionError(
      'invalid_compose_idempotency_key',
      'X-Idempotency-Key must be 1-128 safe opaque characters',
      400,
    );
  }
  return value;
}

function composeSendKey(input, session) {
  const callerKey = normalizeComposeIdempotencyKey(input.idempotencyKey);
  if (!callerKey) return `compose-session:${session.id}`;
  const digest = createHash('sha256').update(callerKey, 'utf8').digest('hex');
  return `compose-session:${session.id}:${digest}`;
}

function invalidSendAcceptance() {
  return Object.assign(new Error('Send service did not accept the compose session'), {
    code: 'compose_send_unaccepted',
    status: 500,
    expose: false,
  });
}

function acceptedCleanupPending() {
  return Object.assign(new Error('The message was accepted but compose cleanup is still pending'), {
    code: 'compose_send_accepted_cleanup_pending',
    status: 500,
    expose: false,
  });
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'unknown';
}

export async function sendComposeSession(input, deps) {
  const claim = lifecycleMethod(
    deps,
    'claimComposeOperation',
    composeSessionService.claimComposeOperation,
  );
  const claimed = await claim({
    userId: input.userId,
    id: input.id,
    slot: input.slot,
    expectedRevision: input.expectedRevision,
    operation: 'sending',
    changes: {},
  }, deps);
  const session = { ...claimed, userId: input.userId };
  let result;
  let immediate;
  let queued;
  let deleteDraftOnSend;
  let sourceAccount;

  try {
    const idempotencyKey = composeSendKey(input, session);
    if (!session.accountId) {
      throw composeSessionError(
        'compose_account_required',
        'A sending account is required',
        400,
      );
    }
    if (![session.to, session.cc, session.bcc].some(list => (
      Array.isArray(list) && list.some(recipient => typeof recipient === 'string' && recipient.trim())
    ))) {
      throw composeSessionError(
        'compose_recipients_required',
        'At least one recipient is required',
        400,
      );
    }

    const [account, preferenceResult] = await Promise.all([
      resolveOwnedAccount(session.accountId, input.userId, deps),
      deps.query('SELECT preferences FROM users WHERE id=$1 LIMIT 1', [input.userId]),
    ]);
    const preferences = jsonValue(preferenceResult.rows[0]?.preferences, {});
    const normalizeUndoWindow = outboxMethod(
      deps,
      'normalizeUndoWindow',
      outboxService.normalizeUndoWindow,
    );
    const undoSeconds = normalizeUndoWindow(
      input.undoSendSeconds,
      preferences.undoSendSeconds,
    );
    deleteDraftOnSend = sourceDraftDeleteContract(session);
    sourceAccount = deleteDraftOnSend
      ? (deleteDraftOnSend.accountId === account.id
        ? account
        : await resolveOwnedAccount(deleteDraftOnSend.accountId, input.userId, deps))
      : null;
    const sendOrEnqueue = sendMethod(deps, 'sendOrEnqueue', sendService.sendOrEnqueue);
    result = await sendOrEnqueue({
      ...sessionToComposeInput(session, account, { userId: input.userId }),
      ...(undoSeconds > 0 ? {
        composeSessionRestore: composeSessionRestoreContract(session),
      } : {}),
      plaintextEmail: preferences.plaintextEmail === true,
      undoSeconds,
      idempotencyKey,
      ...(deleteDraftOnSend ? { deleteDraftOnSend } : {}),
    }, deps);

    immediate = result?.ok === true;
    queued = result?.queued === true
      && typeof result.outboxId === 'string'
      && result.outboxId.length > 0;
    if (immediate === queued) throw invalidSendAcceptance();
  } catch (error) {
    await releaseClaim(input, session, deps, error);
    throw error;
  }

  if (immediate && deleteDraftOnSend) {
    const deleteDraft = draftMethod(deps, 'deleteDraft', draftService.deleteDraft);
    try {
      await deleteDraft({
        account: sourceAccount,
        uid: deleteDraftOnSend.uid,
        folder: deleteDraftOnSend.folder,
      }, deps);
    } catch (error) {
      console.error('Compose source cleanup failed after accepted send', {
        code: safeErrorCode(error),
      });
    }
  }

  const deleteClaimed = lifecycleMethod(
    deps,
    'deleteClaimedComposeSession',
    composeSessionService.deleteClaimedComposeSession,
  );
  try {
    const deleted = await deleteClaimed({
      userId: input.userId,
      id: session.id,
      token: session.operationToken,
    }, deps);
    if (!deleted) {
      const remaining = await deps.query(
        `SELECT operation_state, operation_token
           FROM compose_sessions
          WHERE id=$1 AND user_id=$2
          LIMIT 1`,
        [session.id, input.userId],
      );
      if (remaining.rows.length) throw acceptedCleanupPending();
    }
  } catch (error) {
    if (error?.code === 'compose_send_accepted_cleanup_pending') throw error;
    throw acceptedCleanupPending();
  }

  broadcastLifecycleInvalidation(
    deps,
    input.userId,
    queued ? 'queued' : 'sent',
    session,
  );
  return result;
}

export async function discardComposeSession(input, deps) {
  const claim = lifecycleMethod(
    deps,
    'claimComposeOperation',
    composeSessionService.claimComposeOperation,
  );
  const claimed = await claim({
    userId: input.userId,
    id: input.id,
    slot: input.slot,
    expectedRevision: input.expectedRevision,
    operation: 'discarding',
    changes: {},
  }, deps);
  const session = { ...claimed, userId: input.userId };
  let accepted = false;
  try {
    const hasSource = session.sourceDraftUid != null
      && session.sourceDraftFolder
      && session.sourceDraftAccountId;
    if (hasSource) {
      const account = await resolveOwnedAccount(
        session.sourceDraftAccountId,
        input.userId,
        deps,
      );
      const deleteDraft = draftMethod(deps, 'deleteDraft', draftService.deleteDraft);
      const deletion = await deleteDraft({
        account,
        uid: session.sourceDraftUid,
        folder: session.sourceDraftFolder,
        reportDeletionAcceptance: true,
      }, deps);
      accepted = true;
      if (deletion?.localCleanupPending === true) {
        throw lifecycleAcceptedCleanupPending('discard');
      }
    }

    await deleteTerminalComposeSession(input, session, deps, accepted);
  } catch (error) {
    if (accepted) {
      if (error?.code === 'compose_discard_accepted_cleanup_pending') throw error;
      throw lifecycleAcceptedCleanupPending('discard');
    }
    const exposedError = normalizeExternalLifecycleError(error);
    await releaseClaim(input, session, deps, exposedError);
    throw exposedError;
  }

  broadcastLifecycleInvalidation(deps, input.userId, 'discarded', session);
  return { discarded: true, slot: session.slot };
}
