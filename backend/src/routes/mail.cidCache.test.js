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
const row = (body_html, extra) => ({ id: MSG_ID, account_id: 'acct-1', uid: 42, folder: 'INBOX', body_html, body_text: 'hi', preferences: {}, from_email: 's@example.com', ...extra });

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

// #640: images an email uses in its own layout showed as broken attachments in bodies fetched
// before 4.0.4, and the cached body was served without a cid: reference left to send it back.
describe('GET /messages/:id/body and bodies fetched before images showed (#640)', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.fetchMessageBody.mockReset(); });

  // Each test a message of its own: a failed repair is remembered per message.
  let n = 0;
  const OLD = '<p>Newsletter</p><img src="hdr.jpg">';
  const NEW = '<p>Newsletter</p><img src="data:image/jpeg;base64,/9j/">';
  const IMAGE = [{ part: '2', filename: 'hdr.jpg', type: 'image/jpeg', size: 900 }];
  // The messages table, as the route reads and writes it.
  function table(body_html, extra) {
    const id = `4d479e4f-9b21-4013-9c07-${String(++n).padStart(12, '0')}`;
    const state = { body_html, body_text: 'hi', attachments: extra?.attachments ?? IMAGE, writes: 0 };
    query.mockImplementation(async (sql, params) => {
      if (/SET body_html = \$1, body_text = \$2/.test(sql)) {
        // A repair's store lands only on the body it started from.
        if (/IS NOT DISTINCT FROM \$6/.test(sql) && (params[5] !== state.body_html || params[6] !== state.body_text)) return { rows: [], rowCount: 0 };
        state.body_html = params[0];
        state.body_text = params[1];
        state.attachments = JSON.parse(params[2]);
        state.writes++;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE messages SET body_html = \$1 WHERE/.test(sql)) {
        if (/AND body_html = \$3/.test(sql) && params[2] !== state.body_html) return { rows: [], rowCount: 0 };
        state.body_html = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/FROM email_accounts WHERE id/.test(sql)) return { rows: [{ id: 'acct-1' }] };
      return { rows: [{ ...row(state.body_html, extra), id, body_text: state.body_text, attachments: state.attachments }] };
    });
    const view = async () => {
      const res = await fetch(`${base}/api/mail/messages/${id}/body`);
      return { status: res.status, ...(await res.json()) };
    };
    return { state, view };
  }

  it('fetches a body stored without the marker once when its message has an image attachment', async () => {
    const { state, view } = table(OLD);
    imapManager.fetchMessageBody.mockResolvedValue({ html: NEW, text: 'hi', attachments: [{ ...IMAGE[0], shownInline: true }], cidsComplete: true });
    const first = await view();
    expect(first.html).toContain('data:image/jpeg;base64,/9j/');
    expect(first.html).not.toContain('mf-cids-settled');
    expect(first.attachments).toEqual([expect.objectContaining({ shownInline: true })]);
    expect(state.body_html).toContain(CIDS_SETTLED);
    await view();
    await view();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('fetches a body settled under the 4.0.3 marker once more', async () => {
    const { view } = table(`${OLD}<img src="cid:hdr.jpg"><!--mf-cids-settled:2-->`, { attachments: [] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: NEW, text: 'hi', attachments: [], cidsComplete: true });
    await view();
    await view();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('serves a body as stored when its message has no image attachment, or it has the marker, or it is a draft', async () => {
    for (const [html, extra] of [
      [OLD, { attachments: [{ part: '2', filename: 'invoice.pdf', type: 'application/pdf' }] }],
      [OLD, { attachments: [] }],
      [`${OLD}${CIDS_SETTLED}`, undefined],
      [OLD, { flags: ['\\Seen', '\\Draft'] }],
    ]) {
      const { view } = table(html, extra);
      const body = await view();
      expect(body.html).toContain('hdr.jpg');
    }
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('serves the stored body when the repair fetch fails, and does not try again on the next views', async () => {
    const { state, view } = table(OLD);
    imapManager.fetchMessageBody.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:993'));
    const first = await view();
    expect(first.status).toBe(200);
    expect(first.html).toContain('<img src="hdr.jpg">');
    expect(first.attachments).toEqual(IMAGE);
    await view();
    await view();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(state.writes).toBe(0);
    expect(state.body_html).not.toContain(CIDS_SETTLED);
  });

  it('serves the stored body when the message is gone from the server', async () => {
    const { state, view } = table(OLD);
    imapManager.fetchMessageBody.mockResolvedValue({ html: null, text: null, attachments: [] });
    const first = await view();
    expect(first.html).toContain('<img src="hdr.jpg">');
    expect(first.attachments).toEqual(IMAGE);
    await view();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(state.body_html).toBe(OLD);
  });

  it('does not fetch again on every view a body whose HTML sanitizes to nothing', async () => {
    for (const html of ['   ', '<script>x()</script>']) {
      const { state, view } = table(OLD);
      imapManager.fetchMessageBody.mockReset();
      imapManager.fetchMessageBody.mockResolvedValue({ html, text: 'hi', attachments: IMAGE, cidsComplete: true });
      await view();
      await view();
      await view();
      expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
      expect(state.body_html === null || state.body_html.includes(CIDS_SETTLED)).toBe(true);
    }
    // One stored empty by an earlier MailFlow is not fetched at all.
    imapManager.fetchMessageBody.mockReset();
    const { view } = table('');
    await view();
    await view();
    expect(imapManager.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('keeps the stored HTML when the repair fetch brings text alone, and does not fetch it again', async () => {
    const { state, view } = table(OLD);
    imapManager.fetchMessageBody.mockResolvedValue({ html: null, text: 'hi', attachments: [], cidsComplete: true });
    const first = await view();
    expect(first.html).toContain('<img src="hdr.jpg">');
    expect(first.attachments).toEqual(IMAGE);
    await view();
    await view();
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(state.body_html).toBe(`${OLD}${CIDS_SETTLED}`);
  });

  it('shares one repair fetch among views of a message at the same time', async () => {
    const { state, view } = table(OLD);
    let finish;
    imapManager.fetchMessageBody.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const views = Array.from({ length: 5 }, () => view());
    await vi.waitFor(() => expect(imapManager.fetchMessageBody).toHaveBeenCalled());
    finish({ html: NEW, text: 'hi', attachments: IMAGE, cidsComplete: true });
    for (const body of await Promise.all(views)) expect(body.html).toContain('data:image/jpeg;base64,/9j/');
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(state.writes).toBe(1);
  });

  it('serves the stored body when the repair fetch is slow, and stores the fetched one when it arrives', async () => {
    const { state, view } = table(OLD);
    let finish;
    imapManager.fetchMessageBody.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = view();
      await vi.waitFor(() => expect(imapManager.fetchMessageBody).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(7_900);
      let done = false;
      pending.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const first = await pending;
      expect(first.html).toContain('<img src="hdr.jpg">');
    } finally {
      vi.useRealTimers();
    }
    // The next views do not wait on it again.
    expect((await view()).html).toContain('<img src="hdr.jpg">');
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
    finish({ html: NEW, text: 'hi', attachments: IMAGE, cidsComplete: true });
    await vi.waitFor(() => expect(state.body_html).toContain(CIDS_SETTLED));
    expect((await view()).html).toContain('data:image/jpeg;base64,/9j/');
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });

  it('does not store a late repair over a body stored since it started', async () => {
    const { state, view } = table(OLD);
    let finish;
    imapManager.fetchMessageBody.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = view();
      await vi.waitFor(() => expect(imapManager.fetchMessageBody).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(8_100);
      expect((await pending).html).toContain('<img src="hdr.jpg">');
    } finally {
      vi.useRealTimers();
    }
    // The UID now holds another message, whose body sync and a prefetch stored.
    const other = `<p>Another message</p>${CIDS_SETTLED}`;
    state.body_html = other;
    state.body_text = 'another';
    finish({ html: NEW, text: 'hi', attachments: IMAGE, cidsComplete: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(state.body_html).toBe(other);
    expect(state.writes).toBe(0);
  });

  it('still fails a fetch it could not serve as stored, as before', async () => {
    const { view } = table(MISSING, { attachments: [] });
    imapManager.fetchMessageBody.mockRejectedValue(new Error('boom'));
    expect((await view()).status).toBe(500);
    expect((await view()).status).toBe(500);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(2);
  });

  it('keeps the marker through the rewrites the cache path stores back', async () => {
    const { state, view } = table('<html><head><title>x</title></head><body><a href="example.com">x</a><img src="hdr.jpg"></body></html>');
    imapManager.fetchMessageBody.mockResolvedValue({
      html: '<html><head><style>p{}</style></head><body><a href="example.com">x</a><img src="data:image/jpeg;base64,/9j/"></body></html>',
      text: 'hi', attachments: IMAGE, cidsComplete: true,
    });
    await view();
    await view();
    await view();
    expect(state.body_html).toContain(CIDS_SETTLED);
    expect(imapManager.fetchMessageBody).toHaveBeenCalledTimes(1);
  });
});
