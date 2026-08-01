import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    const userId = req.get('X-Test-User-Id');
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    req.session = { userId };
    next();
  },
}));

import { createComposeSessionsRouter } from './composeSessions.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const APP_IMAP_MANAGER = { fetchMessageBody: vi.fn(), fetchAttachment: vi.fn() };

function exposedError(code, message, status, details = {}) {
  return Object.assign(new Error(message), {
    code,
    status,
    details,
    expose: true,
  });
}

const deps = {
  query: vi.fn(),
  withTransaction: vi.fn(),
  broadcast: vi.fn(),
  listComposeSessions: vi.fn(),
  createComposeSession: vi.fn(),
  claimDraftIntoComposeSession: vi.fn(),
  getComposeSession: vi.fn(),
  patchComposeSession: vi.fn(),
  setComposePresentation: vi.fn(),
  addComposeAttachment: vi.fn(),
  removeComposeAttachment: vi.fn(),
  closeComposeSession: vi.fn(),
  discardComposeSession: vi.fn(),
  sendComposeSession: vi.fn(),
  restoreQueuedComposeSession: vi.fn(),
  redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  refreshMicrosoftToken: vi.fn(),
  outboxService: { enqueue: vi.fn(), normalizeUndoWindow: vi.fn() },
  draftService: { deleteDraft: vi.fn() },
};

