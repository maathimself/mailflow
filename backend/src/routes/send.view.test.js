import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

// An IMAP account (no OAuth), so the route saves the Sent copy itself.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null };
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

describe('the send result', () => {
  it("names the sent message, so View can open it rather than only its folder", async () => {
    const res = await fetch(`${base}/api/mail/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'v1' },
      body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello' }),
    });
    const body = await res.json();
    expect(body.sentFolder).toBe('Sent');
    expect(body.messageId).toBe(sendMail.mock.calls[0][0].messageId);
    expect(body.messageId).toMatch(/^<[0-9a-f]+@example\.com>$/);
  });
});
