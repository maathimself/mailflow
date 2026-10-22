// #228: the body route sends the sender's dark CSS and the light-only request as their own
// fields, so the HTML the reader reuses for replies, forwards and print is the email alone.
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
import { sanitizeEmail } from '../services/emailSanitizer.js';

const MSG_ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const RAW = '<style>.a{color:#111}@media (prefers-color-scheme: dark){.a{color:#eee}}</style><p class="a">Hi</p>';
// Nothing cached (no HTML and no text) sends the route to the mail server.
const row = (body_html) => ({ id: MSG_ID, account_id: 'acct-1', uid: 42, folder: 'INBOX', body_html, body_text: body_html ? 'Hi' : null, preferences: {}, from_email: 's@example.com' });

describe('GET /messages/:id/body and dark email bodies (#228)', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.fetchMessageBody.mockReset(); });

  const get = async () => (await fetch(`${base}/api/mail/messages/${MSG_ID}/body`)).json();

  it('splits a cached body', async () => {
    query.mockResolvedValue({ rows: [row(sanitizeEmail(RAW))] });
    const body = await get();
    expect(body.html).toBe('<style>.a{color:#111}</style><p class="a">Hi</p>');
    expect(body.darkCss).toBe('@media (min-width: 0px){.a{color:#eee}}');
    expect(body.lightOnly).toBe(false);
  });

  it('splits a body fetched from the server', async () => {
    query.mockResolvedValue({ rows: [row(null)] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: RAW, text: 'Hi', attachments: [] });
    const body = await get();
    expect(body.html).not.toContain('data-mf-dark-scheme');
    expect(body.darkCss).toBe('@media (min-width: 0px){.a{color:#eee}}');
  });

  it('reports a sender that asked to stay light, without its marker in the HTML', async () => {
    query.mockResolvedValue({ rows: [row(sanitizeEmail('<style>:root{color-scheme: light only}</style><p>Hi</p>'))] });
    const body = await get();
    expect(body.lightOnly).toBe(true);
    expect(body.darkCss).toBeNull();
    expect(body.html).not.toContain('mf-light-only');
  });
});
