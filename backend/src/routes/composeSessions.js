import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query, withTransaction } from '../services/db.js';
import { redisClient as defaultRedisClient } from '../services/redis.js';
import * as composeSessionService from '../services/composeSessionService.js';
import * as composeSessionLifecycle from '../services/composeSessionLifecycle.js';
import * as defaultOutboxService from '../services/outboxService.js';
import * as defaultDraftService from '../services/draftService.js';
import {
  normalizeComposeChanges,
  normalizeComposeClientId,
  normalizeReplyAllRecipients,
} from '../services/composeSessionModel.js';
import { UUID_RE } from '../utils/validation.js';

const EXPOSED_STATUSES = new Set([400, 404, 409, 413, 415, 422]);
const SERVICE_METHODS = [
  'listComposeSessions',
  'createComposeSession',
  'claimDraftIntoComposeSession',
  'getComposeSession',
  'patchComposeSession',
  'setComposePresentation',
  'addComposeAttachment',
  'removeComposeAttachment',
  'closeComposeSession',
  'discardComposeSession',
  'sendComposeSession',
  'restoreQueuedComposeSession',
];

function requestError(code, message, status = 400) {
  return Object.assign(new Error(message), {
    code,
    status,
    details: {},
    expose: true,
  });
}

function parseUuid(value, kind) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    const attachment = kind === 'attachment';
    throw requestError(
      attachment ? 'invalid_compose_attachment_id' : 'invalid_compose_session_id',
      attachment
        ? 'Compose attachment id must be a UUID'
        : 'Compose session id must be a UUID',
    );
  }
  return value;
}

function parseClaimAccountId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw requestError('invalid_compose_account_id', 'accountId must be a UUID');
  }
  return value;
}

function parseOutboxId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw requestError('invalid_compose_outbox_id', 'Outbox id must be a UUID');
  }
  return value;
}

function parseClaimFolder(value) {
  if (typeof value !== 'string'
      || !value.trim()
      || value.length > 500
      || /[\r\n\0]/.test(value)
      || value.trim() !== value) {
    throw requestError(
      'invalid_compose_draft_folder',
      'folder must be a non-empty folder path',
    );
  }
  return value;
}

function parseClaimUid(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw requestError('invalid_compose_draft_uid', 'uid must be a positive integer');
  }
  return value;
}

function parseRequestedSlot(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 9) {
    throw requestError(
      'invalid_compose_slot',
      'requestedSlot must be an integer from 1 to 9',
    );
  }
  return value;
}

function parseChanges(body) {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    && Object.hasOwn(body, 'changes')
    ? body.changes
    : {};
  return normalizeComposeChanges(value);
}

function parseExpectedRevision(value) {
  const decimalString = typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
  const revision = decimalString ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw requestError(
      'invalid_compose_revision',
      'expectedRevision must be a positive integer',
    );
  }
  return revision;
}

function parseUndoSendSeconds(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 120) {
    throw requestError(
      'invalid_compose_undo_seconds',
      'undoSendSeconds must be an integer from 0 to 120',
    );
  }
  return value;
}

function lifecycleDependencies(deps, req) {
  return deps.imapManager
    ? deps
    : { ...deps, imapManager: req.app.get('imapManager') };
}

async function sendLifecycleDependencies(deps, req) {
  const refreshMicrosoftToken = deps.refreshMicrosoftToken
    || (await import('./oauth.js')).refreshMicrosoftToken;
  return {
    ...lifecycleDependencies(deps, req),
    redisClient: deps.redisClient || defaultRedisClient,
    refreshMicrosoftToken,
    outboxService: deps.outboxService || defaultOutboxService,
    draftService: deps.draftService || defaultDraftService,
  };
}

function decodeAttachmentFilename(value) {
  try {
    return decodeURIComponent(value || 'attachment');
  } catch {
    throw requestError(
      'invalid_attachment_filename',
      'X-Mailflow-Filename must be valid percent encoding',
    );
  }
}

function route(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (
        error?.expose === true
        && EXPOSED_STATUSES.has(error.status)
        && typeof error.code === 'string'
      ) {
        const details = error.details
          && typeof error.details === 'object'
          && !Array.isArray(error.details)
          ? error.details
          : {};
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...details,
        });
      }
      next(error);
    }
  };
}

