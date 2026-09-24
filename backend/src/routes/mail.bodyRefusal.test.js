// #474: while a provider refuses secondary logins, a body click used to surface the raw
// server string as a 500. The route now maps both the typed gate error and a raw refusal
// to a 503 that says what is happening and that retrying will work.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { fetchMessageBody: vi.fn(), prefetchFolderBodies: vi.fn(), noteUserActivity: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const MSG_ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const row = { id: MSG_ID, account_id: 'acct-1', uid: 42, folder: 'INBOX', body_html: null, body_text: null };

describe('GET /messages/:id/body while the provider refuses connections (#474)', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [row] }); imapManager.fetchMessageBody.mockReset(); });

  it('maps the typed gate error to a friendly 503, not a raw 500', async () => {
    imapManager.fetchMessageBody.mockRejectedValue(Object.assign(new Error('Mail server is limiting connections for this account'), { providerRefusing: true }));
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.providerLimited).toBe(true);
    expect(body.error).toMatch(/backing off/i);
  });

  it('maps a raw provider refusal that escaped the gate to the same 503', async () => {
    // e.g. the pool login itself was refused after the gate let the request through.
    imapManager.fetchMessageBody.mockRejectedValue(new Error('[UNAVAILABLE] AUTHENTICATE Server error - Please try again later'));
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body`);
    expect(res.status).toBe(503);
    expect((await res.json()).providerLimited).toBe(true);
  });

  it('leaves an ordinary failure as a 500 so real bugs stay visible', async () => {
    imapManager.fetchMessageBody.mockRejectedValue(new Error('parse exploded'));
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body`);
    expect(res.status).toBe(500);
  });
});
