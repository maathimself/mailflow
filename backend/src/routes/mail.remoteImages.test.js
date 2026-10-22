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
// A real image cache, in a directory of its own, emptied before each test.
vi.mock('../services/imageCache.js', async (importOriginal) => {
  const real = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return { ...real, imageCache: real.createImageCache({ dir: mkdtempSync(join(tmpdir(), 'mf-img-test-')) }) };
});

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { safeFetch } from '../services/safeFetch.js';
import { imageCache } from '../services/imageCache.js';

const MSG_ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const PIXEL = '<p>Hi</p><img src="//tracker.example/p.gif" width="1" height="1">';
// An ordinary image beside the pixel: allowed, the image loads through the proxy, the pixel never.
const PHOTO = '<p>Hi</p><img src="//img.example/photo.jpg" width="600" height="300"><img src="//tracker.example/p.gif" width="1" height="1">';
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
    // With the width the email shows it at, which the proxy fits it to.
    const proxied = `/api/mail/messages/${MSG_ID}/image?u=%2F%2Fimg.example%2Fphoto.jpg&w=600`;
    query.mockResolvedValue({ rows: [row(PHOTO)] });
    const asked = await get('?remoteImages=1');
    expect(asked.remoteImagesBlocked).toBe(false);
    expect(asked.remoteImagesProxied).toBe(true);
    expect(asked.html).toContain(`src="${proxied}"`);
    query.mockResolvedValue({ rows: [row(PHOTO, { blockRemoteImages: false })] });
    expect((await get()).html).toContain(proxied);
    query.mockResolvedValue({ rows: [row(PHOTO, { imageWhitelist: { domains: ['sender.example'] } })] });
    const allowed = await get();
    expect(allowed.remoteImagesProxied).toBe(true);
    expect(allowed.html).not.toMatch(/src="\/\/img/);
  });

  it('never loads a tracking pixel, even with images allowed, and counts it', async () => {
    query.mockResolvedValue({ rows: [row(PHOTO, { blockRemoteImages: false })] });
    const body = await get();
    expect(body.html).not.toContain('tracker.example');
    expect(body.html).toContain('src="data:image/gif;base64,');
    expect(body.trackersBlocked).toBe(1);
    query.mockResolvedValue({ rows: [row(PHOTO)] });
    expect((await get()).trackersBlocked).toBe(0); // blocked anyway, with every other image
  });

  it('proxies a body fetched from the server too, and never a blocked one', async () => {
    query.mockResolvedValue({ rows: [row(null, { blockRemoteImages: false })] });
    imapManager.fetchMessageBody.mockResolvedValue({ html: PHOTO, text: 'Hi', attachments: [] });
    const fetched = await get();
    expect(fetched.remoteImagesProxied).toBe(true);
    expect(fetched.html).toContain(`/api/mail/messages/${MSG_ID}/image?u=`);
    expect(fetched.trackersBlocked).toBe(1);
    query.mockResolvedValue({ rows: [row(PHOTO)] });
    const blocked = await get();
    expect(blocked.remoteImagesProxied).toBe(false);
    expect(blocked.html).not.toContain('/image?u=');
  });
});

// A large inline photo is fitted for reading; a forward asks for it as it was sent.
describe('GET /messages/:id/body and large inline images', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  it('serves it fitted, and as sent when asked for the original', async () => {
    const { randomBytes } = await import('node:crypto');
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp(randomBytes(2400 * 1600 * 3), { raw: { width: 2400, height: 1600, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    const html = `<p>Photo</p><img src="data:image/jpeg;base64,${jpeg.toString('base64')}">`;
    query.mockResolvedValue({ rows: [row(html)] });
    const read = await (await fetch(`${base}/api/mail/messages/${MSG_ID}/body`)).json();
    expect(read.inlineImagesFitted).toBe(true);
    expect(read.html.length).toBeLessThan(html.length / 3);
    const original = await (await fetch(`${base}/api/mail/messages/${MSG_ID}/body?original=1`)).json();
    expect(original.inlineImagesFitted).toBe(false);
    expect(original.html).toContain(jpeg.toString('base64').slice(0, 200));
  });
});

describe('GET /messages/:id/image, the image proxy', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(async () => { query.mockReset(); safeFetch.mockReset(); await imageCache.clear(); });

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
    expect(res.headers.get('cache-control')).toBe('private, max-age=2592000, immutable');
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
    const OTHER = '9b1c7f0e-2a44-4c1d-8e5f-0a1b2c3d4e5f';
    expect((await image('https://img.example/a.png?x=1&amp;y=2', OTHER)).status).toBe(404, 'not the user\'s message');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('never fetches a tracking pixel the message holds', async () => {
    query.mockResolvedValue({ rows: [{ body_html: '<img src="https://img.example/p.gif" width="1" height="1"><img src="https://u1.ct.sendgrid.net/wf/open?upn=abc">' }] });
    expect((await image('https://img.example/p.gif')).status).toBe(404);
    expect((await image('https://u1.ct.sendgrid.net/wf/open?upn=abc')).status).toBe(404);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('serves an oversized photo scaled down as WebP', async () => {
    const { randomBytes } = await import('node:crypto');
    const sharp = (await import('sharp')).default;
    const photo = await sharp(randomBytes(3000 * 2000 * 3), { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(photo, 'image/jpeg'));
    const res = await image('https://img.example/a.png?x=1&amp;y=2');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const sent = Buffer.from(await res.arrayBuffer());
    expect(sent.length).toBeLessThan(photo.length / 2);
    expect((await sharp(sent).metadata()).width).toBe(1280); // no width given: twice a usual email column
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

  // Served once, kept: a second view, on this device or another, does not ask the sender again.
  it('serves an image again from its cache, and a browser that has it gets a 304', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(PNG));
    const first = await image('//img.example/b.gif');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    await new Promise(r => setTimeout(r, 50)); // the write to disk
    const again = await image('//img.example/b.gif');
    expect(again.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await again.arrayBuffer()), PNG)).toBe(0);
    const revalidated = await fetch(`${base}/api/mail/messages/${MSG_ID}/image?u=${encodeURIComponent('//img.example/b.gif')}`, { headers: { 'If-None-Match': etag } });
    expect(revalidated.status).toBe(304);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure for a while instead of asking the sender again on every open', async () => {
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream('gone', 'text/html', 404));
    expect((await image('//img.example/b.gif')).status).toBe(404);
    const again = await image('//img.example/b.gif');
    expect(again.status).toBe(404);
    expect(again.headers.get('cache-control')).toBe('private, max-age=600');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('fits an image to the width the email shows it at', async () => {
    const { randomBytes } = await import('node:crypto');
    const sharp = (await import('sharp')).default;
    const photo = await sharp(randomBytes(1200 * 800 * 3), { raw: { width: 1200, height: 800, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
    query.mockResolvedValue({ rows: [{ body_html: BODY }] });
    safeFetch.mockResolvedValue(upstream(photo, 'image/jpeg'));
    const res = await fetch(`${base}/api/mail/messages/${MSG_ID}/image?u=${encodeURIComponent('//img.example/b.gif')}&w=200`);
    expect(res.status).toBe(200);
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(400);
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
