import {
  MAX_COMPOSE_ATTACHMENT_BYTES,
  MAX_COMPOSE_ATTACHMENTS,
  composeSessionError,
  findComposeConflicts,
  normalizeComposeChanges,
  normalizeComposeClientId,
} from './composeSessionModel.js';
import { sanitizeHeaderValue } from './mail/addresses.js';
import { UUID_RE } from '../utils/validation.js';

const FIELD_COLUMNS = Object.freeze({
  accountId: 'account_id',
  aliasId: 'alias_id',
  mode: 'mode',
  to: 'to_recipients',
  cc: 'cc_recipients',
  bcc: 'bcc_recipients',
  subject: 'subject',
  body: 'body',
  bodyIsHtml: 'body_is_html',
  quotedBody: 'quoted_body',
  quotedBodyHtml: 'quoted_body_html',
  editedSignature: 'edited_signature',
  forwardedAttachments: 'forwarded_attachments',
  priority: 'priority',
  inReplyTo: 'in_reply_to',
  references: 'thread_references',
  fromChanged: 'from_changed',
});

const JSON_FIELDS = new Set(['to', 'cc', 'bcc', 'forwardedAttachments', 'references']);
const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

const NEW_SESSION_DEFAULTS = Object.freeze({
  accountId: null,
  aliasId: null,
  mode: 'new',
  to: [],
  cc: [],
  bcc: [],
  subject: '',
  body: '',
  bodyIsHtml: true,
  quotedBody: null,
  quotedBodyHtml: null,
  editedSignature: null,
  forwardedAttachments: [],
  priority: 'normal',
  inReplyTo: null,
  references: [],
  fromChanged: false,
});

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapSessionRow(row) {
  return {
    id: row.id,
    slot: Number(row.slot),
    accountId: row.account_id,
    aliasId: row.alias_id,
    mode: row.mode,
    to: jsonValue(row.to_recipients, []),
    cc: jsonValue(row.cc_recipients, []),
    bcc: jsonValue(row.bcc_recipients, []),
    subject: row.subject,
    body: row.body,
    bodyIsHtml: row.body_is_html,
    quotedBody: row.quoted_body,
    quotedBodyHtml: row.quoted_body_html,
    editedSignature: row.edited_signature,
    forwardedAttachments: jsonValue(row.forwarded_attachments, []),
    priority: row.priority,
    inReplyTo: row.in_reply_to,
    references: jsonValue(row.thread_references, []),
    fromChanged: row.from_changed,
    sourceDraftAccountId: row.source_draft_account_id,
    sourceDraftFolder: row.source_draft_folder,
    sourceDraftUid: row.source_draft_uid,
    sourceDraftMessageId: row.source_draft_message_id,
    sourceInitialRevision: jsonValue(row.source_initial_revision, null),
    presentationState: row.presentation_state,
    operationState: row.operation_state,
    operationToken: row.operation_token,
    revision: Number(row.revision),
    fieldRevisions: jsonValue(row.field_revisions, {}),
    lastFocusedAt: row.last_focused_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSummaryRow(row) {
  return {
    id: row.id,
    slot: Number(row.slot),
    accountId: row.account_id,
    aliasId: row.alias_id,
    mode: row.mode,
    subject: row.subject,
    priority: row.priority,
    presentationState: row.presentation_state,
    operationState: row.operation_state,
    revision: Number(row.revision),
    lastFocusedAt: row.last_focused_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentCount: Number(row.attachment_count || 0),
  };
}

function mapAttachmentRow(row) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    byteCount: Number(row.byte_count),
    createdAt: row.created_at,
  };
}

function sanitizeAttachmentFilename(filename) {
  if (typeof filename !== 'string') {
    throw composeSessionError(
      'invalid_attachment_filename',
      'Attachment filename must be a non-empty string',
    );
  }
  const sanitized = sanitizeHeaderValue(filename);
  if (!sanitized || sanitized.length > 255) {
    throw composeSessionError(
      'invalid_attachment_filename',
      'Attachment filename must be a non-empty string of at most 255 characters',
    );
  }
  return sanitized;
}

