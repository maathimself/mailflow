import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

// The photo is served on the app origin, so it has to go out as an image type whatever its
// stored data: URI declares. These rows skip parseVCard, like rows saved before it checked.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));

import express from 'express';
import contactsRoutes from './contacts.js';
import { query } from '../services/db.js';

const HTML = Buffer.from('<p>not an image</p>');
const PHOTO_URL = '/api/contacts/photo?email=a%40example.com';

function buildApp() {
  const app = express();
  app.use('/api/contacts', contactsRoutes);
  // Sends these bytes as HTML the way the photo route used to, with the ETag Express gives them.
  app.get('/as-html', (_req, res) => res.type('html').send(HTML));
  return app;
}

describe('GET /api/contacts/photo', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => { query.mockReset(); });

  const storePhoto = (photoData) => query.mockResolvedValue({ rows: [{ photo_data: photoData }] });
  const fetchPhoto = (photoData) => {
    storePhoto(photoData);
    return fetch(`${base}${PHOTO_URL}`);
  };
  // Not fetch(): it adds Cache-Control: no-cache to a request that sets If-None-Match, and
  // Express never answers 304 to that, so it cannot stand in for a browser revalidating.
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });

  it.each(['text/html', 'text/javascript', 'image/svg+xml', 'application/xhtml+xml', 'application/octet-stream'])('serves a stored %s photo as image/jpeg', async (type) => {
    const res = await fetchPhoto(`data:${type};base64,${HTML.toString('base64')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('keeps an allowed image type and sends the decoded bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await fetchPhoto(`data:image/png;base64,${png.toString('base64')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
  });

  it.each([
    ['row still text/html', 'text/html'],
    ['row relabelled by a later sync', 'image/jpeg'],
  ])('does not answer 304 to a copy cached as HTML (%s)', async (_label, type) => {
    const cachedTag = (await get('/as-html')).headers.etag;
    storePhoto(`data:${type};base64,${HTML.toString('base64')}`);
    const res = await get(PHOTO_URL, { 'If-None-Match': cachedTag });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    // The new validator still earns a 304, so photos stay cacheable.
    expect((await get(PHOTO_URL, { 'If-None-Match': res.headers.etag })).statusCode).toBe(304);
  });
});
