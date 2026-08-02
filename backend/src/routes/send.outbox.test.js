import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const smtpSendMail = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const redisClient = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));
const outbox = vi.hoisted(() => ({
  enqueue: vi.fn(),
  cancel: vi.fn(),
  listPending: vi.fn(),
}));
const imapManager = vi.hoisted(() => ({
  appendToSent: vi.fn(),
  upsertSentMessageRecord: vi.fn(),
  syncFolderOnDemand: vi.fn(),
  findUidByMessageId: vi.fn(),
}));

vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    default: {
      ...actual.default,
      createTransport: vi.fn(options => (
        options?.streamTransport
          ? actual.default.createTransport(options)
          : { sendMail: smtpSendMail }
      )),
    },
  };
});
vi.mock('../services/db.js', () => ({ query }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('./oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(() => 'smtp-password') }));
vi.mock('../services/redis.js', () => ({ redisClient }));
vi.mock('../services/hostValidation.js', () => ({
  resolveForConnection: vi.fn().mockResolvedValue({
    host: '203.0.113.25',
    servername: 'smtp.example.com',
  }),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({
    allowPrivateHosts: false,
    allowInsecureTls: false,
  }),
}));
vi.mock('../index.js', () => ({ imapManager }));
vi.mock('../services/gtdTransitions.js', () => ({
  runTransitionsForSentMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/outboxService.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...outbox,
}));

import express from 'express';
import sendRoutes from './send.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SEND_AT = new Date('2026-07-28T12:00:30.000Z');
const ACCOUNT_ROW = {
  id: ACCOUNT_ID,
  user_id: 'user-1',
  email_address: 'sender@example.com',
  name: 'Sender',
  sender_name: null,
  signature: null,
  auth_user: 'sender@example.com',
  auth_pass: 'encrypted',
  oauth_provider: null,
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_tls: 'STARTTLS',
  imap_skip_tls_verify: false,
  folder_mappings: { sent: 'Sent' },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', sendRoutes);
  return app;
}

function post(base, path, body, headers = {}) {
  return fetch(`${base}/api/mail${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function compose(overrides = {}) {
  return {
    accountId: ACCOUNT_ID,
    to: ['Recipient <recipient@example.com>'],
    subject: 'Undo send',
    body: 'hello',
    ...overrides,
  };
}

describe('undo-send REST routes', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => {
      server = buildApp().listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2')) {
        return { rows: [ACCOUNT_ROW] };
      }
      if (sql.includes('SELECT preferences FROM users')) {
        return { rows: [{ preferences: { plaintextEmail: false } }] };
      }
      if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book-1' }] };
      if (sql.includes('INSERT INTO contacts')) return { rows: [{ address_book_id: 'book-1' }] };
      return { rows: [] };
    });
    redisClient.get.mockReset().mockResolvedValue(null);
    redisClient.set.mockReset().mockResolvedValue('OK');
    redisClient.del.mockReset().mockResolvedValue(1);
    smtpSendMail.mockReset().mockResolvedValue({ messageId: '<smtp@example.com>' });
    imapManager.appendToSent.mockReset().mockResolvedValue({ uid: null });
    imapManager.upsertSentMessageRecord.mockReset().mockResolvedValue(undefined);
    imapManager.syncFolderOnDemand.mockReset().mockResolvedValue(undefined);
    imapManager.findUidByMessageId.mockReset().mockResolvedValue(null);
    outbox.enqueue.mockReset().mockResolvedValue({
      outbox_id: 'outbox-1',
      send_at: SEND_AT,
      undo_seconds: 30,
    });
    outbox.cancel.mockReset();
    outbox.listPending.mockReset();
  });

  it('sends immediately with the unchanged 200 response when undoSendSeconds is 0', async () => {
    const response = await post(base, '/send', compose({ undoSendSeconds: 0 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('queues for 30 seconds without calling sendMail', async () => {
    const response = await post(
      base,
      '/send',
      compose({ undoSendSeconds: 30 }),
      { 'X-Idempotency-Key': 'queued-1' },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      queued: true,
      outboxId: 'outbox-1',
      sendAt: SEND_AT.toISOString(),
      undoSeconds: 30,
    });
    expect(smtpSendMail).not.toHaveBeenCalled();
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'queued-1', undoSeconds: 30 }),
      expect.any(Object),
    );
  });

  it('sends immediately when the field and user preference are both absent', async () => {
    const response = await post(base, '/send', compose());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it.each([-1, 121, 1.5, '30'])('rejects invalid undoSendSeconds value %j', async (value) => {
    const response = await post(base, '/send', compose({ undoSendSeconds: value }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'undoSendSeconds must be an integer from 0 to 120' });
    expect(smtpSendMail).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('maps cancel results to 200, 409, and 404 without changing user scope', async () => {
    outbox.cancel
      .mockResolvedValueOnce({ cancelled: true })
      .mockResolvedValueOnce({ cancelled: false, reason: 'already_sent' })
      .mockResolvedValueOnce({ cancelled: false, reason: 'not_found' });

    const cancelled = await post(base, '/outbox/outbox-1/cancel', {});
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true });

    const sent = await post(base, '/outbox/outbox-2/cancel', {});
    expect(sent.status).toBe(409);
    expect(await sent.json()).toEqual({ error: 'already_sent' });

    const missing = await post(base, '/outbox/outbox-3/cancel', {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    expect(outbox.cancel.mock.calls.map(([input]) => input)).toEqual([
      { id: 'outbox-1', userId: 'user-1' },
      { id: 'outbox-2', userId: 'user-1' },
      { id: 'outbox-3', userId: 'user-1' },
    ]);
  });

  it('lists pending rows through the session user scope', async () => {
    const pending = [{
      id: 'outbox-1',
      subject: 'Undo send',
      to_preview: ['recipient@example.com'],
      send_at: SEND_AT.toISOString(),
    }];
    outbox.listPending.mockResolvedValue(pending);

    const response = await fetch(`${base}/api/mail/outbox`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pending });
    expect(outbox.listPending).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.any(Object),
    );
  });
});