function normalizeAttachmentInput(input) {
  if (!Buffer.isBuffer(input.content)) {
    throw composeSessionError('invalid_attachment_body', 'Attachment body must be raw bytes');
  }
  const filename = sanitizeAttachmentFilename(input.filename);
  const contentType = input.contentType ?? 'application/octet-stream';
  if (typeof contentType !== 'string'
      || contentType.length > 127
      || !MIME_TYPE_RE.test(contentType)) {
    throw composeSessionError(
      'invalid_attachment_content_type',
      'Attachment content type must be a valid MIME type',
    );
  }
  return { content: Buffer.from(input.content), filename, contentType };
}

function sessionNotFound() {
  return composeSessionError('compose_session_not_found', 'Compose session not found', 404);
}

function requireLocator(input) {
  const hasId = input.id !== undefined && input.id !== null;
  const hasSlot = input.slot !== undefined && input.slot !== null;
  if (hasId === hasSlot) {
    throw composeSessionError(
      'invalid_compose_locator',
      'Exactly one compose session id or slot is required',
      400,
    );
  }
  if (hasId && (typeof input.id !== 'string' || !UUID_RE.test(input.id))) {
    throw composeSessionError(
      'invalid_compose_locator',
      'Compose session id must be a UUID',
      400,
    );
  }
  if (hasSlot && (!Number.isInteger(input.slot) || input.slot < 1 || input.slot > 9)) {
    throw composeSessionError('invalid_compose_locator', 'slot must be an integer from 1 to 9', 400);
  }
  return hasId
    ? { column: 'id', value: input.id }
    : { column: 'slot', value: input.slot };
}

function requireAttachmentId(attachmentId) {
  if (typeof attachmentId !== 'string' || !UUID_RE.test(attachmentId)) {
    throw composeSessionError(
      'invalid_compose_attachment_id',
      'Compose attachment id must be a UUID',
      400,
    );
  }
  return attachmentId;
}

function requireExpectedRevision(expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw composeSessionError(
      'invalid_compose_revision',
      'expectedRevision must be a positive integer',
      400,
    );
  }
  return expectedRevision;
}

async function lockOwnedSession(client, input) {
  const locator = requireLocator(input);
  const result = await client.query(
    `SELECT * FROM compose_sessions WHERE ${locator.column}=$1 AND user_id=$2 FOR UPDATE`,
    [locator.value, input.userId],
  );
  if (!result.rows.length) throw sessionNotFound();
  return { locator, row: result.rows[0] };
}

function ensureIdle(row) {
  if (row.operation_state !== 'idle') {
    throw composeSessionError(
      'compose_operation_in_progress',
      'A terminal compose operation is already in progress',
      409,
    );
  }
}

function remoteValues(row, fields) {
  const session = mapSessionRow(row);
  return Object.fromEntries(fields.map(field => [field, session[field]]));
}

function ensureNoConflicts(row, expectedRevision, fields) {
  const currentRevision = Number(row.revision);
  let conflictingFields = findComposeConflicts(
    jsonValue(row.field_revisions, {}),
    expectedRevision,
    fields,
  );
  if (expectedRevision > currentRevision) conflictingFields = [...fields];
  if (!conflictingFields.length) return;
  throw composeSessionError(
    'compose_conflict',
    'Compose session changed in the requested fields',
    409,
    {
      conflictingFields,
      currentRevision,
      remoteValues: remoteValues(row, conflictingFields),
    },
  );
}

async function validateIdentity(client, userId, accountId, aliasId) {
  if (accountId != null) {
    const account = await client.query(
      'SELECT id FROM email_accounts WHERE id=$1 AND user_id=$2',
      [accountId, userId],
    );
    if (!account.rows.length) {
      throw composeSessionError(
        'compose_account_not_found',
        'Compose account not found',
        404,
      );
    }
  }

  if (aliasId != null) {
    if (accountId == null) {
      throw composeSessionError('compose_alias_not_found', 'Compose alias not found', 404);
    }
    const alias = await client.query(
      `SELECT aa.id
         FROM account_aliases aa
         JOIN email_accounts ea ON ea.id=aa.account_id
        WHERE aa.id=$1 AND aa.account_id=$2 AND ea.user_id=$3`,
      [aliasId, accountId, userId],
    );
    if (!alias.rows.length) {
      throw composeSessionError('compose_alias_not_found', 'Compose alias not found', 404);
    }
  }
}

