import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.headers['x-test-user'] || 'u1' }; next(); },
}));
// A small in-memory Redis: the undo flow reads back what it wrote, so plain mocks are not enough.
const store = new Map();
vi.mock('../services/redis.js', () => ({
  redisClient: {
    get: vi.fn(async key => store.get(key) ?? null),
    set: vi.fn(async (key, value, opts = {}) => {
      if (opts.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async key => (store.delete(key) ? 1 : 0)),
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('./draft.js', () => ({ deleteSentDraft: vi.fn() }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { flushHeldSends, heldSendCount } from '../services/sendHold.js';
import { deleteSentDraft } from './draft.js';

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
  store.clear();
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});
// Nothing may stay held between tests.
afterEach(async () => { await flushHeldSends(1000); });

const send = (extra = {}, key = 'send1') => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
  body: JSON.stringify({ accountId: 'a1', to: ['you@example.com'], subject: 'Test', body: 'Hello', ...extra }),
});
const status = (id, user = 'u1') => fetch(`${base}/api/mail/send/${id}`, { headers: { 'x-test-user': user } }).then(r => r.json());
const cancel = (id, user = 'u1') => fetch(`${base}/api/mail/send/${id}/cancel`, { method: 'POST', headers: { 'x-test-user': user } });

describe('send with an undo window', () => {
  it('answers at once without delivering, then delivers when the window closes', async () => {
    const res = await send({ undoSeconds: 10 });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, pending: true });
    expect(Date.parse(body.sendAt) - Date.now()).toBeGreaterThan(9000);
    expect(sendMail).not.toHaveBeenCalled();
    expect(await status(body.pendingId)).toEqual({ status: 'pending' });

    await flushHeldSends(); // what the timer does when the window closes
    expect(sendMail).toHaveBeenCalledOnce();
    expect(await status(body.pendingId)).toEqual({ status: 'sent', result: { ok: true } });
    // A retry of the request after the fact gets the result, not a second delivery.
    expect(JSON.parse(store.get('send_idem:u1:send1'))).toEqual({ ok: true });
  });

  it('undo cancels the delivery and frees the key for sending the message again', async () => {
    const { pendingId } = await (await send({ undoSeconds: 10 })).json();
    const res = await cancel(pendingId);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(store.has('send_idem:u1:send1')).toBe(false);
    expect(heldSendCount()).toBe(0);
    await flushHeldSends();
    expect(sendMail).not.toHaveBeenCalled();
    expect(await status(pendingId)).toEqual({ status: 'cancelled' });
  });

  it('too late to undo: says so and reports what happened', async () => {
    const { pendingId } = await (await send({ undoSeconds: 10 })).json();
    await flushHeldSends();
    expect(await (await cancel(pendingId)).json()).toEqual({ cancelled: false, status: 'sent', result: { ok: true } });
  });

  it('a lost response retried with the same key returns the same held send', async () => {
    const first = await (await send({ undoSeconds: 10 })).json();
    const retry = await send({ undoSeconds: 10 });
    expect(await retry.json()).toEqual(first);
    await flushHeldSends();
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('a delivered message reads as sent while its Sent copy is still being saved', async () => {
    let saveSentCopy;
    resolveSentFolder.mockImplementationOnce(() => new Promise(resolve => { saveSentCopy = resolve; }));
    const { pendingId } = await (await send({ undoSeconds: 10 })).json();
    await flushHeldSends(50); // delivery starts; the bookkeeping after it is still running
    try {
      // What the server would report after a restart at this point.
      expect(JSON.parse(store.get(`send_hold:u1:${pendingId}`))).toEqual({ status: 'sent', result: { ok: true } });
    } finally {
      saveSentCopy(null); // never leave the send hanging for the tests after this one
    }
    await flushHeldSends();
    await new Promise(resolve => setImmediate(resolve));
    expect(await status(pendingId)).toEqual({ status: 'sent', result: { ok: true } });
  });

  it('recipients the server refused are reported once the held send is delivered', async () => {
    sendMail.mockResolvedValueOnce({ rejected: ['nobody@example.com'], rejectedErrors: [{ responseCode: 550 }] });
    const { pendingId } = await (await send({ undoSeconds: 10 })).json();
    await flushHeldSends();
    expect(await status(pendingId)).toEqual({ status: 'sent', result: { ok: true, rejected: ['nobody@example.com'] } });
  });

  it('a delivery that fails is reported with the safe message, and the key is freed', async () => {
    sendMail.mockRejectedValueOnce(new Error('550 5.1.1 mailbox unavailable'));
    const { pendingId } = await (await send({ undoSeconds: 10 })).json();
    await flushHeldSends();
    expect(await status(pendingId)).toEqual({ status: 'failed', error: 'Message was rejected by the mail server.' });
    expect(store.has('send_idem:u1:send1')).toBe(false);
  });

  it('checks the input before holding, so a bad request fails at once', async () => {
    const res = await send({ undoSeconds: 10, attachments: 'nope' });
    expect(res.status).toBe(400);
    expect(heldSendCount()).toBe(0);
  });

  it('caps the window at 30 seconds', async () => {
    const { sendAt } = await (await send({ undoSeconds: 3600 })).json();
    expect(Date.parse(sendAt) - Date.now()).toBeLessThanOrEqual(30_000);
  });

  it.each([0, -5, 2.5, '10', null])('sends straight away when undoSeconds is %p', async undoSeconds => {
    const res = await send({ undoSeconds });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it("keeps one user's held sends from another", async () => {
    const { pendingId } = await (await send({ undoSeconds: 10 })).json();
    expect(await status(pendingId, 'u2')).toEqual({ status: 'unknown' });
    expect(await (await cancel(pendingId, 'u2')).json()).toEqual({ cancelled: false, status: 'unknown' });
    await flushHeldSends();
    expect(sendMail).toHaveBeenCalledOnce();
  });

  describe('the draft the message was written in', () => {
    const draft = { uid: 7, folder: 'Drafts', accountId: 'a1' };
    const settle = () => new Promise(resolve => setImmediate(resolve));

    it('is deleted once the message is delivered, not before', async () => {
      await send({ undoSeconds: 10, draft });
      await settle();
      expect(deleteSentDraft).not.toHaveBeenCalled();
      await flushHeldSends();
      await settle();
      expect(deleteSentDraft).toHaveBeenCalledWith('u1', account, draft);
    });

    it('survives an undo', async () => {
      const { pendingId } = await (await send({ undoSeconds: 10, draft })).json();
      await cancel(pendingId);
      await flushHeldSends();
      await settle();
      expect(deleteSentDraft).not.toHaveBeenCalled();
    });

    it('survives a delivery that fails, as the copy the user still has', async () => {
      sendMail.mockRejectedValueOnce(new Error('550 rejected'));
      await send({ undoSeconds: 10, draft });
      await flushHeldSends();
      await settle();
      expect(deleteSentDraft).not.toHaveBeenCalled();
    });
  });

  it('rejects an id that is not a UUID', async () => {
    expect((await fetch(`${base}/api/mail/send/abc`)).status).toBe(400);
    expect((await cancel('abc')).status).toBe(400);
    expect(redisClient.get).not.toHaveBeenCalled();
  });
});
