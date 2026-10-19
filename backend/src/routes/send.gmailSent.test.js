import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    findUidByMessageId: vi.fn(async () => 7),
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

// #631/#632: Gmail's SMTP stores the Sent copy itself, so a genuine Gmail-over-Gmail
// app-password account must NOT APPEND a second one. The skip is narrow on purpose —
// a missing Sent copy is worse than a duplicate — so every mixed/look-alike setup
// below must keep the defensive APPEND.
const baseAccount = {
  id: 'a1', email_address: 'me@gmail.com', name: 'Me', oauth_provider: null, signature: null,
  imap_host: 'imap.gmail.com', imap_port: 993,
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
  auth_user: 'me@gmail.com', smtp_auth_user: null,
};
const account = { ...baseAccount };
const sendMail = vi.fn(async () => ({}));
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
beforeEach(() => {
  Object.assign(account, baseAccount);
  vi.clearAllMocks();
});
const post = () => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'gmail1' },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Hi', body: 'Hello' }),
});

describe('Gmail Sent auto-save heuristic', () => {
  it('app-password Gmail sending through Gmail SMTP skips the APPEND (#631)', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sentFolder: 'Sent', messageId: expect.any(String) });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(imapManager.appendToSent).not.toHaveBeenCalled();
  });
  it('googlemail hosts in any letter case still skip the APPEND', async () => {
    account.imap_host = 'IMAP.GOOGLEMAIL.COM';
    account.smtp_host = 'SMTP.GoogleMail.Com';
    expect((await post()).status).toBe(200);
    expect(imapManager.appendToSent).not.toHaveBeenCalled();
  });
  it('an explicit smtp_auth_user matching auth_user still skips the APPEND', async () => {
    account.smtp_auth_user = 'me@gmail.com';
    expect((await post()).status).toBe(200);
    expect(imapManager.appendToSent).not.toHaveBeenCalled();
  });
  it('Gmail IMAP behind SendGrid keeps the APPEND — Gmail never sees the message', async () => {
    account.smtp_host = 'smtp.sendgrid.net';
    account.smtp_auth_user = 'apikey';
    expect((await post()).status).toBe(200);
    expect(imapManager.appendToSent).toHaveBeenCalledOnce();
  });
  it('smtp-relay.gmail.com does not store a Sent copy, so the APPEND stays', async () => {
    account.smtp_host = 'smtp-relay.gmail.com';
    expect((await post()).status).toBe(200);
    expect(imapManager.appendToSent).toHaveBeenCalledOnce();
  });
  it('a non-Gmail IMAP account sending via smtp.gmail.com keeps the APPEND', async () => {
    account.imap_host = 'imap.fastmail.com';
    account.email_address = 'me@fastmail.com';
    account.auth_user = 'me@fastmail.com';
    account.smtp_auth_user = 'me@fastmail.com';
    expect((await post()).status).toBe(200);
    expect(imapManager.appendToSent).toHaveBeenCalledOnce();
  });
  it('a separate SMTP identity (smtp_auth_user ≠ auth_user) keeps the APPEND', async () => {
    account.smtp_auth_user = 'other@gmail.com';
    expect((await post()).status).toBe(200);
    expect(imapManager.appendToSent).toHaveBeenCalledOnce();
  });
  it('a look-alike host such as evilgmail.com keeps the APPEND', async () => {
    account.imap_host = 'imap.evilgmail.com';
    account.smtp_host = 'smtp.evilgmail.com';
    expect((await post()).status).toBe(200);
    expect(imapManager.appendToSent).toHaveBeenCalledOnce();
  });
});
