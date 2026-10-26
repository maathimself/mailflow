// #677: the client loads a row's body while the pointer rests on it, with ?prefetch=1. The server
// fetches it from the mail server only when imapManager.prefetchBodyVerdict allows, and a prefetch
// never counts as the user's activity.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../utils/cidRefs.js', async (importOriginal) => ({ ...(await importOriginal()), needsImageRefetch: vi.fn(() => false) }));
vi.mock('../index.js', () => ({ imapManager: { fetchMessageBody: vi.fn(), prefetchFolderBodies: vi.fn(), noteUserActivity: vi.fn(), prefetchBodyVerdict: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { needsImageRefetch } from '../utils/cidRefs.js';

const MSG_ID = '6f1e1b0c-2a51-4c8e-9a43-0d6c1f0f9a77';
const ACCOUNT = { id: 'acct-1', imap_host: 'imap.gmail.com' };
const uncached = { id: MSG_ID, account_id: 'acct-1', uid: 42, folder: 'INBOX', body_html: null, body_text: null, flags: [] };

describe('GET /messages/:id/body?prefetch=1 (#677)', () => {
  let server, base, row, writes;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    row = uncached;
    writes = [];
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (/FROM email_accounts WHERE id/.test(sql)) return { rows: [ACCOUNT] };
      if (/^\s*UPDATE/i.test(sql)) { writes.push(sql); return { rows: [], rowCount: 1 }; }
      return { rows: [row], rowCount: 1 };
    });
    for (const fn of Object.values(imapManager)) fn.mockReset();
    needsImageRefetch.mockReturnValue(false);
    imapManager.fetchMessageBody.mockResolvedValue({ html: '<p>hello</p>', text: 'hello', attachments: [], cidsComplete: true });
  });

  for (const verdict of ['later', 'never']) {
    it(`answers 204 (X-Prefetch: ${verdict}) without touching the mail server or storing anything`, async () => {
      imapManager.prefetchBodyVerdict.mockReturnValue(verdict);
      const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body?prefetch=1`);
      expect(res.status).toBe(204);
      expect(res.headers.get('x-prefetch')).toBe(verdict);
      expect(imapManager.prefetchBodyVerdict).toHaveBeenCalledWith(ACCOUNT);
      expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
      expect(imapManager.noteUserActivity).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });
  }

  it('leaves a stored body due its image repair to the click (X-Prefetch: repair)', async () => {
    row = { ...uncached, body_html: '<p>stored</p>', body_text: 'stored', snippet: 'stored' };
    needsImageRefetch.mockReturnValue(true);
    imapManager.prefetchBodyVerdict.mockReturnValue('yes');
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body?prefetch=1`);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-prefetch')).toBe('repair');
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    // The click repairs it, as before.
    const view = await fetch(`${base}/api/mail/messages/${MSG_ID}/body`);
    expect(view.status).toBe(200);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('fetches when allowed, without counting as the user\'s activity', async () => {
    imapManager.prefetchBodyVerdict.mockReturnValue('yes');
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body?prefetch=1`);
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('hello');
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    // As background work, which leaves the pool's last idle session to the click.
    expect(imapManager.fetchMessageBody.mock.calls[0][3]).toEqual({ background: true });
    expect(imapManager.noteUserActivity).not.toHaveBeenCalled();
  });

  it('serves a stored body without asking whether it may fetch', async () => {
    row = { ...uncached, body_html: '<p>stored</p>', body_text: 'stored', snippet: 'stored' };
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body?prefetch=1`);
    expect(res.status).toBe(200);
    expect((await res.json()).html).toContain('stored');
    expect(imapManager.prefetchBodyVerdict).not.toHaveBeenCalled();
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('an ordinary view still counts as the user\'s activity and is never gated', async () => {
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/body`);
    expect(res.status).toBe(200);
    expect(imapManager.noteUserActivity).toHaveBeenCalledWith('acct-1');
    expect(imapManager.prefetchBodyVerdict).not.toHaveBeenCalled();
    expect(imapManager.fetchMessageBody.mock.calls[0][3]).toEqual({ background: false });
  });
});
