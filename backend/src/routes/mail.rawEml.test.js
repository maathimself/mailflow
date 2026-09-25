import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// #381: download a message as .eml. The route serves the raw RFC 822 source with a
// filename derived from the subject, and never serves another user's message.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: { fetchRawMessage: vi.fn(), broadcast: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const MSG_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const RAW = 'From: a@b.c\r\nSubject: Quarterly report\r\n\r\nBody\r\n';

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

describe('GET /api/mail/messages/:id/raw.eml (#381)', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.fetchRawMessage.mockReset().mockResolvedValue(Buffer.from(RAW));
    query.mockImplementation((sql) => {
      if (sql.includes('FROM messages m')) {
        return Promise.resolve({ rows: [{ id: MSG_ID, uid: '42', folder: 'INBOX', subject: 'Quarterly report', account_id: ACCOUNT_ID, user_id: 'user-1' }] });
      }
      if (sql.includes('SELECT * FROM email_accounts')) {
        return Promise.resolve({ rows: [{ id: ACCOUNT_ID, imap_host: 'imap.example.com' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('serves the raw source with the rfc822 type and a subject-derived filename', async () => {
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('message/rfc822');
    expect(res.headers.get('content-disposition')).toContain('.eml');
    expect(res.headers.get('content-disposition')).toContain('Quarterly');
    expect(await res.text()).toBe(RAW);
    expect(imapManager.fetchRawMessage.mock.calls[0].slice(1)).toEqual(['42', 'INBOX']);
  });

  it('404s a message the user does not own, without touching IMAP', async () => {
    query.mockImplementation(() => Promise.resolve({ rows: [] })); // ownership join finds nothing
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(404);
    expect(imapManager.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('rejects a malformed id before any query', async () => {
    const res = await fetch(`${base}/api/mail/messages/not-a-uuid/raw.eml`);
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('404s when the server has no source for the UID', async () => {
    imapManager.fetchRawMessage.mockResolvedValue(null);
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/raw.eml`);
    expect(res.status).toBe(404);
  });
});