function broadcastInvalidation(deps, userId, action, session, clientId) {
  if (typeof deps.broadcast !== 'function') return;
  const payload = {
    type: 'compose_sessions_updated',
    action,
    sessionId: session.id,
    slot: session.slot,
    revision: session.revision,
  };
  if (clientId) payload.clientId = clientId;
  deps.broadcast(payload, userId);
}

async function advanceAttachmentRevision(client, locator, row, userId) {
  const revision = Number(row.revision) + 1;
  const fieldRevisions = {
    ...jsonValue(row.field_revisions, {}),
    attachments: revision,
  };
  const updated = await client.query(
    `UPDATE compose_sessions
        SET field_revisions=$1::jsonb, revision=revision + 1, updated_at=NOW()
      WHERE ${locator.column}=$2 AND user_id=$3
    RETURNING *`,
    [JSON.stringify(fieldRevisions), locator.value, userId],
  );
  return mapSessionRow(updated.rows[0]);
}

export async function createComposeSession(input, deps) {
  const requestedSlot = input.requestedSlot ?? null;
  if (requestedSlot !== null
      && (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > 9)) {
    throw composeSessionError(
      'invalid_compose_slot',
      'requestedSlot must be an integer from 1 to 9',
      400,
    );
  }

  const changes = normalizeComposeChanges(
    input.changes === undefined ? {} : input.changes,
  );
  const clientId = normalizeComposeClientId(input.clientId);
  const values = { ...NEW_SESSION_DEFAULTS, ...changes };
  const result = await deps.withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`compose-slots:${input.userId}`],
    );
    await validateIdentity(client, input.userId, values.accountId, values.aliasId);

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

    const touched = Object.keys(changes);
    const fieldRevisions = Object.fromEntries(touched.map(field => [field, 1]));
    const inserted = await client.query(
      `INSERT INTO compose_sessions (
         user_id, slot, account_id, alias_id, mode,
         to_recipients, cc_recipients, bcc_recipients, subject, body,
         body_is_html, quoted_body, quoted_body_html, edited_signature,
         forwarded_attachments, priority, in_reply_to, thread_references,
         from_changed, field_revisions
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7::jsonb, $8::jsonb, $9, $10,
         $11, $12, $13, $14,
         $15::jsonb, $16, $17, $18::jsonb,
         $19, $20::jsonb
       )
       RETURNING *`,
      [
        input.userId,
        Number(slot),
        values.accountId,
        values.aliasId,
        values.mode,
        JSON.stringify(values.to),
        JSON.stringify(values.cc),
        JSON.stringify(values.bcc),
        values.subject,
        values.body,
        values.bodyIsHtml,
        values.quotedBody,
        values.quotedBodyHtml,
        values.editedSignature,
        JSON.stringify(values.forwardedAttachments),
        values.priority,
        values.inReplyTo,
        JSON.stringify(values.references),
        values.fromChanged,
        JSON.stringify(fieldRevisions),
      ],
    );
    return mapSessionRow(inserted.rows[0]);
  });

  broadcastInvalidation(deps, input.userId, 'created', result, clientId);
  return result;
}

