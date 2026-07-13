import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import senderFaviconsRouter, { createSenderFaviconHandler } from './senderFavicons.js';

function request(domain = 'example.com') {
  return { params: { domain }, session: { userId: 7 } };
}

function response() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    set: vi.fn(function set(name, value) { this.headers[name] = value; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    send: vi.fn(function send(body) { this.body = body; return this; }),
    end: vi.fn(function end() { return this; }),
  };
}

function dependencies(preferences = {}) {
  return {
    queryFn: vi.fn(async () => ({ rows: [{ preferences }] })),
    consumeFn: vi.fn(async () => ({ limited: false, resetMs: 60_000 })),
    getFavicon: vi.fn(async () => ({ kind: 'miss', reason: 'not-found' })),
    normalizeDomain: vi.fn(value => value === 'bad' ? null : value.toLowerCase()),
  };
}

describe('createSenderFaviconHandler', () => {
  it('returns before normalization, limiter, cache, or provider when explicitly disabled', async () => {
    const deps = dependencies({ senderFavicons: false });
    const res = response();
    await createSenderFaviconHandler(deps)(request(), res);
    expect(res.statusCode).toBe(404);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(deps.normalizeDomain).not.toHaveBeenCalled();
    expect(deps.consumeFn).not.toHaveBeenCalled();
    expect(deps.getFavicon).not.toHaveBeenCalled();
  });

  it('treats a missing preference as enabled', async () => {
    const deps = dependencies({});
    await createSenderFaviconHandler(deps)(request(), response());
    expect(deps.consumeFn).toHaveBeenCalledWith('sender-favicon:7', 300, 60_000);
    expect(deps.getFavicon).toHaveBeenCalledWith('example.com');
  });

  it('returns 400 for an invalid domain before rate limiting', async () => {
    const deps = dependencies();
    const res = response();
    await createSenderFaviconHandler(deps)(request('bad'), res);
    expect(res.statusCode).toBe(400);
    expect(deps.consumeFn).not.toHaveBeenCalled();
    expect(deps.getFavicon).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After without resolving an image', async () => {
    const deps = dependencies();
    deps.consumeFn.mockResolvedValue({ limited: true, resetMs: 1500 });
    const res = response();
    await createSenderFaviconHandler(deps)(request(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('2');
    expect(deps.getFavicon).not.toHaveBeenCalled();
  });

  it('returns validated bytes with exact private no-store headers', async () => {
    const deps = dependencies();
    const bytes = Buffer.from('png');
    deps.getFavicon.mockResolvedValue({ kind: 'image', bytes, source: 'cache' });
    const res = response();
    await createSenderFaviconHandler(deps)(request(), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'Cache-Control': 'private, no-store',
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.length),
    });
    expect(res.body).toBe(bytes);
  });

  it('collapses provider/cache failures to an empty 404', async () => {
    const deps = dependencies();
    const res = response();
    await createSenderFaviconHandler(deps)(request(), res);
    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.body).toBeUndefined();
  });
});

describe('sender favicon router authentication boundary', () => {
  it('adds private no-store caching to an unauthenticated 401', async () => {
    const app = express();
    app.use('/api/sender-favicons', senderFaviconsRouter);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/sender-favicons/example.com`);
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });
});
