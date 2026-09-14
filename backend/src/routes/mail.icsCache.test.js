import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: { fetchMessageBody: vi.fn(), noteUserActivity: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const RAW_INVITE = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nSUMMARY:Sync\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function messageRow(overrides) {
  return {
    id: MESSAGE_ID, account_id: 'acc-1', uid: 9, folder: 'INBOX', user_id: 'user-1', preferences: {},
    body_html: null, body_text: null, attachments: '[]', snippet: 'x',
    sender_email: 'a@example.com', sender_name: 'A',
    ...overrides,
  };
}

describe('GET /api/mail/messages/:id/body — cached raw calendar invites (#423)', () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    query.mockReset();
    imapManager.fetchMessageBody.mockReset();
  });

  it('re-fetches a body cached as raw VCALENDAR text and caches the rendered card', async () => {
    query
      .mockResolvedValueOnce({ rows: [messageRow({ body_text: RAW_INVITE })] })
      .mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] })
      .mockResolvedValue({ rows: [] });
    imapManager.fetchMessageBody.mockResolvedValue({
      html: '<div style="border:1px solid #ccc">Sync</div>', text: 'Sync', attachments: [],
    });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(body.html).toContain('Sync');
    expect(body.text).toBe('Sync');
    const update = query.mock.calls.find(([sql]) => /UPDATE messages\s+SET body_html/.test(sql));
    expect(update[1][0]).toContain('Sync');
  });

  it('serves the cache for a plain-text body that merely mentions VCALENDAR', async () => {
    query.mockResolvedValue({ rows: [messageRow({ body_text: 'See the BEGIN:VCALENDAR block below' })] });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);

    expect(response.status).toBe(200);
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('serves the cache for raw calendar text without a VEVENT so it is not re-fetched on every open', async () => {
    const todo = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';
    query.mockResolvedValue({ rows: [messageRow({ body_text: todo })] });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);

    expect(response.status).toBe(200);
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('serves the cache when the raw calendar body already has rendered html next to it', async () => {
    query.mockResolvedValue({ rows: [messageRow({ body_text: RAW_INVITE, body_html: '<p>ok</p>' })] });

    const response = await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body`);

    expect(response.status).toBe(200);
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });
});