export async function patchComposeSession(input, deps) {
  requireExpectedRevision(input.expectedRevision);
  const changes = normalizeComposeChanges(
    input.changes === undefined ? {} : input.changes,
  );
  const clientId = normalizeComposeClientId(input.clientId);
  const result = await deps.withTransaction(async (client) => {
    const { locator, row } = await lockOwnedSession(client, input);
    ensureIdle(row);
    const fields = Object.keys(changes);
    if (!fields.length) return { session: mapSessionRow(row), changed: false };

    ensureNoConflicts(row, input.expectedRevision, fields);
    const accountId = Object.hasOwn(changes, 'accountId')
      ? changes.accountId
      : row.account_id;
    const aliasId = Object.hasOwn(changes, 'aliasId')
      ? changes.aliasId
      : row.alias_id;
    if (Object.hasOwn(changes, 'accountId') || Object.hasOwn(changes, 'aliasId')) {
      await validateIdentity(client, input.userId, accountId, aliasId);
    }

    const params = [];
    const assignments = fields.map((field) => {
      const column = FIELD_COLUMNS[field];
      const value = JSON_FIELDS.has(field) ? JSON.stringify(changes[field]) : changes[field];
      params.push(value);
      return `${column}=$${params.length}${JSON_FIELDS.has(field) ? '::jsonb' : ''}`;
    });
    const revision = Number(row.revision) + 1;
    const fieldRevisions = {
      ...jsonValue(row.field_revisions, {}),
      ...Object.fromEntries(fields.map(field => [field, revision])),
    };
    params.push(JSON.stringify(fieldRevisions));
    assignments.push(`field_revisions=$${params.length}::jsonb`);
    assignments.push('revision=revision + 1', 'updated_at=NOW()');
    params.push(locator.value, input.userId);

    const updated = await client.query(
      `UPDATE compose_sessions
          SET ${assignments.join(', ')}
        WHERE ${locator.column}=$${params.length - 1} AND user_id=$${params.length}
      RETURNING *`,
      params,
    );
    return { session: mapSessionRow(updated.rows[0]), changed: true };
  });

  if (result.changed) {
    broadcastInvalidation(deps, input.userId, 'updated', result.session, clientId);
  }
  return result.session;
}

export async function listComposeSessions({ userId }, deps) {
  const result = await deps.query(
    `SELECT cs.id, cs.slot, cs.account_id, cs.alias_id, cs.mode, cs.subject,
            cs.priority, cs.presentation_state, cs.operation_state, cs.revision,
            cs.last_focused_at, cs.created_at, cs.updated_at,
            COUNT(csa.id)::int AS attachment_count
       FROM compose_sessions cs
       LEFT JOIN compose_session_attachments csa ON csa.session_id=cs.id
      WHERE cs.user_id=$1
      GROUP BY cs.id
      ORDER BY cs.slot`,
    [userId],
  );
  return result.rows.map(mapSummaryRow);
}

export async function getComposeSession(input, deps) {
  const locator = requireLocator(input);
  const result = await deps.query(
    `SELECT * FROM compose_sessions WHERE ${locator.column}=$1 AND user_id=$2`,
    [locator.value, input.userId],
  );
  if (!result.rows.length) throw sessionNotFound();
  const session = mapSessionRow(result.rows[0]);
  const attachmentResult = await deps.query(
    `SELECT id, filename, content_type, byte_count, created_at
       FROM compose_session_attachments
      WHERE session_id=$1
      ORDER BY created_at, id`,
    [session.id],
  );
  return { ...session, attachments: attachmentResult.rows.map(mapAttachmentRow) };
}

export async function setComposePresentation(input, deps) {
  requireExpectedRevision(input.expectedRevision);
  const clientId = normalizeComposeClientId(input.clientId);
  const state = input.state ?? input.presentationState;
  if (!['expanded', 'minimized'].includes(state)) {
    throw composeSessionError(
      'invalid_presentation_state',
      'state must be expanded or minimized',
      400,
    );
  }

  const session = await deps.withTransaction(async (client) => {
    const { locator, row } = await lockOwnedSession(client, input);
    ensureIdle(row);
    ensureNoConflicts(row, input.expectedRevision, ['presentationState']);
    const revision = Number(row.revision) + 1;
    const fieldRevisions = {
      ...jsonValue(row.field_revisions, {}),
      presentationState: revision,
    };
    const params = [state, JSON.stringify(fieldRevisions), locator.value, input.userId];
    const focusAssignment = state === 'expanded' ? ', last_focused_at=NOW()' : '';
    const updated = await client.query(
      `UPDATE compose_sessions
          SET presentation_state=$1, field_revisions=$2::jsonb,
              revision=revision + 1${focusAssignment}, updated_at=NOW()
        WHERE ${locator.column}=$3 AND user_id=$4
      RETURNING *`,
      params,
    );
    return mapSessionRow(updated.rows[0]);
  });

  broadcastInvalidation(deps, input.userId, 'presentation', session, clientId);
  return session;
}

