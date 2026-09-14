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

const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google' };
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
const post = () => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'send1' },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello' }),
});
describe('send failure semantics', () => {
  it('does not deliver when idempotency lookup fails', async () => {
    redisClient.get.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await post()).status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('does not deliver or remove another lock when reservation fails', async () => {
    redisClient.set.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect((await post()).status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('does not clear a concurrent send lock after a pre-reservation failure', async () => {
    createAccountSmtpTransport.mockRejectedValueOnce(new Error('SMTP setup failed'));
    expect((await post()).status).toBe(500);
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('reports delivery success with a Sent-copy warning after post-delivery failure', async () => {
    resolveSentFolder.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sentCopySaved: false });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(redisClient.set).toHaveBeenLastCalledWith('send_idem:u1:send1', JSON.stringify({ ok: true, sentCopySaved: false }), { EX: 86400 });
    expect(redisClient.del).not.toHaveBeenCalled();
  });
  it('releases its own reservation after an SMTP rejection', async () => {
    sendMail.mockRejectedValueOnce(new Error('550 rejected'));
    expect((await post()).status).toBe(500);
    expect(redisClient.del).toHaveBeenCalledWith('send_idem:u1:send1');
  });
  it('blocks a concurrent submission', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(409);
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.del).not.toHaveBeenCalled();
  });
});
