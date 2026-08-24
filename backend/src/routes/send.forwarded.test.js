import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/redis.js', () => ({
  redisClient: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK'), del: vi.fn() },
}));
vi.mock('../index.js', () => ({ imapManager: { fetchAttachment: vi.fn() } }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));

import express from 'express';
import sendRoutes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const MSG_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const ACCOUNT = { id: ACCOUNT_ID, email_address: 'me@example.com', name: 'Me', sender_name: null, signature: null };

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));
  app.use('/api/mail', sendRoutes);
  return app;
}

describe('POST /api/mail/send — forwarded attachment guards (#F2)', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => { query.mockReset(); imapManager.fetchAttachment.mockReset(); });

  const post = (body) => fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('rejects more than 100 forwarded attachments before doing any DB work', async () => {
    const forwardedAttachments = Array.from({ length: 101 }, () => ({ messageId: MSG_ID, part: '2' }));
    const res = await post({ accountId: ACCOUNT_ID, to: ['x@example.com'], forwardedAttachments });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Too many forwarded attachments/);
    expect(query).not.toHaveBeenCalled();
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('rejects an oversized forwarded batch by declared size, before fetching any attachment', async () => {
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('SELECT preferences FROM users')) return Promise.resolve({ rows: [{ preferences: {} }] });
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) {
        return Promise.resolve({ rows: [{
          id: MSG_ID, uid: 5, folder: 'INBOX', account_id: ACCOUNT_ID,
          attachments: [{ part: '2', size: 30_000_000, filename: 'big.pdf', type: 'application/pdf' }],
        }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await post({
      accountId: ACCOUNT_ID, to: ['x@example.com'],
      forwardedAttachments: [{ messageId: MSG_ID, part: '2' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exceeds 25 MB/);
    // The whole point: no IMAP fetch happens when the declared size already blows the limit.
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });
});