export async function addComposeAttachment(input, deps) {
  requireExpectedRevision(input.expectedRevision);
  const { content, filename, contentType } = normalizeAttachmentInput(input);
  const clientId = normalizeComposeClientId(input.clientId);

  const result = await deps.withTransaction(async (client) => {
    const { locator, row } = await lockOwnedSession(client, input);
    ensureIdle(row);
    ensureNoConflicts(row, input.expectedRevision, ['attachments']);

    const aggregate = await client.query(
      `SELECT COUNT(*)::int AS attachment_count,
              COALESCE(SUM(byte_count), 0)::bigint AS total_bytes
         FROM compose_session_attachments
        WHERE session_id=$1`,
      [row.id],
    );
    const attachmentCount = Number(aggregate.rows[0]?.attachment_count || 0);
    const totalBytes = Number(aggregate.rows[0]?.total_bytes || 0);
    if (attachmentCount >= MAX_COMPOSE_ATTACHMENTS) {
      throw composeSessionError(
        'attachment_count_limit',
        'Compose sessions support at most 100 attachments',
        413,
      );
    }
    if (totalBytes + content.length > MAX_COMPOSE_ATTACHMENT_BYTES) {
      throw composeSessionError(
        'attachment_limit',
        'Compose attachments exceed the 25 MiB limit',
        413,
      );
    }

    const inserted = await client.query(
      `INSERT INTO compose_session_attachments (
         session_id, filename, content_type, byte_count, content
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, filename, content_type, byte_count, created_at`,
      [row.id, filename, contentType, content.length, content],
    );
    const session = await advanceAttachmentRevision(client, locator, row, input.userId);
    return { attachment: mapAttachmentRow(inserted.rows[0]), session };
  });

  broadcastInvalidation(
    deps,
    input.userId,
    'attachment_added',
    result.session,
    clientId,
  );
  return {
    sessionId: result.session.id,
    slot: result.session.slot,
    revision: result.session.revision,
    attachment: result.attachment,
  };
}

export async function removeComposeAttachment(input, deps) {
  requireExpectedRevision(input.expectedRevision);
  requireAttachmentId(input.attachmentId);
  const clientId = normalizeComposeClientId(input.clientId);
  const result = await deps.withTransaction(async (client) => {
    const { locator, row } = await lockOwnedSession(client, input);
    ensureIdle(row);
    const existing = await client.query(
      `SELECT id FROM compose_session_attachments
        WHERE id=$1 AND session_id=$2`,
      [input.attachmentId, row.id],
    );
    if (!existing.rows.length) return { changed: false, session: mapSessionRow(row) };
    ensureNoConflicts(row, input.expectedRevision, ['attachments']);

    const deleted = await client.query(
      `DELETE FROM compose_session_attachments csa
       USING compose_sessions cs
       WHERE csa.id=$1
         AND csa.session_id=cs.id
         AND cs.id=$2
         AND cs.user_id=$3
       RETURNING csa.id`,
      [input.attachmentId, row.id, input.userId],
    );
    if (!deleted.rows.length) return { changed: false, session: mapSessionRow(row) };
    const session = await advanceAttachmentRevision(client, locator, row, input.userId);
    return { changed: true, session };
  });

  if (result.changed) {
    broadcastInvalidation(
      deps,
      input.userId,
      'attachment_removed',
      result.session,
      clientId,
    );
  }
  return {
    sessionId: result.session.id,
    slot: result.session.slot,
    revision: result.session.revision,
    removedAttachmentId: input.attachmentId,
  };
}
