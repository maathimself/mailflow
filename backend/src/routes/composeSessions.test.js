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
  getComposeSession: vi.fn(),
  patchComposeSession: vi.fn(),
  setComposePresentation: vi.fn(),
  addComposeAttachment: vi.fn(),
  removeComposeAttachment: vi.fn(),
};

function buildApp({ useRawParser = true } = {}) {
  const app = express();
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
