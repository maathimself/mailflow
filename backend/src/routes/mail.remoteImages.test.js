// Remote images blocked: the body route says whether blocking applies to the message at all
// (remoteImagesBlocked), not only whether it found something to block (hasBlockedRemoteImages),
// so the email frame can forbid remote loads outright behind the rewriting.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { fetchMessageBody: vi.fn(), prefetchFolderBodies: vi.fn(), noteUserActivity: vi.fn() } }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { safeFetch } from '../services/safeFetch.js';

const MSG_ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const PIXEL = '<p>Hi</p><img src="//tracker.example/p.gif" width="1" height="1">';
// Nothing cached (no HTML and no text) sends the route to the mail server.
const row = (body_html, preferences = {}) => ({
  id: MSG_ID, account_id: 'acct-1', uid: 42, folder: 'INBOX', body_html,
  body_text: body_html ? 'Hi' : null, preferences, from_email: 's@sender.example',
});

describe('GET /messages/:id/body and blocked remote images', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.fetchMessageBody.mockReset(); });

  const get = async (query = '') => (await fetch(`${base}/api/mail/messages/${MSG_ID}/body${query}`)).json();

  it('blocks a protocol-relative tracking pixel in a cached body and says so', async () => {
    query.mockResolvedValue({ rows: [row(PIXEL)] });
    const body = await get();
    expect(body.html).not.toContain('tracker.example');
    expect(body.hasBlockedRemoteImages).toBe(true);
    expect(body.remoteImagesBlocked).toBe(true);
  });

  it('blocks it in a body fetched from the server too', async () => {
    query.mockResolvedValue({ rows: [row(null)] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: PIXEL, text: 'Hi', attachments: [] });
    const body = await get();
    expect(body.html).not.toContain('tracker.example');
    expect(body.remoteImagesBlocked).toBe(true);
  });

  it('reports blocking even when nothing remote was found', async () => {
    query.mockResolvedValue({ rows: [row('<p>Plain</p>')] });
    const body = await get();
    expect(body.hasBlockedRemoteImages).toBe(false);
    expect(body.remoteImagesBlocked).toBe(true);
  });

  // Allowed images load through the image proxy: the sender's server never sees the reader.
  it('proxies images that were asked for, allowed, or from an allowed sender', async () => {
    const proxied = `/api/mail/messages/${MSG_ID}/image?u=%2F%2Ftracker.example%2Fp.gif`;
    query.mockResolvedValue({ rows: [row(PIXEL)] });
    const asked = await get('?remoteImages=1');
    expect(asked.remoteImagesBlocked).toBe(false);
    expect(asked.remoteImagesProxied).toBe(true);
    expect(asked.html).toContain(`src="${proxied}"`);
    query.mockResolvedValue({ rows: [row(PIXEL, { blockRemoteImages: false })] });
    expect((await get()).html).toContain(proxied);
    query.mockResolvedValue({ rows: [row(PIXEL, { imageWhitelist: { domains: ['sender.example'] } })] });
    const allowed = await get();
    expect(allowed.remoteImagesProxied).toBe(true);
    expect(allowed.html).not.toMatch(/src="\/\/tracker/);
  });

  it('proxies a body fetched from the server too, and never a blocked one', async () => {
    query.mockResolvedValue({ rows: [row(null, { blockRemoteImages: false })] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: PIXEL, text: 'Hi', attachments: [] });
    const fetched = await get();
    expect(fetched.remoteImagesProxied).toBe(true);
    expect(fetched.html).toContain(`/api/mail/messages/${MSG_ID}/image?u=`);
    query.mockResolvedValue({ rows: [row(PIXEL)] });
    const blocked = await get();
    expect(blocked.remoteImagesProxied).toBe(false);
    expect(blocked.html).not.toContain('/image?u=');
  });
});

describe('GET /messages/:id/image, the image proxy', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); safeFetch.mockReset(); });

  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const BODY = '<p>Hi</p><img src="https://img.example/a.png?x=1&amp;y=2"><img src="//img.example/b.gif">';
  const image = (u, id = MSG_ID) => fetch(`${base}/api/mail/messages/${id}/image?u=${encodeURIComponent(u)}`);
  const upstream = (body, type = 'image/png', status = 200) => ({ status, headers: new Headers({ 'content-type': type }), body: new Blob([body]).stream() });

  it('fetches an image the message holds, as it loads it, and serves it safely', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(PNG, 'application/octet-stream'));
    const res = await image('https://img.example/a.png?x=1&amp;y=2');
    expect(res.status).toBe(200);
    expect(safeFetch.mock.calls[0][0]).toBe('https://img.example/a.png?x=1&y=2');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), PNG)).toBe(0);
    // The query is scoped to the user's own messages.
    expect(query.mock.calls[0][1]).toEqual([MSG_ID, 'user-1']);
  });

  it('loads a protocol-relative image over https', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(Buffer.from('GIF89a\x01\x00\x01\x00')));
    expect((await image('//img.example/b.gif')).status).toBe(200);
    expect(safeFetch.mock.calls[0][0]).toBe('https://img.example/b.gif');
  });

  it('is not an open proxy: anything the message does not hold is refused unfetched', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    expect((await image('https://attacker.example/x.png')).status).toBe(404);
    expect((await image('http://169.254.169.254/latest/meta-data')).status).toBe(404);
    query.mockResolvedValue({ rows: [] });
    expect((await image('https://img.example/a.png?x=1&amp;y=2')).status).toBe(404, 'not the user\'s message');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('refuses a bad message id or a missing reference', async () => {
    expect((await image('https://img.example/a.png', 'not-a-uuid')).status).toBe(400);
    expect((await fetch(`${base}/api/mail/messages/${MSG_ID}/image`)).status).toBe(400);
  });

  it('refuses SVG and non-images from upstream', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'));
    expect((await image('//img.example/b.gif')).status).toBe(415);
    safeFetch.mockResolvedValue(upstream('<script>alert(1)</script>', 'image/png'));
    expect((await image('//img.example/b.gif')).status).toBe(415);
  });

  // The body route writes its served version back without waiting; an image asked for first
  // must still be found.
  it('finds a reference in the body as the route serves it, before that is stored', async () => {
    const EBAY = '<img src="https://svcs.ebay.com/imageser/1/render?imageUrl=https://i.ebayimg.example/a.jpg&amp;w=200">';
    query.mockResolvedValue({ rows: [{ body_html: EBAY }] });
    safeFetch.mockResolvedValue(upstream(PNG));
    const { rewriteEbayImageserUrls } = await import('../services/emailSanitizer.js');
    const served = /src="([^"]*)"/.exec(rewriteEbayImageserUrls(EBAY))[1];
    expect(served).not.toBe(/src="([^"]*)"/.exec(EBAY)[1]);
    expect((await image(served)).status).toBe(200);
  });
});
