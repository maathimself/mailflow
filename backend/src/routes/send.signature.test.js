import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { wrapSignatureHtml } from '../utils/signatureWrapper.js';

const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', signature: '<b>Sig</b>' };
const sendMail = vi.fn();
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  redisClient.del.mockResolvedValue(1);
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
const post = (extra = {}) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'sig1' },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: '<p>Hello</p>', bodyIsHtml: true, ...extra }),
});

describe('send signature wrapper (#432)', () => {
  it('wraps the account signature with the shared marked wrapper', async () => {
    expect((await post()).status).toBe(200);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).toContain(wrapSignatureHtml('<b>Sig</b>'));
    expect(mail.html.match(/class="mailexpert-signature"/g)).toHaveLength(1);
    expect(mail.text.match(/\n-- \n/g)).toHaveLength(1);
  });

  it('wraps an edited signature and omits the wrapper for an empty one', async () => {
    await post({ editedSignature: '<i>Edited</i>' });
    expect(sendMail.mock.calls[0][0].html).toContain(wrapSignatureHtml('<i>Edited</i>'));
    await post({ editedSignature: '' });
    expect(sendMail.mock.calls[1][0].html).not.toContain('mailexpert-signature');
  });
});
