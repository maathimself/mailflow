import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// "Download all" streams every attachment of a message as one ZIP named after the subject.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: { fetchMultipleAttachments: vi.fn(), broadcast: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const MSG_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

const zipFilename = (res) =>
  decodeURIComponent(res.headers.get('content-disposition').match(/filename\*=UTF-8''(.+)$/)[1]);

describe('GET /api/mail/messages/:id/attachments.zip', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  let row;
  beforeEach(() => {
    query.mockReset();
    imapManager.fetchMultipleAttachments.mockReset().mockResolvedValue(new Map([['2', Buffer.from('pdf')]]));
    row = {
      id: MSG_ID, uid: '42', folder: 'INBOX', subject: 'Quarterly report', account_id: ACCOUNT_ID, user_id: 'user-1',
      attachments: [{ part: '2', filename: 'report.pdf', size: 3, type: 'application/pdf' }],
    };
    query.mockImplementation((sql) => {
      if (sql.includes('FROM messages m')) return Promise.resolve({ rows: [row] });
      if (sql.includes('SELECT * FROM email_accounts')) {
        return Promise.resolve({ rows: [{ id: ACCOUNT_ID, imap_host: 'imap.example.com' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('streams a zip named after the subject', async () => {
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/attachments.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(zipFilename(res)).toBe('Quarterly report-attachments.zip');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
  });

  it('drops an emoji split by the 100-char filename cut instead of failing', async () => {
    row.subject = 'x'.repeat(99) + String.fromCodePoint(0x1f600) + ' tail';
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/attachments.zip`);
    expect(res.status).toBe(200);
    expect(zipFilename(res)).toBe('x'.repeat(99) + '-attachments.zip');
    await res.arrayBuffer();
  });
});