function buildApp({ useRawParser = true } = {}) {
  const app = express();
  app.set('imapManager', APP_IMAP_MANAGER);
  if (useRawParser) {
    app.use(
      '/api/compose-sessions/:id/attachments',
      express.raw({ type: 'application/octet-stream', limit: '25mb' }),
    );
  }
  app.use('/api/compose-sessions', express.json({ limit: '35mb' }));
  app.use('/api/compose-sessions', createComposeSessionsRouter(deps));
  // Mirrors index.js's non-leaking final error response for unknown failures.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

async function request(base, method, path, { body, headers = {}, authenticated = true } = {}) {
  const requestHeaders = { ...headers };
  if (authenticated) requestHeaders['X-Test-User-Id'] = USER_ID;
  let requestBody = body;
  if (body !== undefined && !Buffer.isBuffer(body)) {
    requestHeaders['Content-Type'] ||= 'application/json';
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

describe('compose session routes', () => {
  let server;
  let base;

  beforeAll(async () => {
    server = buildApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    for (const value of Object.values(deps)) {
      if (typeof value?.mockReset === 'function') value.mockReset();
    }
  });

  it('requires authentication for the compose-session router', async () => {
    const response = await request(base, 'GET', '/api/compose-sessions', {
      authenticated: false,
    });

    expect(response).toEqual({ status: 401, body: { error: 'Not authenticated' } });
    expect(deps.listComposeSessions).not.toHaveBeenCalled();
  });

  it('restores a queued compose through the authenticated owner-scoped route', async () => {
    const restored = {
      restored: true,
      replayed: false,
      session: { id: SESSION_ID, slot: 2, attachments: [{ id: ATTACHMENT_ID }] },
    };
    deps.restoreQueuedComposeSession.mockResolvedValueOnce(restored);

    const response = await request(
      base,
      'POST',
      '/api/compose-sessions/outbox/55555555-5555-4555-8555-555555555555/restore',
      { body: {} },
    );

    expect(response).toEqual({ status: 200, body: restored });
    expect(deps.restoreQueuedComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      outboxId: '55555555-5555-4555-8555-555555555555',
    }, expect.objectContaining({ withTransaction: deps.withTransaction }));
  });

  it('maps explicit queued-restore outcomes without exposing payload bytes', async () => {
    deps.restoreQueuedComposeSession.mockRejectedValueOnce(exposedError(
      'compose_outbox_too_late',
      'Queued message can no longer be restored',
      409,
    ));
    const response = await request(
      base,
      'POST',
      '/api/compose-sessions/outbox/55555555-5555-4555-8555-555555555555/restore',
      { body: {} },
    );
    expect(response).toEqual({
      status: 409,
      body: {
        error: 'Queued message can no longer be restored',
        code: 'compose_outbox_too_late',
      },
    });
  });

  it.each([
    ['GET', '/api/compose-sessions/not-a-uuid', undefined, 'invalid_compose_session_id'],
    [
      'DELETE',
      `/api/compose-sessions/${SESSION_ID}/attachments/not-a-uuid`,
      { expectedRevision: 1 },
      'invalid_compose_attachment_id',
    ],
  ])('rejects malformed UUID route locators for %s %s', async (method, path, body, code) => {
    const response = await request(base, method, path, { body });

    expect(response).toEqual({
      status: 400,
      body: {
        error: code === 'invalid_compose_session_id'
          ? 'Compose session id must be a UUID'
          : 'Compose attachment id must be a UUID',
        code,
      },
    });
    expect(deps.getComposeSession).not.toHaveBeenCalled();
    expect(deps.removeComposeAttachment).not.toHaveBeenCalled();
  });

  it('lists only summaries returned for the authenticated user', async () => {
    const summaries = [{
      id: SESSION_ID,
      slot: 1,
      subject: 'Synthetic subject',
      revision: 2,
      attachmentCount: 1,
    }];
    deps.listComposeSessions.mockResolvedValueOnce(summaries);

    const response = await request(base, 'GET', '/api/compose-sessions');

    expect(response).toEqual({ status: 200, body: summaries });
    expect(deps.listComposeSessions).toHaveBeenCalledWith({ userId: USER_ID }, deps);
  });

  it('creates a session and returns the service shape with 201', async () => {
    const session = {
      id: SESSION_ID,
      slot: 4,
      subject: 'Synthetic subject',
      revision: 1,
    };
    deps.createComposeSession.mockResolvedValueOnce(session);

    const response = await request(base, 'POST', '/api/compose-sessions', {
      body: {
        requestedSlot: 4,
        changes: { subject: 'Synthetic subject' },
        clientId: 'browser-synthetic',
      },
    });

    expect(response).toEqual({ status: 201, body: session });
    expect(deps.createComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      requestedSlot: 4,
      changes: { subject: 'Synthetic subject' },
      clientId: 'browser-synthetic',
    }, deps);
  });

  it('accepts sanitized reply-all source recipients only at create', async () => {
    deps.createComposeSession.mockResolvedValueOnce({ id: SESSION_ID, slot: 1 });
    await request(base, 'POST', '/api/compose-sessions', {
      body: {
        changes: { mode: 'reply' },
        replyAllRecipients: [' Synthetic Copied <copied@example.com> '],
      },
    });
    expect(deps.createComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      requestedSlot: undefined,
      changes: { mode: 'reply' },
      replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
      clientId: undefined,
    }, deps);
  });

  it('claims an owned draft with strict transport values and production IMAP dependencies', async () => {
    const session = {
      id: SESSION_ID,
      slot: 3,
      accountId: ACCOUNT_ID,
      sourceDraftFolder: '[Synthetic]/Drafts',
      sourceDraftUid: 41,
      revision: 1,
    };
    deps.claimDraftIntoComposeSession.mockResolvedValueOnce(session);

    const response = await request(base, 'POST', '/api/compose-sessions/claim-draft', {
      body: {
        accountId: ACCOUNT_ID,
        folder: '[Synthetic]/Drafts',
        uid: 41,
        requestedSlot: 3,
        replyAllRecipients: [' Synthetic Copied <copied@example.com> '],
      },
    });

    expect(response).toEqual({ status: 201, body: session });
    expect(deps.claimDraftIntoComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      folder: '[Synthetic]/Drafts',
      uid: 41,
      requestedSlot: 3,
      replyAllRecipients: ['Synthetic Copied <copied@example.com>'],
    }, expect.objectContaining({
      query: deps.query,
      withTransaction: deps.withTransaction,
      imapManager: APP_IMAP_MANAGER,
    }));
  });

  it.each([0, -1, 1.5, '1', '1e2', null])(
    'rejects a non-positive or non-integer draft uid %#',
    async (uid) => {
      const response = await request(base, 'POST', '/api/compose-sessions/claim-draft', {
        body: { accountId: ACCOUNT_ID, folder: '[Synthetic]/Drafts', uid },
      });

      expect(response).toEqual({
        status: 400,
        body: {
          error: 'uid must be a positive integer',
          code: 'invalid_compose_draft_uid',
        },
      });
      expect(deps.claimDraftIntoComposeSession).not.toHaveBeenCalled();
    },
  );

  it.each([0, 10, 1.5, '1'])(
    'rejects an invalid requested claim slot %#',
    async (requestedSlot) => {
      const response = await request(base, 'POST', '/api/compose-sessions/claim-draft', {
        body: {
          accountId: ACCOUNT_ID,
          folder: '[Synthetic]/Drafts',
          uid: 41,
          requestedSlot,
        },
      });

      expect(response).toEqual({
        status: 400,
        body: {
          error: 'requestedSlot must be an integer from 1 to 9',
          code: 'invalid_compose_slot',
        },
      });
      expect(deps.claimDraftIntoComposeSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ accountId: 'not-a-uuid', folder: '[Synthetic]/Drafts', uid: 41 },
      'invalid_compose_account_id', 'accountId must be a UUID'],
    [{ accountId: ACCOUNT_ID, folder: '', uid: 41 },
      'invalid_compose_draft_folder', 'folder must be a non-empty folder path'],
  ])('rejects malformed claim locators %#', async (body, code, error) => {
    const response = await request(base, 'POST', '/api/compose-sessions/claim-draft', { body });

    expect(response).toEqual({ status: 400, body: { error, code } });
    expect(deps.claimDraftIntoComposeSession).not.toHaveBeenCalled();
  });

  it('maps duplicate draft ownership to the stable 409 response', async () => {
    deps.claimDraftIntoComposeSession.mockRejectedValueOnce(exposedError(
      'compose_draft_claimed',
      'Source draft is already open in a compose session',
      409,
    ));

    const response = await request(base, 'POST', '/api/compose-sessions/claim-draft', {
      body: { accountId: ACCOUNT_ID, folder: '[Synthetic]/Drafts', uid: 41 },
    });

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'Source draft is already open in a compose session',
        code: 'compose_draft_claimed',
      },
    });
  });

  it.each([
    [{ changes: null }, 'changes must be an object'],
    [{ changes: { to: 'recipient@example.com' } }, 'to must be an array'],
    [{ changes: { body: null } }, 'body must be a string'],
  ])('rejects malformed compose changes at the route boundary %#', async (body, error) => {
    const response = await request(base, 'POST', '/api/compose-sessions', { body });

    expect(response).toEqual({
      status: 400,
      body: { error, code: 'invalid_compose_changes' },
    });
    expect(deps.createComposeSession).not.toHaveBeenCalled();
  });

  it.each([
    ['person@example.com'],
    ['contains spaces'],
    ['x'.repeat(65)],
  ])('rejects non-opaque client identities %#', async (clientId) => {
    const response = await request(base, 'POST', '/api/compose-sessions', {
      body: { changes: {}, clientId },
    });

    expect(response).toEqual({
      status: 400,
      body: {
        error: 'clientId must be 1-64 characters using letters, numbers, underscores, or hyphens',
        code: 'invalid_client_id',
      },
    });
    expect(deps.createComposeSession).not.toHaveBeenCalled();
  });

  it('maps an exposed occupied-slot conflict without leaking internals', async () => {
    deps.createComposeSession.mockRejectedValueOnce(exposedError(
      'compose_slot_occupied',
      'Compose slot 4 is already occupied',
      409,
    ));

    const response = await request(base, 'POST', '/api/compose-sessions', {
      body: { requestedSlot: 4, changes: {} },
    });

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'Compose slot 4 is already occupied',
        code: 'compose_slot_occupied',
      },
    });
  });

  it('gets an owned session by route id', async () => {
    const session = {
      id: SESSION_ID,
      slot: 1,
      revision: 3,
      attachments: [],
    };
    deps.getComposeSession.mockResolvedValueOnce(session);

    const response = await request(base, 'GET', `/api/compose-sessions/${SESSION_ID}`);

    expect(response).toEqual({ status: 200, body: session });
    expect(deps.getComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
    }, deps);
  });

  it('maps an out-of-scope session to the service 404 shape', async () => {
    deps.getComposeSession.mockRejectedValueOnce(exposedError(
      'compose_session_not_found',
      'Compose session not found',
      404,
    ));

    const response = await request(base, 'GET', `/api/compose-sessions/${SESSION_ID}`);

    expect(response).toEqual({
      status: 404,
      body: {
        error: 'Compose session not found',
        code: 'compose_session_not_found',
      },
    });
  });

  it('closes with a strict revision and normalized atomic final changes', async () => {
    const result = {
      closed: true,
      slot: 3,
      draft: {
        accountId: ACCOUNT_ID,
        uid: 72,
        folder: '[Synthetic]/Drafts',
        messageId: '<saved-synthetic@example.com>',
      },
    };
    deps.closeComposeSession.mockResolvedValueOnce(result);

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/close`,
      { body: { expectedRevision: '7', changes: { subject: 'Final synthetic subject' } } },
    );

    expect(response).toEqual({ status: 200, body: result });
    expect(deps.closeComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
      expectedRevision: 7,
      changes: { subject: 'Final synthetic subject' },
    }, expect.objectContaining({
      query: deps.query,
      withTransaction: deps.withTransaction,
      imapManager: APP_IMAP_MANAGER,
    }));
  });

  it('discards with a strict revision and returns the terminal receipt', async () => {
    const result = { discarded: true, slot: 3 };
    deps.discardComposeSession.mockResolvedValueOnce(result);

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/discard`,
      { body: { expectedRevision: 7 } },
    );

    expect(response).toEqual({ status: 200, body: result });
    expect(deps.discardComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
      expectedRevision: 7,
    }, expect.objectContaining({
      query: deps.query,
      withTransaction: deps.withTransaction,
      imapManager: APP_IMAP_MANAGER,
    }));
  });

  it('sends immediately with strict inputs and preserves the complete shared receipt', async () => {
    const result = {
      ok: true,
      messageId: '<sent-synthetic@example.com>',
      sentCopySaved: false,
      receipt: {
        subject: 'Synthetic send subject',
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
      },
    };
    deps.sendComposeSession.mockResolvedValueOnce(result);

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/send`,
      {
        body: { expectedRevision: '7', undoSendSeconds: 0 },
        headers: { 'X-Idempotency-Key': 'synthetic-send-key' },
      },
    );

    expect(response).toEqual({ status: 200, body: result });
    expect(deps.sendComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
      expectedRevision: 7,
      undoSendSeconds: 0,
      idempotencyKey: 'synthetic-send-key',
    }, expect.objectContaining({
      query: deps.query,
      withTransaction: deps.withTransaction,
      imapManager: APP_IMAP_MANAGER,
      redisClient: deps.redisClient,
      refreshMicrosoftToken: deps.refreshMicrosoftToken,
      outboxService: deps.outboxService,
      draftService: deps.draftService,
    }));
  });

  it('returns 202 with the complete durable outbox result', async () => {
    const result = {
      queued: true,
      outboxId: '55555555-5555-4555-8555-555555555555',
      sendAt: '2026-08-01T12:00:30.000Z',
      undoSeconds: 30,
    };
    deps.sendComposeSession.mockResolvedValueOnce(result);

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/send`,
      { body: { expectedRevision: 7, undoSendSeconds: 30 } },
    );

    expect(response).toEqual({ status: 202, body: result });
    expect(deps.sendComposeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        undoSendSeconds: 30,
        idempotencyKey: null,
      }),
      expect.any(Object),
    );
  });

  it.each([
    ['same-prefix-a', `${'same-prefix-'.padEnd(128, 'x')}a`],
    ['same-prefix-b', `${'same-prefix-'.padEnd(128, 'x')}b`],
    ['blank', ''],
    ['whitespace', 'contains spaces'],
    ['content-like', 'recipient@example.com'],
    ['slash', 'key/with/content'],
  ])('rejects unsafe idempotency header %s before lifecycle send', async (_label, key) => {
    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/send`,
      {
        body: { expectedRevision: 7 },
        headers: { 'X-Idempotency-Key': key },
      },
    );

    expect(response).toEqual({
      status: 400,
      body: {
        error: 'X-Idempotency-Key must be 1-128 safe opaque characters',
        code: 'invalid_compose_idempotency_key',
      },
    });
    expect(deps.sendComposeSession).not.toHaveBeenCalled();
  });

  it.each([-1, 121, 1.5, '30', null, true, [], {}])(
    'rejects invalid undoSendSeconds %# before send',
    async (undoSendSeconds) => {
      const response = await request(
        base,
        'POST',
        `/api/compose-sessions/${SESSION_ID}/send`,
        { body: { expectedRevision: 7, undoSendSeconds } },
      );

      expect(response).toEqual({
        status: 400,
        body: {
          error: 'undoSendSeconds must be an integer from 0 to 120',
          code: 'invalid_compose_undo_seconds',
        },
      });
      expect(deps.sendComposeSession).not.toHaveBeenCalled();
    },
  );

  it('maps an exposed pre-acceptance send conflict without a success response', async () => {
    deps.sendComposeSession.mockRejectedValueOnce(exposedError(
      'compose_conflict',
      'Compose session changed',
      409,
      { currentRevision: 8 },
    ));

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/send`,
      { body: { expectedRevision: 7 } },
    );

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'Compose session changed',
        code: 'compose_conflict',
        currentRevision: 8,
      },
    });
  });

  it.each([
    ['close', 0],
    ['close', '1e2'],
    ['close', '0x10'],
    ['close', '+1'],
    ['close', '1.0'],
    ['discard', null],
    ['discard', 1.5],
    ['send', undefined],
  ])('rejects invalid terminal revision %# for %s', async (operation, expectedRevision) => {
    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/${operation}`,
      { body: { expectedRevision, changes: {} } },
    );

    expect(response).toEqual({
      status: 400,
      body: {
        error: 'expectedRevision must be a positive integer',
        code: 'invalid_compose_revision',
      },
    });
    expect(deps.closeComposeSession).not.toHaveBeenCalled();
    expect(deps.discardComposeSession).not.toHaveBeenCalled();
    expect(deps.sendComposeSession).not.toHaveBeenCalled();
  });

  it.each(['close', 'discard', 'send'])('rejects malformed terminal UUID for %s', async (operation) => {
    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/not-a-uuid/${operation}`,
      { body: { expectedRevision: 7, changes: {} } },
    );

    expect(response).toEqual({
      status: 400,
      body: {
        error: 'Compose session id must be a UUID',
        code: 'invalid_compose_session_id',
      },
    });
  });

  it('maps an exposed discard failure without claiming terminal success', async () => {
    deps.discardComposeSession.mockRejectedValueOnce(exposedError(
      'compose_conflict',
      'Compose session changed',
      409,
      { currentRevision: 8 },
    ));

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/discard`,
      { body: { expectedRevision: 7 } },
    );

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'Compose session changed',
        code: 'compose_conflict',
        currentRevision: 8,
      },
    });
  });

  it('returns a stable actionable 422 when the selected account has no Drafts folder', async () => {
    deps.closeComposeSession.mockRejectedValueOnce(exposedError(
      'compose_drafts_folder_not_found',
      'No Drafts folder is available for this account',
      422,
    ));

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/close`,
      { body: { expectedRevision: 7 } },
    );

    expect(response).toEqual({
      status: 422,
      body: {
        error: 'No Drafts folder is available for this account',
        code: 'compose_drafts_folder_not_found',
      },
    });
  });

  it.each([
    ['close', 'compose_close_accepted_cleanup_pending', 'Draft was saved'],
    ['discard', 'compose_discard_accepted_cleanup_pending', 'Draft was deleted'],
  ])('returns an actionable 409 for accepted %s cleanup pending', async (
    operation,
    code,
    prefix,
  ) => {
    deps[`${operation}ComposeSession`].mockRejectedValueOnce(exposedError(
      code,
      `${prefix} but compose cleanup is still pending; do not retry`,
      409,
    ));

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/${operation}`,
      { body: { expectedRevision: 7, ...(operation === 'close' ? { changes: {} } : {}) } },
    );

    expect(response).toEqual({
      status: 409,
      body: {
        error: `${prefix} but compose cleanup is still pending; do not retry`,
        code,
      },
    });
  });

  it('patches fields with a parsed positive expected revision', async () => {
    const session = { id: SESSION_ID, slot: 1, subject: 'New subject', revision: 4 };
    deps.patchComposeSession.mockResolvedValueOnce(session);

    const response = await request(base, 'PATCH', `/api/compose-sessions/${SESSION_ID}`, {
      body: {
        expectedRevision: '3',
        changes: { subject: 'New subject' },
        clientId: 'browser-synthetic',
      },
    });

    expect(response).toEqual({ status: 200, body: session });
    expect(deps.patchComposeSession).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
      expectedRevision: 3,
      changes: { subject: 'New subject' },
      clientId: 'browser-synthetic',
    }, deps);
  });

  it('returns structured revision-conflict details', async () => {
    deps.patchComposeSession.mockRejectedValueOnce(exposedError(
      'compose_conflict',
      'Compose session changed in the requested fields',
      409,
      {
        conflictingFields: ['subject'],
        currentRevision: 4,
        remoteValues: { subject: 'Remote subject' },
      },
    ));

    const response = await request(base, 'PATCH', `/api/compose-sessions/${SESSION_ID}`, {
      body: { expectedRevision: 3, changes: { subject: 'Local subject' } },
    });

    expect(response).toEqual({
      status: 409,
      body: {
        error: 'Compose session changed in the requested fields',
        code: 'compose_conflict',
        conflictingFields: ['subject'],
        currentRevision: 4,
        remoteValues: { subject: 'Remote subject' },
      },
    });
  });

  it('sets presentation intent with revision and client identity', async () => {
    const session = {
      id: SESSION_ID,
      slot: 1,
      presentationState: 'minimized',
      revision: 5,
    };
    deps.setComposePresentation.mockResolvedValueOnce(session);

    const response = await request(
      base,
      'PUT',
      `/api/compose-sessions/${SESSION_ID}/presentation`,
      {
        body: {
          expectedRevision: 4,
          state: 'minimized',
          clientId: 'browser-synthetic',
        },
      },
    );

    expect(response).toEqual({ status: 200, body: session });
    expect(deps.setComposePresentation).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
      expectedRevision: 4,
      state: 'minimized',
      clientId: 'browser-synthetic',
    }, deps);
  });

  it.each([
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { changes: {} }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: 0 }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: -1 }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: 1.5 }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '1x' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '1e2' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '0x10' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '+1' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '1.0' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: ' 1 ' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '0' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '-1' }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: '01' }, {}],
    [
      'PATCH',
      `/api/compose-sessions/${SESSION_ID}`,
      { expectedRevision: String(Number.MAX_SAFE_INTEGER + 1) },
      {},
    ],
    [
      'PATCH',
      `/api/compose-sessions/${SESSION_ID}`,
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      {},
    ],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: true }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: null }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: [] }, {}],
    ['PATCH', `/api/compose-sessions/${SESSION_ID}`, { expectedRevision: {} }, {}],
    [
      'PUT',
      `/api/compose-sessions/${SESSION_ID}/presentation`,
      { state: 'expanded' },
      {},
    ],
    [
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments`,
      Buffer.from('synthetic bytes'),
      {
        'Content-Type': 'application/octet-stream',
        'X-Mailflow-Filename': 'report.pdf',
        'X-Mailflow-Content-Type': 'application/pdf',
      },
    ],
    [
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments`,
      Buffer.from('synthetic bytes'),
      {
        'Content-Type': 'application/octet-stream',
        'X-Mailflow-Expected-Revision': '1e2',
        'X-Mailflow-Filename': 'report.pdf',
        'X-Mailflow-Content-Type': 'application/pdf',
      },
    ],
    [
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments?expectedRevision=0x10`,
      Buffer.from('synthetic bytes'),
      {
        'Content-Type': 'application/octet-stream',
        'X-Mailflow-Filename': 'report.pdf',
        'X-Mailflow-Content-Type': 'application/pdf',
      },
    ],
    [
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments`,
      Buffer.from('synthetic bytes'),
      {
        'Content-Type': 'application/octet-stream',
        'X-Mailflow-Expected-Revision': 'not-an-integer',
        'X-Mailflow-Filename': 'report.pdf',
        'X-Mailflow-Content-Type': 'application/pdf',
      },
    ],
    [
      'DELETE',
      `/api/compose-sessions/${SESSION_ID}/attachments/${ATTACHMENT_ID}`,
      {},
      {},
    ],
  ])('rejects missing or invalid revisions for %s %s', async (method, path, body, headers) => {
    const response = await request(base, method, path, { body, headers });

    expect(response).toEqual({
      status: 400,
      body: {
        error: 'expectedRevision must be a positive integer',
        code: 'invalid_compose_revision',
      },
    });
  });

  it('adds raw attachment bytes with decoded metadata and header revision', async () => {
    const result = {
      sessionId: SESSION_ID,
      slot: 1,
      revision: 6,
      attachment: {
        id: ATTACHMENT_ID,
        filename: 'quarterly report.pdf',
        contentType: 'application/pdf',
        byteCount: 15,
      },
    };
    deps.addComposeAttachment.mockResolvedValueOnce(result);

    const content = Buffer.from('synthetic bytes');
    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments`,
      {
        body: content,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Mailflow-Expected-Revision': '5',
          'X-Mailflow-Filename': 'quarterly%20report.pdf',
          'X-Mailflow-Content-Type': 'application/pdf',
          'X-Mailflow-Client-Id': 'browser-synthetic',
        },
      },
    );

    expect(response).toEqual({ status: 201, body: result });
    expect(deps.addComposeAttachment).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
      expectedRevision: 5,
      filename: 'quarterly report.pdf',
      contentType: 'application/pdf',
      content,
      clientId: 'browser-synthetic',
    }, deps);
  });

  it('requires the binary attachment media type before calling the service', async () => {
    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments`,
      {
        body: 'synthetic text',
        headers: {
          'Content-Type': 'text/plain',
          'X-Mailflow-Expected-Revision': '5',
          'X-Mailflow-Filename': 'report.txt',
          'X-Mailflow-Content-Type': 'text/plain',
        },
      },
    );

    expect(response).toEqual({
      status: 415,
      body: {
        error: 'Content-Type must be application/octet-stream',
        code: 'unsupported_attachment_media_type',
      },
    });
    expect(deps.addComposeAttachment).not.toHaveBeenCalled();
  });

  it('rejects a non-Buffer attachment body before calling the service', async () => {
    const bodyApp = buildApp({ useRawParser: false });
    const bodyServer = bodyApp.listen(0, '127.0.0.1');
    await new Promise(resolve => bodyServer.once('listening', resolve));
    const bodyBase = `http://127.0.0.1:${bodyServer.address().port}`;
    try {
      const response = await request(
        bodyBase,
        'POST',
        `/api/compose-sessions/${SESSION_ID}/attachments`,
        {
          body: Buffer.from('synthetic bytes'),
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Mailflow-Expected-Revision': '5',
            'X-Mailflow-Filename': 'report.bin',
          },
        },
      );

      expect(response).toEqual({
        status: 400,
        body: {
          error: 'Attachment body must be raw bytes',
          code: 'invalid_attachment_body',
        },
      });
      expect(deps.addComposeAttachment).not.toHaveBeenCalled();
    } finally {
      await new Promise(resolve => bodyServer.close(resolve));
    }
  });

  it('rejects malformed percent encoding in attachment filenames', async () => {
    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments`,
      {
        body: Buffer.from('synthetic bytes'),
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Mailflow-Expected-Revision': '5',
          'X-Mailflow-Filename': '%E0%A4%A',
          'X-Mailflow-Content-Type': 'application/pdf',
        },
      },
    );

    expect(response).toEqual({
      status: 400,
      body: {
        error: 'X-Mailflow-Filename must be valid percent encoding',
        code: 'invalid_attachment_filename',
      },
    });
    expect(deps.addComposeAttachment).not.toHaveBeenCalled();
  });

  it('maps the exposed attachment aggregate limit to 413', async () => {
    deps.addComposeAttachment.mockRejectedValueOnce(exposedError(
      'attachment_limit',
      'Compose attachments exceed the 25 MiB limit',
      413,
    ));

    const response = await request(
      base,
      'POST',
      `/api/compose-sessions/${SESSION_ID}/attachments`,
      {
        body: Buffer.from('synthetic bytes'),
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Mailflow-Expected-Revision': '5',
          'X-Mailflow-Filename': 'report.pdf',
          'X-Mailflow-Content-Type': 'application/pdf',
        },
      },
    );

    expect(response).toEqual({
      status: 413,
      body: {
        error: 'Compose attachments exceed the 25 MiB limit',
        code: 'attachment_limit',
      },
    });
  });

  it('removes an attachment with an expected revision', async () => {
    const result = {
      sessionId: SESSION_ID,
      slot: 1,
      revision: 7,
      removedAttachmentId: ATTACHMENT_ID,
    };
    deps.removeComposeAttachment.mockResolvedValueOnce(result);

    const response = await request(
      base,
      'DELETE',
      `/api/compose-sessions/${SESSION_ID}/attachments/${ATTACHMENT_ID}`,
      { body: { expectedRevision: 6, clientId: 'browser-synthetic' } },
    );

    expect(response).toEqual({ status: 200, body: result });
    expect(deps.removeComposeAttachment).toHaveBeenCalledWith({
      userId: USER_ID,
      id: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      expectedRevision: 6,
      clientId: 'browser-synthetic',
    }, deps);
  });

  it('forwards unknown errors to the generic non-leaking handler', async () => {
    deps.patchComposeSession.mockRejectedValueOnce(
      new Error('database diagnostic containing private internals'),
    );

    const response = await request(base, 'PATCH', `/api/compose-sessions/${SESSION_ID}`, {
      body: { expectedRevision: 1, changes: { subject: 'Synthetic subject' } },
    });

    expect(response).toEqual({
      status: 500,
      body: { error: 'Internal server error' },
    });
    expect(JSON.stringify(response.body)).not.toContain('database diagnostic');
  });
});
