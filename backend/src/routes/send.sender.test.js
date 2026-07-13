import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const smtpSendMail = vi.fn();

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: smtpSendMail })) },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/senderAuthorization.js', () => ({ authorizeSender: vi.fn() }));
vi.mock('../services/redis.js', () => ({
  redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(() => 'access-token') }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false }),
}));
vi.mock('../services/hostValidation.js', () => ({
  resolveForConnection: vi.fn().mockResolvedValue({ host: 'smtp.fastmail.com', servername: 'smtp.fastmail.com' }),
}));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('../index.js', () => ({
  imapManager: {
    fetchAttachment: vi.fn(), appendToSent: vi.fn(), syncFolderOnDemand: vi.fn(),
    upsertSentMessageRecord: vi.fn(), findUidByMessageId: vi.fn(),
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'u1' };
    next();
  },
}));

import express from 'express';
import { query } from '../services/db.js';
import { authorizeSender } from '../services/senderAuthorization.js';
import { redisClient } from '../services/redis.js';
import { imapManager } from '../index.js';
import sendRoutes from './send.js';

const sender = { accountId: 'a1', aliasId: 'alias-1', fromEmail: null };
const account = {
  id: 'a1', name: 'Fastmail', email_address: 'owner@example.com',
  auth_user: 'owner@example.com', oauth_provider: 'google', oauth_access_token: 'encrypted',
  smtp_host: 'smtp.fastmail.com', smtp_port: 465, smtp_tls: 'SSL',
  folder_mappings: {}, fastmail_api_token: 'encrypted-fastmail-token',
};
const authorizedSender = {
  account,
  fromName: 'Exact Alias',
  fromEmail: 'alias@example.com',
  fromReplyTo: 'reply@example.com',
  fromSignature: '<p>Alias signature</p>',
};

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/mail', sendRoutes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  authorizeSender.mockReset();
  smtpSendMail.mockReset();
  redisClient.get.mockReset();
  redisClient.set.mockReset();
  redisClient.del.mockReset();
  redisClient.get.mockResolvedValue(null);
  for (const fn of Object.values(imapManager)) fn.mockReset();
  authorizeSender.mockResolvedValue(authorizedSender);
  smtpSendMail.mockResolvedValue({ accepted: ['to@example.com'] });
  query.mockImplementation(async sql => {
    if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: { plaintextEmail: true } }] };
    if (sql.includes('special_use')) return { rows: [] };
    return { rows: [] };
  });
});

const postSend = (body, idempotencyKey = null) => fetch(`${base}/mail/send`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
  },
  body: JSON.stringify(body),
});

describe('POST /mail/send explicit sender', () => {
  it('authorizes the exact request sender and uses the trusted address for SMTP', async () => {
    const res = await postSend({ sender, to: ['to@example.com'], subject: 'Hello', body: 'Message' });

    expect(res.status).toBe(200);
    expect(authorizeSender).toHaveBeenCalledWith({ userId: 'u1', sender });
    expect(smtpSendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Exact Alias <alias@example.com>',
      replyTo: 'reply@example.com',
    }));
  });

  it('applies complete Fastmail identity Reply-To and Bcc routing', async () => {
    authorizeSender.mockResolvedValue({
      ...authorizedSender,
      fromReplyTo: [
        { name: 'Support', address: 'support@example.com' },
        'archive@example.com',
      ],
      fromBcc: [
        { name: 'Compliance', address: 'compliance@example.com' },
        'journal@example.com',
      ],
    });

    const res = await postSend({
      sender,
      to: ['to@example.com'],
      bcc: ['visible-bcc@example.com'],
      subject: 'Hello',
      body: 'Message',
    });

    expect(res.status).toBe(200);
    expect(smtpSendMail).toHaveBeenCalledWith(expect.objectContaining({
      replyTo: [
        { name: 'Support', address: 'support@example.com' },
        'archive@example.com',
      ],
      bcc: [
        'visible-bcc@example.com',
        { name: 'Compliance', address: 'compliance@example.com' },
        'journal@example.com',
      ],
    }));
  });

  it('returns a cached successful send before reauthorizing a stale sender', async () => {
    const cached = { messageId: '<cached@example.com>', sentCopySaved: true };
    redisClient.get.mockResolvedValue(JSON.stringify(cached));
    authorizeSender.mockRejectedValue(Object.assign(new Error('Sender unavailable'), {
      status: 422, code: 'SENDER_UNAVAILABLE',
    }));

    const res = await postSend({ sender, to: ['to@example.com'], body: 'Message' }, 'retry-key');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(cached);
    expect(authorizeSender).not.toHaveBeenCalled();
    expect(smtpSendMail).not.toHaveBeenCalled();
  });

  it('returns SENDER_UNAVAILABLE before SMTP, IMAP, or attachment side effects', async () => {
    authorizeSender.mockRejectedValue(Object.assign(new Error('Sender unavailable'), {
      status: 422, code: 'SENDER_UNAVAILABLE',
    }));

    const res = await postSend({
      sender,
      to: ['to@example.com'],
      body: 'Message',
      forwardedAttachments: [{ messageId: '11111111-1111-4111-8111-111111111111', part: '2' }],
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Sender unavailable', code: 'SENDER_UNAVAILABLE' });
    expect(smtpSendMail).not.toHaveBeenCalled();
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
    expect(imapManager.appendToSent).not.toHaveBeenCalled();
  });

  it('does not expose unexpected sender-authorization failures', async () => {
    const privateDetail = 'private-database-detail-4581';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    authorizeSender.mockRejectedValue(new Error(privateDetail));

    const res = await postSend({ sender, to: ['to@example.com'], body: 'Message' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to authorize sender' });
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain(privateDetail);
    expect(smtpSendMail).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('maps a true Fastmail 553 From authorization rejection without exposing SMTP details', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    smtpSendMail.mockRejectedValue(Object.assign(new Error('private SMTP details for alias@example.com'), {
      responseCode: 553,
      response: '553 From address alias@example.com is not authorized for this identity',
    }));

    const res = await postSend({ sender, to: ['to@example.com'], body: 'Message' });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'This sending address is no longer authorized by Fastmail. Refresh addresses or choose another sender.',
      code: 'SENDER_NOT_AUTHORIZED',
    });
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain('alias@example.com');
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain('private SMTP details');
    errorLog.mockRestore();
  });

  it('does not misclassify a recipient 553 rejection as a sender authorization error', async () => {
    const sensitiveAlias = 'complete-private-alias@masked.example';
    const privateDetail = 'private-envelope-marker-8472';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    smtpSendMail.mockRejectedValue(Object.assign(new Error(`${privateDetail} ${sensitiveAlias}`), {
      responseCode: 553,
      response: `553 Recipient ${sensitiveAlias} rejected: mailbox unavailable`,
    }));

    const res = await postSend({ sender, to: ['missing@example.com'], body: 'Message' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to send message. Please try again.' });
    const logs = errorLog.mock.calls.flat().join(' ');
    expect(logs).not.toContain(sensitiveAlias);
    expect(logs).not.toContain(privateDetail);
    errorLog.mockRestore();
  });
});
