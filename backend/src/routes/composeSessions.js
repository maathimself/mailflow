import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query, withTransaction } from '../services/db.js';
import * as composeSessionService from '../services/composeSessionService.js';
import {
  normalizeComposeChanges,
  normalizeComposeClientId,
} from '../services/composeSessionModel.js';
import { UUID_RE } from '../utils/validation.js';

const EXPOSED_STATUSES = new Set([400, 404, 409, 413, 415]);
const SERVICE_METHODS = [
  'listComposeSessions',
  'createComposeSession',
  'getComposeSession',
  'patchComposeSession',
  'setComposePresentation',
  'addComposeAttachment',
  'removeComposeAttachment',
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
  const services = Object.fromEntries(SERVICE_METHODS.map(name => [
    name,
    typeof deps[name] === 'function' ? deps[name] : composeSessionService[name],
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
      clientId: normalizeComposeClientId(body.clientId),
    }, deps);
    res.status(201).json(session);
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
