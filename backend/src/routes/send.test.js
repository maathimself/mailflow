import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const smtpSendMail = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const redisClient = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
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

import express from 'express';
import sendRoutes from './send.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
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

function postSend(base, { headers = {}, body = {} } = {}) {
  return fetch(`${base}/api/mail/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      accountId: ACCOUNT_ID,
      to: ['Recipient <recipient@example.com>'],
      subject: 'Golden send',
      body: 'hello',
      ...body,
    }),
  });
}

describe('POST /api/mail/send — golden parity', () => {
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
  });

  it('returns the exact current success response shape', async () => {
    const response = await postSend(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('passes through sentCopySaved:false when the single Sent APPEND fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    imapManager.appendToSent.mockRejectedValueOnce(new Error('append unavailable'));

    const response = await postSend(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sentCopySaved: false });
    expect(imapManager.appendToSent).toHaveBeenCalledTimes(1);
  });

  it('returns 409 for an in-flight idempotency key without sending', async () => {
    redisClient.get.mockResolvedValueOnce('__inflight__');

    const response = await postSend(base, {
      headers: { 'X-Idempotency-Key': 'same-send' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'This message is already being sent.' });
    expect(smtpSendMail).not.toHaveBeenCalled();
  });

  it('replays a completed cached result without sending', async () => {
    redisClient.get.mockResolvedValueOnce(JSON.stringify({ ok: true, sentCopySaved: false }));

    const response = await postSend(base, {
      headers: { 'X-Idempotency-Key': 'completed-send' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sentCopySaved: false });
    expect(smtpSendMail).not.toHaveBeenCalled();
  });

  it('sanitizes SMTP failures instead of exposing raw server details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    smtpSendMail.mockRejectedValueOnce(new Error('ECONNREFUSED smtp.secret.internal:2525'));

    const response = await postSend(base);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Could not connect to the mail server. Check your SMTP settings.',
    });
  });
});
