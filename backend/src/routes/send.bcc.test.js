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
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';

// #585: the metadata recorded for the Sent copy carried To and Cc but not the Bcc.
const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: null, signature: null };
let server, base;
beforeAll(async () => {
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: vi.fn(async () => ({})) } });
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

describe('Sent copy metadata', () => {
  it('records the Bcc next to To and Cc', async () => {
    const res = await fetch(`${base}/api/mail/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'bcc1' },
      body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], cc: ['cc@example.com'], bcc: ['Hidden <hidden@example.com>'], subject: 'Hi', body: 'Hello' }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(imapManager.upsertSentMessageRecord).toHaveBeenCalled());
    const meta = imapManager.upsertSentMessageRecord.mock.calls[0][3];
    expect(meta.bcc).toEqual([expect.objectContaining({ email: 'hidden@example.com' })]);
    expect(meta.cc).toEqual([expect.objectContaining({ email: 'cc@example.com' })]);
  });
});
