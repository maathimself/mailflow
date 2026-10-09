import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    fetchRawMessage: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
import express from 'express';
import nodemailer from 'nodemailer';
import routes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

// "Forward as attachment" (#466): the original goes along as an .eml with its headers intact.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null };
const SPAM_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const SPAM = 'Return-Path: <spammer@bad.example>\r\nReceived: from bad.example by mx.example\r\nFrom: "Prize Team" <spammer@bad.example>\r\nSubject: You won\r\nMessage-ID: <spam-1@bad.example>\r\n\r\nClick here.\r\n';
const sendMail = vi.fn(async () => ({}));
let server, base, owned;

beforeAll(async () => {
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  sendMail.mockClear();
  imapManager.fetchRawMessage.mockReset();
  imapManager.fetchRawMessage.mockResolvedValue(Buffer.from(SPAM));
  owned = [{ id: SPAM_ID, uid: 9, folder: 'Junk', subject: 'You won / claim: now', account_id: 'a1' }];
  query.mockReset();
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) return { rows: owned };
    if (sql.includes('FROM email_accounts')) return { rows: [account] };
    return { rows: [{ preferences: {}, id: 'book1' }] };
  });
});

const send = (extra, key = `k-${Math.random()}`) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
  body: JSON.stringify({ accountId: 'a1', to: ['submit.x@spam.spamcop.net'], subject: 'Fwd: You won', body: '', ...extra }),
});

describe('POST /api/mail/send — forwardedMessages', () => {
  it('attaches the raw message as a message/rfc822 file, not inline', async () => {
    const res = await send({ forwardedMessages: [SPAM_ID] });
    expect(res.status).toBe(200);
    expect(imapManager.fetchRawMessage).toHaveBeenCalledWith(account, 9, 'Junk');
    const [lookupSql, lookupParams] = query.mock.calls.find(([sql]) => sql.includes('FROM messages m') && sql.includes('m.id = ANY'));
    expect(lookupSql).toMatch(/a\.user_id = \$2/); // only the signed-in user's own messages
    expect(lookupParams).toEqual([[SPAM_ID], 'u1']);
    const [att] = sendMail.mock.calls[0][0].attachments;
    expect(att.contentType).toBe('message/rfc822');
    expect(att.contentDisposition).toBe('attachment');
    expect(att.filename).toBe('You won _ claim: now.eml'); // the "/" made safe for a filename
    expect(att.content.toString()).toBe(SPAM);
  });

  it('keeps the original headers byte for byte in the composed mail', async () => {
    await send({ forwardedMessages: [SPAM_ID] });
    const opts = sendMail.mock.calls[0][0];
    const raw = await new Promise((resolve, reject) => nodemailer.createTransport({ streamTransport: true, buffer: true })
      .sendMail({ from: 'me@example.com', to: opts.to, subject: opts.subject, text: 'x', attachments: opts.attachments }, (err, info) => (err ? reject(err) : resolve(info.message.toString()))));
    expect(raw).toMatch(/Content-Type: message\/rfc822/);
    expect(raw).toMatch(/Content-Disposition: attachment; filename=/);
    expect(raw).toMatch(/Content-Transfer-Encoding: 8bit/);
    expect(raw).toContain('Received: from bad.example by mx.example');
    expect(raw).toContain('Message-ID: <spam-1@bad.example>');
  });

  it('refuses a message the user does not own, before fetching anything', async () => {
    owned = [];
    const res = await send({ forwardedMessages: [SPAM_ID] });
    expect(res.status).toBe(404);
    expect(imapManager.fetchRawMessage).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('validates the list: an array of message ids, at most 20', async () => {
    expect((await send({ forwardedMessages: SPAM_ID })).status).toBe(400);
    expect((await send({ forwardedMessages: ['not-a-uuid'] })).status).toBe(400);
    expect((await send({ forwardedMessages: Array(21).fill(SPAM_ID) })).status).toBe(400);
    expect(imapManager.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('counts the fetched sources toward the 25 MB total', async () => {
    imapManager.fetchRawMessage.mockResolvedValue(Buffer.alloc(26_214_401, 0x61));
    const res = await send({ forwardedMessages: [SPAM_ID] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/25 MB/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports a source the server could not fetch instead of sending without it', async () => {
    imapManager.fetchRawMessage.mockResolvedValue(null);
    const res = await send({ forwardedMessages: [SPAM_ID] });
    expect(res.status).toBe(502);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
