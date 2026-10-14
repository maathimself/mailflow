// #595: a cached body with cid: references that can never resolve is not fetched from the mail
// server on every view, while one cached before inline images were embedded is repaired once.
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
import { CIDS_SETTLED } from '../utils/cidRefs.js';

const MSG_ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const MISSING = '<p>hi</p><img src="cid:missing@x">';
const row = (body_html) => ({ id: MSG_ID, account_id: 'acct-1', uid: 42, folder: 'INBOX', body_html, body_text: 'hi', preferences: {}, from_email: 's@example.com' });

describe('GET /messages/:id/body and cid: references', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.fetchMessageBody.mockReset(); });

  const get = async () => (await fetch(`${base}/api/mail/messages/${MSG_ID}/body`)).json();
  const stored = () => query.mock.calls.find(([sql]) => /SET body_html = \$1, body_text = \$2/.test(sql))?.[1][0];

  it('serves a settled body from the cache, without the marker', async () => {
    query.mockResolvedValue({ rows: [row(`${MISSING}${CIDS_SETTLED}`)] });
    const body = await get();
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
    expect(body.html).toContain('cid:missing@x');
    expect(body.html).not.toContain('mf-cids-settled');
  });

  it('does not fetch a body again for the text "CID:" in it', async () => {
    query.mockResolvedValue({ rows: [row('<p>Your CID: 4521</p>')] });
    await get();
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('repairs a body cached before the marker once, and stores it settled when the fetch was complete', async () => {
    query.mockResolvedValue({ rows: [row(MISSING)] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: MISSING, text: 'hi', attachments: [], cidsComplete: true });
    const body = await get();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(stored()).toContain(CIDS_SETTLED);
    expect(body.html).not.toContain('mf-cids-settled');
  });

  it('keeps retrying a body whose image bytes did not arrive', async () => {
    query.mockResolvedValue({ rows: [row(MISSING)] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: MISSING, text: 'hi', attachments: [], cidsComplete: false });
    await get();
    expect(stored()).not.toContain(CIDS_SETTLED);
  });

  it('two views of a settled message make one fetch in all', async () => {
    let cached = MISSING;
    query.mockImplementation(async (sql, params) => {
      if (/SET body_html = \$1, body_text = \$2/.test(sql)) { cached = params[0]; return { rows: [] }; }
      return { rows: [row(cached)] };
    });
    imapManager.fetchMessageBody.mockResolvedValue({ html: MISSING, text: 'hi', attachments: [], cidsComplete: true });
    await get();
    await get();
    await get();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });
});