export function createComposeSessionsRouter(deps = {}) {
  const defaultServices = { ...composeSessionService, ...composeSessionLifecycle };
  const services = Object.fromEntries(SERVICE_METHODS.map(name => [
    name,
    typeof deps[name] === 'function' ? deps[name] : defaultServices[name],
  ]));
  const router = Router();
  router.use(requireAuth);

  router.get('/', route(async (req, res) => {
    const sessions = await services.listComposeSessions({
      userId: req.session.userId,
    }, deps);
    res.json(sessions);
  }));

  router.post('/', route(async (req, res) => {
    const body = req.body || {};
    const session = await services.createComposeSession({
      userId: req.session.userId,
      requestedSlot: body.requestedSlot,
      changes: parseChanges(body),
      ...(body.replyAllRecipients === undefined ? {} : {
        replyAllRecipients: normalizeReplyAllRecipients(body.replyAllRecipients),
      }),
      clientId: normalizeComposeClientId(body.clientId),
    }, deps);
    res.status(201).json(session);
  }));

  router.post('/claim-draft', route(async (req, res) => {
    const body = req.body || {};
    const lifecycleDeps = lifecycleDependencies(deps, req);
    const session = await services.claimDraftIntoComposeSession({
      userId: req.session.userId,
      accountId: parseClaimAccountId(body.accountId),
      folder: parseClaimFolder(body.folder),
      uid: parseClaimUid(body.uid),
      requestedSlot: parseRequestedSlot(body.requestedSlot),
      replyAllRecipients: normalizeReplyAllRecipients(body.replyAllRecipients ?? []),
    }, lifecycleDeps);
    res.status(201).json(session);
  }));

  router.post('/:id/close', route(async (req, res) => {
    const body = req.body || {};
    const lifecycleDeps = lifecycleDependencies(deps, req);
    const result = await services.closeComposeSession({
      userId: req.session.userId,
      id: parseUuid(req.params.id, 'session'),
      expectedRevision: parseExpectedRevision(body.expectedRevision),
      changes: parseChanges(body),
    }, lifecycleDeps);
    res.json(result);
  }));

  router.post('/:id/discard', route(async (req, res) => {
    const body = req.body || {};
    const lifecycleDeps = lifecycleDependencies(deps, req);
    const result = await services.discardComposeSession({
      userId: req.session.userId,
      id: parseUuid(req.params.id, 'session'),
      expectedRevision: parseExpectedRevision(body.expectedRevision),
    }, lifecycleDeps);
    res.json(result);
  }));

  router.post('/:id/send', route(async (req, res) => {
    const body = req.body || {};
    const result = await services.sendComposeSession({
      userId: req.session.userId,
      id: parseUuid(req.params.id, 'session'),
      expectedRevision: parseExpectedRevision(body.expectedRevision),
      undoSendSeconds: parseUndoSendSeconds(body.undoSendSeconds),
      idempotencyKey: composeSessionLifecycle.normalizeComposeIdempotencyKey(
        typeof req.headers['x-idempotency-key'] === 'string'
          ? req.headers['x-idempotency-key']
          : null,
      ),
    }, await sendLifecycleDependencies(deps, req));
    res.status(result?.queued === true ? 202 : 200).json(result);
  }));

  router.post('/outbox/:outboxId/restore', route(async (req, res) => {
    const result = await services.restoreQueuedComposeSession({
      userId: req.session.userId,
      outboxId: parseOutboxId(req.params.outboxId),
    }, deps);
    res.json(result);
  }));

  router.get('/:id', route(async (req, res) => {
    const session = await services.getComposeSession({
      userId: req.session.userId,
      id: parseUuid(req.params.id, 'session'),
    }, deps);
    res.json(session);
  }));

  router.patch('/:id', route(async (req, res) => {
    const body = req.body || {};
    const session = await services.patchComposeSession({
      userId: req.session.userId,
      id: parseUuid(req.params.id, 'session'),
      expectedRevision: parseExpectedRevision(body.expectedRevision),
      changes: parseChanges(body),
      clientId: normalizeComposeClientId(body.clientId),
    }, deps);
    res.json(session);
  }));

  router.put('/:id/presentation', route(async (req, res) => {
    const body = req.body || {};
    const session = await services.setComposePresentation({
      userId: req.session.userId,
      id: parseUuid(req.params.id, 'session'),
      expectedRevision: parseExpectedRevision(body.expectedRevision),
      state: body.state,
      clientId: normalizeComposeClientId(body.clientId),
    }, deps);
    res.json(session);
  }));

  router.post('/:id/attachments', route(async (req, res) => {
    const id = parseUuid(req.params.id, 'session');
    const mediaType = req.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/octet-stream') {
      throw requestError(
        'unsupported_attachment_media_type',
        'Content-Type must be application/octet-stream',
        415,
      );
    }
    if (!Buffer.isBuffer(req.body)) {
      throw requestError('invalid_attachment_body', 'Attachment body must be raw bytes');
    }
    const result = await services.addComposeAttachment({
      userId: req.session.userId,
      id,
      expectedRevision: parseExpectedRevision(
        req.get('X-Mailflow-Expected-Revision') ?? req.query.expectedRevision,
      ),
      filename: decodeAttachmentFilename(req.get('X-Mailflow-Filename')),
      contentType: req.get('X-Mailflow-Content-Type') || 'application/octet-stream',
      content: req.body,
      clientId: normalizeComposeClientId(req.get('X-Mailflow-Client-Id')),
    }, deps);
    res.status(201).json(result);
  }));

  router.delete('/:id/attachments/:attachmentId', route(async (req, res) => {
    const body = req.body || {};
    const result = await services.removeComposeAttachment({
      userId: req.session.userId,
      id: parseUuid(req.params.id, 'session'),
      attachmentId: parseUuid(req.params.attachmentId, 'attachment'),
      expectedRevision: parseExpectedRevision(body.expectedRevision),
      clientId: normalizeComposeClientId(body.clientId),
    }, deps);
    res.json(result);
  }));

  return router;
}

export default createComposeSessionsRouter({ query, withTransaction });
