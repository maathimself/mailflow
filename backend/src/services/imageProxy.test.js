// The image proxy: its URLs, what it accepts as an image, and how it fetches.
import { describe, it, expect } from 'vitest';
import { imageProxyPath, sniffImageType, fetchProxiedImage, createUserLimiter } from './imageProxy.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const response = (body, { status = 200, type = 'image/png', length } = {}) => ({
  status,
  headers: new Headers({ 'content-type': type, ...(length !== undefined ? { 'content-length': String(length) } : {}) }),
  body: new Blob([body]).stream(),
});

describe('imageProxyPath', () => {
  it('carries the reference as written, encoded to letters, digits and - . _ ~ % only', () => {
    const raw = "https://img.example/a'b(c)*!.png?x=1&amp;y=\"2\" ";
    const path = imageProxyPath('4d479e4f-9b21-4013-9c07-3fbc35f275b1', raw);
    expect(path).toMatch(/^\/api\/mail\/messages\/4d479e4f-9b21-4013-9c07-3fbc35f275b1\/image\?u=[A-Za-z0-9%._~-]+$/);
    expect(decodeURIComponent(path.split('?u=')[1])).toBe(raw);
  });
});

// The frontend turns proxy URLs back into the email's own references for replies and forwards
// (frontend utils/imageProxy.js). The two packages must agree on the format.
it('is reversed exactly by the frontend', async () => {
  const { unproxyImages } = await import('../../../frontend/src/utils/imageProxy.js');
  const id = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
  for (const raw of ['https://img.example/a.png?x=1&amp;y=2', ' //img.example/b.png', "https://img.example/a(1)'*!.png", 'https://img.example/ünï cødé.png']) {
    const html = `<img src="${raw}"><style>.a{background:url('${raw}')}</style>`;
    const proxied = html.split(raw).join(imageProxyPath(id, raw));
    expect(unproxyImages(proxied)).toBe(html);
  }
});

describe('sniffImageType', () => {
  it('knows raster images by their first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('\0\0\0\x1cftypavif'))).toBe('image/avif');
  });
  it('refuses SVG, HTML and anything else, whatever the server called it', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('fetchProxiedImage', () => {
  it('returns the image under its detected type, asking without cookies or referrer', async () => {
    let asked;
    const out = await fetchProxiedImage('https://img.example/a.png', {
      fetchImpl: async (url, options) => { asked = { url, options }; return response(PNG, { type: 'application/octet-stream' }); },
    });
    expect(out.type).toBe('image/png');
    expect(Buffer.compare(out.bytes, PNG)).toBe(0);
    expect(asked.url).toBe('https://img.example/a.png');
    expect(asked.options.redirect).toBe('follow');
    expect(Object.keys(asked.options.headers).map(h => h.toLowerCase()).sort()).toEqual(['accept', 'user-agent']);
  });

  const failsWith = async (status, upstream) => {
    await expect(fetchProxiedImage('https://img.example/x', { fetchImpl: async () => upstream })).rejects.toMatchObject({ status });
  };
  it('answers 404 for an image that is gone, 502 for other upstream failures', async () => {
    await failsWith(404, response(PNG, { status: 404 }));
    await failsWith(404, response(PNG, { status: 410 }));
    await failsWith(502, response(PNG, { status: 500 }));
    await failsWith(502, response(PNG, { status: 302 }));
    await expect(fetchProxiedImage('https://img.example/x', { fetchImpl: async () => { throw new Error('ERR_BLOCKED_PRIVATE_IP'); } }))
      .rejects.toMatchObject({ status: 502 });
  });
  it('refuses SVG, and bytes that are not a raster image', async () => {
    await failsWith(415, response('<svg xmlns="http://www.w3.org/2000/svg"/>', { type: 'image/svg+xml' }));
    await failsWith(415, response('<html>not an image</html>', { type: 'image/png' }));
  });
  it('refuses images over the size limit, declared or not', async () => {
    await expect(fetchProxiedImage('https://img.example/x', { maxBytes: 10, fetchImpl: async () => response(PNG, { length: 1000 }) }))
      .rejects.toMatchObject({ status: 413 });
    await expect(fetchProxiedImage('https://img.example/x', { maxBytes: 10, fetchImpl: async () => response(PNG) }))
      .rejects.toMatchObject({ status: 413 });
  });
});

describe('createUserLimiter', () => {
  it('runs at most `limit` tasks at once per user, the rest in turn, and other users alongside', async () => {
    const run = createUserLimiter(2);
    let active = 0;
    let peak = 0;
    const releases = [];
    const task = () => new Promise((resolve) => {
      active += 1; peak = Math.max(peak, active);
      releases.push(() => { active -= 1; resolve(); });
    });
    const userA = [run('a', task), run('a', task), run('a', task), run('a', task)];
    await new Promise(r => setTimeout(r, 0));
    expect(active).toBe(2);
    const userB = run('b', task);
    await new Promise(r => setTimeout(r, 0));
    expect(active).toBe(3, 'another user is not held up');
    while (releases.length) { releases.shift()(); await new Promise(r => setTimeout(r, 0)); }
    await Promise.all([...userA, userB]);
    expect(peak).toBe(3);
  });

  it('frees the slot when a task fails', async () => {
    const run = createUserLimiter(1);
    await expect(run('a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(run('a', async () => 'ok')).resolves.toBe('ok');
  });
});
