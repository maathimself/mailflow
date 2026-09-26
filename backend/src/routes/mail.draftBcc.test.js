import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Same mock surface the other mail.* route tests use so importing mail.js is side-effect free.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: { fetchHeaders: vi.fn(), noteUserActivity: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let ctx;
beforeEach(async () => {
  query.mockReset();
  imapManager.fetchHeaders.mockReset();
  imapManager.noteUserActivity.mockReset();
  if (!ctx) ctx = await startServer();
});
afterAll(() => ctx?.server?.close());

// First query: the message row. Second: the account row.
function mockDraft(bccAddresses, messageId = '<d1@example.com>') {
  query
    .mockResolvedValueOnce({ rows: [{ account_id: ACCOUNT_ID, uid: 7, folder: 'Drafts', message_id: messageId, bcc_addresses: bccAddresses }] })
    .mockResolvedValueOnce({ rows: [{ id: ACCOUNT_ID }] })
    .mockResolvedValue({ rows: [] });
}

const getBcc = async () => {
  const res = await fetch(`${ctx.base}/api/mail/messages/${MESSAGE_ID}/bcc`);
  return { status: res.status, body: await res.json() };
};

describe('GET /messages/:id/bcc — a saved draft\'s Bcc for the composer', () => {
  it('returns the Bcc MailFlow stored with the draft, without asking the server', async () => {
    const stored = [{ name: 'Hidden Person', email: 'hidden@example.com' }];
    mockDraft(stored);
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: stored });
    expect(imapManager.fetchHeaders).not.toHaveBeenCalled();
  });

  it('returns a stored empty Bcc as empty, without asking the server', async () => {
    mockDraft([]);
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [] });
    expect(imapManager.fetchHeaders).not.toHaveBeenCalled();
  });

  it('reads an unknown Bcc from the server copy: folded, encoded, and a quoted comma', async () => {
    // A draft saved before bcc_addresses existed, or by another client.
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue([
      'From: a@example.com',
      'Message-ID: <d1@example.com>',
      'Bcc: "Doe, Jane" <jane@example.com>, =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?=',
      ' <jm@example.de>, plain@example.org',
      '',
    ].join('\r\n'));
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [
      { name: 'Doe, Jane', email: 'jane@example.com' },
      { name: 'Jürgen Müller', email: 'jm@example.de' },
      { name: '', email: 'plain@example.org' },
    ] });
    expect(imapManager.fetchHeaders).toHaveBeenCalledWith({ id: ACCOUNT_ID }, 7, 'Drafts');
  });

  it('keeps every recipient when the server copy has more than one Bcc line', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue('Message-ID: <d1@example.com>\r\nBcc: one@example.com\r\nBcc: two@example.com\r\n');
    const { body } = await getBcc();
    expect(body.bcc.map(r => r.email)).toEqual(['one@example.com', 'two@example.com']);
  });

  it('returns an empty Bcc when the server copy has headers but no Bcc', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nMessage-ID: <d1@example.com>\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [] });
  });

  // Each of these used to open the draft with an empty Bcc, which its next save made permanent.
  it('fails rather than answer empty when the server returns no headers', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockResolvedValue('');
    const { status, body } = await getBcc();
    expect(status).toBe(502);
    expect(body).not.toHaveProperty('bcc');
  });

  it('fails rather than answer empty when the server cannot be reached', async () => {
    mockDraft(null);
    imapManager.fetchHeaders.mockRejectedValue(Object.assign(new Error('pool exhausted'), { poolExhausted: true }));
    const { status, body } = await getBcc();
    expect(status).toBe(502);
    expect(body).not.toHaveProperty('bcc');
  });

  it('refuses a uid that now holds a different message', async () => {
    mockDraft(null, '<d1@example.com>');
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nMessage-ID: <other@example.com>\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(409);
    expect(body).not.toHaveProperty('bcc');
  });

  it('refuses a server copy without the Message-ID the row has', async () => {
    // Sync stores NULL for a message with no Message-ID, so this is never the same message.
    mockDraft(null, '<d1@example.com>');
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(409);
    expect(body).not.toHaveProperty('bcc');
  });

  it('reads a draft whose row has no Message-ID', async () => {
    mockDraft(null, null);
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [{ name: '', email: 'someone@example.com' }] });
  });

  it('matches Message-IDs regardless of brackets, whitespace and case', async () => {
    mockDraft(null, '<D1@Example.com>');
    imapManager.fetchHeaders.mockResolvedValue('From: a@example.com\r\nMessage-ID:\r\n <d1@example.com>\r\nBcc: someone@example.com\r\n');
    const { status, body } = await getBcc();
    expect(status).toBe(200);
    expect(body).toEqual({ bcc: [{ name: '', email: 'someone@example.com' }] });
  });

  it('answers 404 for a message the user does not own, without touching IMAP', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const { status, body } = await getBcc();
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Message not found' });
    expect(query.mock.calls[0][1]).toEqual([MESSAGE_ID, 'user-1']);
    expect(imapManager.fetchHeaders).not.toHaveBeenCalled();
  });
});
