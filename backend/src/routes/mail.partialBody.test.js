// #677: a body fetched from the mail server is stored, and served from storage from then on. So
// one with a text part missing (an HTML email whose HTML part the connection dropped) must never
// reach storeFetchedBody: it would show as plain text for good. Drives the real fetchMessageBody
// behind the real route, against a fake server.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/hostValidation.js', () => ({ resolveForConnection: vi.fn(async () => ({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null })), createPinnedLookup: vi.fn(), validateHost: vi.fn(), validatePort: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn(async () => ({ allowPrivateHosts: true, allowInsecureTls: true })) }));
vi.mock('./oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../services/spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(() => 'pw'), encrypt: vi.fn(v => v) }));
vi.mock('../services/messageBodyStore.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, storeFetchedBody: vi.fn(async (id, body) => ({ sanitized: body.html, safeText: body.text, stored: true })) };
});
vi.mock('../index.js', async () => {
  const { ImapManager } = await import('../services/imapManager.js');
  return { imapManager: new ImapManager({ clients: new Set() }) };
});

import express from 'express';
import { ImapFlow } from 'imapflow';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { storeFetchedBody } from '../services/messageBodyStore.js';

const MSG_ID = '0b6a8f3e-5f2d-4f7a-9d1e-6c2b8a4e1f90';
const structure = {
  type: 'multipart/alternative',
  childNodes: [
    { part: '1', type: 'text/plain', encoding: '7bit', size: 5, parameters: { charset: 'utf-8' } },
    { part: '2', type: 'text/html', encoding: '7bit', size: 12, parameters: { charset: 'utf-8' } },
  ],
};
const parts = { '1': 'hello', '2': '<p>hello</p>' };
let seq = 0;

// Each connection drops at its first fetch of part 2 when `drop(client)` says so.
function serve(drop) {
  let made = 0;
  ImapFlow.mockImplementation(function () {
    const index = made++;
    let dropped = false;
    const client = Object.assign(new EventEmitter(), { usable: true, connect: vi.fn(async () => {}), logout: vi.fn(async () => {}), close: vi.fn(), noop: vi.fn(async () => {}) });
    client.getMailboxLock = vi.fn(async () => ({ release() {} }));
    client.fetch = vi.fn(async function* (range, q) {
      const wanted = q.bodyParts || [];
      if (dropped || (drop(index) && wanted.includes('2'))) { dropped = true; throw new Error('ECONNRESET'); }
      yield { uid: 42, bodyStructure: q.bodyStructure ? structure : undefined, bodyParts: q.bodyParts ? new Map(wanted.map(p => [p, Buffer.from(parts[p])])) : undefined };
    });
    return client;
  });
}

describe('GET /messages/:id/body never stores a partial body (#677)', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    const account = { id: `acct-partial-${++seq}`, user_id: 'user-1', imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: true, email_address: 'p@example.test', auth_user: 'p', auth_pass: 'enc' };
    storeFetchedBody.mockClear();
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (/FROM email_accounts/.test(sql)) return { rows: [account] };
      if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [{ id: MSG_ID, account_id: account.id, uid: 42, folder: 'INBOX', body_html: null, body_text: null, flags: [] }], rowCount: 1 };
    });
  });

  it('stores the whole body after a drop, fetched again over a fresh login', async () => {
    serve(index => index === 0);
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body`);
    expect(res.status).toBe(200);
    expect(storeFetchedBody).toHaveBeenCalledTimes(1);
    expect(storeFetchedBody.mock.calls[0][1]).toMatchObject({ html: '<p>hello</p>', text: 'hello' });
  });

  it('stores nothing when every attempt drops: the open fails instead', async () => {
    serve(() => true);
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(storeFetchedBody).not.toHaveBeenCalled();
  });
});
