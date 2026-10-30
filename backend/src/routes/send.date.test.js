import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    pluginFacade: {},
  },
}));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => 'Sent') }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { renderRawMessage } from '../services/outgoingMail.js';

// The SMTP copy and the Sent copy are two renders of one message. Each used to get its own Date
// from nodemailer at render time, so the Sent copy was dated before the SMTP round trip and the
// recipient's copy after it. One Date is now decided when the message is built and used for
// both, for the Sent row and for the recipients' last-sent time.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null, signature: null, imap_host: 'imap.example.com', smtp_host: 'smtp.example.com' };
const T0 = new Date('2026-10-24T10:00:00.000Z');
const dateHeader = raw => raw.toString().match(/^Date: (.+)$/m)?.[1].trim();
let smtpRaw;
// What a real SMTP transport does: render the message when it sends it, here 5 s later.
const sendMail = vi.fn(async mailOptions => {
  vi.setSystemTime(new Date(T0.getTime() + 5000));
  smtpRaw = await renderRawMessage(mailOptions);
  return {};
});
let server, base;
beforeAll(async () => {
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
afterEach(() => { vi.useRealTimers(); });

describe('POST /send Date header', () => {
  it('gives the SMTP copy, the Sent copy and the Sent row one Date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const res = await fetch(`${base}/api/mail/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Hi', body: 'Hello' }),
    });
    expect(res.status).toBe(200);

    const [, , sentRaw] = imapManager.appendToSent.mock.calls[0];
    expect(dateHeader(sentRaw)).toBe(T0.toUTCString().replace(/GMT/, '+0000'));
    expect(dateHeader(smtpRaw)).toBe(dateHeader(sentRaw));

    const [, , , meta] = imapManager.upsertSentMessageRecord.mock.calls[0];
    expect(meta.date).toEqual(T0);
    const contactCall = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO contacts'));
    expect(contactCall[1][8]).toEqual(T0);
  });
});
