import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSenderDomain,
  readBodyLimited,
  validateSquarePng,
  getSenderFavicon,
} from './senderFavicon.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function png(width = 64, height = width, extraBytes = 0) {
  const out = Buffer.alloc(24 + extraBytes);
  PNG_SIGNATURE.copy(out, 0);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

function response(body, status = 200, contentType = 'image/png', extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType, ...extraHeaders },
  });
}

function cacheDouble(initial = new Map()) {
  return {
    values: initial,
    get: vi.fn(async key => initial.get(key) ?? null),
    set: vi.fn(async (key, value) => { initial.set(key, value); }),
    del: vi.fn(async key => { initial.delete(key); }),
  };
}

describe('normalizeSenderDomain', () => {
  it.each([
    ['Example.COM', 'example.com'],
    [' example.com. ', 'example.com'],
    ['münich.example', 'xn--mnich-kva.example'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeSenderDomain(input)).toBe(expected);
  });

  it.each([
    '', 'localhost', 'example', 'a..example', '-a.example', 'a-.example',
    'a_b.example', 'user@example.com', 'https://example.com', 'example.com/path',
    'example.com:443', '127.0.0.1', '[::1]', `a.${'b'.repeat(64)}.example`,
  ])('rejects %s', input => {
    expect(normalizeSenderDomain(input)).toBeNull();
  });

  it('rejects a hostname whose legal labels exceed the total hostname limit', () => {
    const label = 'a'.repeat(63);
    expect(normalizeSenderDomain(`${label}.${label}.${label}.${label}`)).toBeNull();
  });

  it('rejects a domain over the ten-label cap but accepts one at the cap', () => {
    expect(normalizeSenderDomain('a.b.c.d.e.f.g.h.i.j.com')).toBeNull(); // 11 labels
    expect(normalizeSenderDomain('a.b.c.d.e.f.g.h.i.com')).toBe('a.b.c.d.e.f.g.h.i.com'); // 10 labels
  });
});

describe('PNG bounds', () => {
  it('accepts a square PNG no larger than 64 pixels', () => {
    expect(validateSquarePng(png(64), 64)).toBe(true);
    expect(validateSquarePng(png(32), 64)).toBe(true);
  });

  it.each([png(0), png(65), png(64, 32), Buffer.from('not png')])(
    'rejects invalid PNG metadata',
    value => expect(validateSquarePng(value, 64)).toBe(false),
  );

  it('rejects a bad PNG signature', () => {
    const value = png();
    value[0] = 0;
    expect(validateSquarePng(value, 64)).toBe(false);
  });

  it('rejects a malformed IHDR', () => {
    const value = png();
    value.write('IDAT', 12, 'ascii');
    expect(validateSquarePng(value, 64)).toBe(false);
    expect(validateSquarePng(value.subarray(0, 20), 64)).toBe(false);
  });

  it('aborts bounded reading when a streamed body crosses the limit', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(30_000));
        controller.close();
      },
    });
    await expect(readBodyLimited(body, 65_536)).rejects.toMatchObject({ code: 'ERR_BODY_TOO_LARGE' });
  });
});

describe('getSenderFavicon', () => {
  it('fetches the exact fixed domain-only URL and caches a validated PNG for seven days', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async () => response(png(64)));

    const result = await getSenderFavicon('Example.COM', { cache, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://twenty-icons.com/example.com/64');
    expect(fetchImpl.mock.calls[0][0]).not.toContain('@');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(result).toMatchObject({ kind: 'image', source: 'upstream' });
    expect(result.bytes.equals(png(64))).toBe(true);
    const [key, serialized, options] = cache.set.mock.calls[0];
    expect(key).toMatch(/^sender-favicon:v2:[a-f0-9]{64}$/);
    expect(key).not.toContain('example.com');
    expect(JSON.parse(serialized)).toMatchObject({ v: 1, kind: 'image' });
    expect(options).toEqual({ EX: 604800 });
  });

  it('serves a valid positive cache hit without fetching', async () => {
    const bytes = png(32);
    const cache = cacheDouble();
    cache.get.mockResolvedValue(JSON.stringify({ v: 1, kind: 'image', pngBase64: bytes.toString('base64') }));
    const fetchImpl = vi.fn();
    const result = await getSenderFavicon('example.com', { cache, fetchImpl });
    expect(result).toMatchObject({ kind: 'image', source: 'cache' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves a negative cache hit without fetching', async () => {
    const cache = cacheDouble();
    cache.get.mockResolvedValue(JSON.stringify({ v: 1, kind: 'miss', reason: 'not-found' }));
    const fetchImpl = vi.fn();
    await expect(getSenderFavicon('example.com', { cache, fetchImpl })).resolves.toEqual({
      kind: 'miss', reason: 'not-found',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches definitive 4xx and invalid images for six hours', async () => {
    for (const upstream of [
      response('missing', 404, 'text/html'),
      response('bad request', 400, 'text/html'),
      response('gone', 410, 'text/html'),
      response('<svg/>', 200, 'image/svg+xml'),
    ]) {
      const cache = cacheDouble();
      const result = await getSenderFavicon('example.com', {
        cache,
        fetchImpl: vi.fn(async () => upstream),
      });
      expect(result.kind).toBe('miss');
      expect(cache.set.mock.calls[0][2]).toEqual({ EX: 21600 });
    }
  });

  it.each([403, 408, 429, 500, 503])('caches upstream status %s for five minutes', async status => {
    const cache = cacheDouble();
    const result = await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => response('', status, 'text/plain')),
    });
    expect(result).toMatchObject({ kind: 'miss', reason: 'transient' });
    expect(cache.set.mock.calls[0][2]).toEqual({ EX: 300 });
  });

  it.each([404, 503])('cancels an unused upstream body for status %s', async status => {
    const cache = cacheDouble();
    const upstream = response('unused', status, 'text/plain');
    const cancel = vi.spyOn(upstream.body, 'cancel');
    await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => upstream),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a declared response body over 65,536 bytes without reading it', async () => {
    const cache = cacheDouble();
    const upstream = response(png(), 200, 'image/png', { 'Content-Length': '65537' });
    const result = await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => upstream),
    });
    expect(result).toEqual({ kind: 'miss', reason: 'invalid-image' });
    expect(cache.set.mock.calls[0][2]).toEqual({ EX: 21600 });
  });

  it('cancels a response body rejected by its declared length', async () => {
    const cache = cacheDouble();
    const upstream = response(png(), 200, 'image/png', { 'Content-Length': '65537' });
    const cancel = vi.spyOn(upstream.body, 'cancel');
    await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => upstream),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a streamed response body that crosses 65,536 bytes', async () => {
    const cache = cacheDouble();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(png(64, 64, 40_000));
        controller.enqueue(new Uint8Array(30_000));
        controller.close();
      },
    });
    const upstream = new Response(body, { status: 200, headers: { 'Content-Type': 'image/png' } });
    const result = await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => upstream),
    });
    expect(result).toEqual({ kind: 'miss', reason: 'invalid-image' });
    expect(cache.set.mock.calls[0][2]).toEqual({ EX: 21600 });
  });

  it.each([
    ['missing', new Response(png(), { status: 200 })],
    ['wrong', response(png(), 200, 'image/jpeg')],
  ])('rejects %s content type', async (_label, upstream) => {
    const cache = cacheDouble();
    const result = await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => upstream),
    });
    expect(result).toEqual({ kind: 'miss', reason: 'invalid-image' });
  });

  it.each([
    ['missing', new Response(png(), { status: 200 })],
    ['wrong', response(png(), 200, 'image/jpeg')],
  ])('cancels a response body with %s content type', async (_label, upstream) => {
    const cache = cacheDouble();
    const cancel = vi.spyOn(upstream.body, 'cancel');
    await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => upstream),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['bad signature', (() => { const value = png(); value[0] = 0; return value; })()],
    ['malformed IHDR', (() => { const value = png(); value.write('IDAT', 12, 'ascii'); return value; })()],
    ['nonsquare dimensions', png(64, 32)],
    ['oversized dimensions', png(65)],
  ])('rejects PNG data with %s', async (_label, bytes) => {
    const cache = cacheDouble();
    const result = await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => response(bytes)),
    });
    expect(result).toEqual({ kind: 'miss', reason: 'invalid-image' });
    expect(cache.set.mock.calls[0][2]).toEqual({ EX: 21600 });
  });

  it.each([
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['network rejection', new TypeError('fetch failed')],
  ])('caches %s as transient for five minutes', async (_label, error) => {
    const cache = cacheDouble();
    const result = await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => { throw error; }),
    });
    expect(result).toEqual({ kind: 'miss', reason: 'transient' });
    expect(cache.set.mock.calls[0][2]).toEqual({ EX: 300 });
  });

  it('fails closed without fetching when Redis read fails', async () => {
    const cache = cacheDouble();
    cache.get.mockRejectedValue(new Error('redis unavailable'));
    const fetchImpl = vi.fn();
    await expect(getSenderFavicon('example.com', { cache, fetchImpl })).resolves.toEqual({
      kind: 'miss', reason: 'cache-unavailable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('evicts malformed cache data and refetches', async () => {
    const cache = cacheDouble();
    cache.get.mockResolvedValue('{broken');
    const fetchImpl = vi.fn(async () => response(png(64)));
    await getSenderFavicon('example.com', { cache, fetchImpl });
    expect(cache.del).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown version', JSON.stringify({ v: 2, kind: 'miss', reason: 'not-found' })],
    ['unknown kind', JSON.stringify({ v: 1, kind: 'redirect', reason: 'not-found' })],
  ])('evicts a cached entry with %s and refetches', async (_label, cached) => {
    const cache = cacheDouble();
    cache.get.mockResolvedValue(cached);
    const fetchImpl = vi.fn(async () => response(png()));
    await expect(getSenderFavicon('example.com', { cache, fetchImpl })).resolves.toMatchObject({ kind: 'image' });
    expect(cache.del).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('evicts an invalid cached PNG and refetches', async () => {
    const cache = cacheDouble();
    cache.get.mockResolvedValue(JSON.stringify({
      v: 1,
      kind: 'image',
      pngBase64: png(65).toString('base64'),
    }));
    const fetchImpl = vi.fn(async () => response(png(32)));
    await expect(getSenderFavicon('example.com', { cache, fetchImpl })).resolves.toMatchObject({
      kind: 'image', source: 'upstream',
    });
    expect(cache.del).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the current validated image when Redis write fails', async () => {
    const cache = cacheDouble();
    cache.set.mockRejectedValue(new Error('redis unavailable'));
    const bytes = png(32);
    const result = await getSenderFavicon('example.com', {
      cache,
      fetchImpl: vi.fn(async () => response(bytes)),
    });
    expect(result).toMatchObject({ kind: 'image', bytes, source: 'upstream' });
  });

  it('coalesces simultaneous misses for one normalized domain', async () => {
    const cache = cacheDouble();
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async () => { await blocked; return response(png(64)); });
    const first = getSenderFavicon('EXAMPLE.com', { cache, fetchImpl });
    const second = getSenderFavicon('example.com.', { cache, fetchImpl });
    release();
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('getSenderFavicon parent walk-up', () => {
  const url = domain => `https://twenty-icons.com/${domain}/64`;
  const urls = fetchImpl => fetchImpl.mock.calls.map(call => call[0]);
  const notFound = () => response('missing', 404, 'text/html');

  it('resolves a not-found subdomain to its registrable parent, caching under both keys', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async target => (target.includes('/notion.so/') ? response(png(64)) : notFound()));

    const result = await getSenderFavicon('mail.notion.so', { cache, fetchImpl });

    expect(result).toMatchObject({ kind: 'image', source: 'upstream' });
    expect(urls(fetchImpl)).toEqual([url('mail.notion.so'), url('notion.so')]);
    // The parent's own key is written first, then the aggregate under the original key.
    const keys = cache.set.mock.calls.map(call => call[0]);
    expect(new Set(keys).size).toBe(2);
    for (const [, serialized, options] of cache.set.mock.calls) {
      expect(JSON.parse(serialized)).toMatchObject({ v: 1, kind: 'image' });
      expect(options).toEqual({ EX: 604800 });
    }
  });

  it('walks on a provider 400 the same as a 404 (unresolvable mail-only subdomain)', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async target =>
      (target.includes('/wanver.shop/') ? response(png(64)) : response('bad request', 400, 'text/html')));

    const result = await getSenderFavicon('email.mg.wanver.shop', { cache, fetchImpl });

    expect(result).toMatchObject({ kind: 'image' });
    expect(urls(fetchImpl)).toEqual([url('email.mg.wanver.shop'), url('mg.wanver.shop'), url('wanver.shop')]);
  });

  it('reuses a cached parent favicon for a sibling subdomain without refetching it', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async target => (target.includes('/notion.so/') ? response(png(64)) : notFound()));

    await getSenderFavicon('mail.notion.so', { cache, fetchImpl });
    fetchImpl.mockClear();
    const result = await getSenderFavicon('info.notion.so', { cache, fetchImpl });

    expect(result).toMatchObject({ kind: 'image' });
    // The sibling is fetched fresh, but notion.so is served from the parent's cache entry.
    expect(urls(fetchImpl)).toEqual([url('info.notion.so')]);
  });

  it('walks to a registrable domain but stops before a co.uk public suffix', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async target => (target.includes('/acme.co.uk/') ? response(png(64)) : notFound()));

    const result = await getSenderFavicon('news.acme.co.uk', { cache, fetchImpl });

    expect(result).toMatchObject({ kind: 'image' });
    expect(urls(fetchImpl)).toEqual([url('news.acme.co.uk'), url('acme.co.uk')]);
  });

  it('never queries a stoplisted public suffix while walking', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(notFound);

    const result = await getSenderFavicon('foo.github.io', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason: 'not-found' });
    // github.io must never be queried.
    expect(urls(fetchImpl)).toEqual([url('foo.github.io')]);
  });

  it('walks every registrable parent of a deep subdomain, one label at a time', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(notFound);

    const result = await getSenderFavicon('a.b.c.d.example.com', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason: 'not-found' });
    expect(urls(fetchImpl)).toEqual([
      url('a.b.c.d.example.com'),
      url('b.c.d.example.com'),
      url('c.d.example.com'),
      url('d.example.com'),
      url('example.com'),
    ]);
  });

  it('does not walk a two-label domain', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(notFound);

    const result = await getSenderFavicon('example.com', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason: 'not-found' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set.mock.calls[0][2]).toEqual({ EX: 21600 });
  });

  it.each([
    ['transient', () => response('', 503, 'text/plain')],
    ['invalid-image', () => response(png(65))],
  ])('does not walk parents when the full domain is %s', async (reason, upstream) => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async () => upstream());

    const result = await getSenderFavicon('mail.notion.so', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(url('mail.notion.so'));
  });

  it('caches an aggregate transient under the original key when a parent step is transient', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async target =>
      (target.includes('/notion.so/') ? response('', 503, 'text/plain') : notFound()));

    const result = await getSenderFavicon('mail.notion.so', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason: 'transient' });
    // The aggregate (last write) lands under the original key with the short transient TTL.
    const aggregate = cache.set.mock.calls.at(-1);
    expect(JSON.parse(aggregate[1])).toMatchObject({ kind: 'miss', reason: 'transient' });
    expect(aggregate[2]).toEqual({ EX: 300 });
  });

  it('caches a single not-found aggregate under the original key when every candidate misses', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(notFound);

    const result = await getSenderFavicon('mail.notion.so', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason: 'not-found' });
    const aggregate = cache.set.mock.calls.at(-1);
    expect(JSON.parse(aggregate[1])).toMatchObject({ kind: 'miss', reason: 'not-found' });
    expect(aggregate[2]).toEqual({ EX: 21600 });
    // The original key is written exactly once.
    expect(cache.set.mock.calls.filter(call => call[0] === aggregate[0])).toHaveLength(1);
  });

  it('coalesces a subdomain walk and a direct parent request onto one parent fetch', async () => {
    const cache = cacheDouble();
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async target => {
      if (target.includes('/notion.so/')) { await blocked; return response(png(64)); }
      return notFound();
    });

    const subdomain = getSenderFavicon('mail.notion.so', { cache, fetchImpl });
    const parent = getSenderFavicon('notion.so', { cache, fetchImpl });
    release();
    const [a, b] = await Promise.all([subdomain, parent]);

    expect(a).toMatchObject({ kind: 'image' });
    expect(b).toMatchObject({ kind: 'image' });
    expect(urls(fetchImpl).filter(target => target.includes('/notion.so/'))).toHaveLength(1);
  });

  // Regression: the walk must not poison an intermediate parent's own cache key.
  // a.b.corp.com walks past b.corp.com (404) to corp.com (image); b.corp.com's
  // own entry must then hold corp.com's image, not the 404 the walk saw.
  it('caches an intermediate parent under its resolved image, not the miss the walk observed', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async target => (target.includes('/corp.com/') ? response(png(64)) : notFound()));

    const deep = await getSenderFavicon('a.b.corp.com', { cache, fetchImpl });
    expect(deep).toMatchObject({ kind: 'image' });

    fetchImpl.mockClear();
    const direct = await getSenderFavicon('b.corp.com', { cache, fetchImpl });

    expect(direct).toMatchObject({ kind: 'image', source: 'cache' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives a direct request racing the walk the resolved image, not the exact-fetch miss', async () => {
    const cache = cacheDouble();
    let reached;
    const bReached = new Promise(resolve => { reached = resolve; });
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async target => {
      if (target.includes('/b.corp.com/')) { reached(); await blocked; return notFound(); }
      if (target.includes('/corp.com/')) return response(png(64));
      return notFound();
    });

    const walk = getSenderFavicon('a.b.corp.com', { cache, fetchImpl });
    await bReached; // the walk owns inflight[b.corp.com] and is blocked fetching it
    const direct = getSenderFavicon('b.corp.com', { cache, fetchImpl });
    release();
    const [a, b] = await Promise.all([walk, direct]);

    expect(a).toMatchObject({ kind: 'image' });
    expect(b).toMatchObject({ kind: 'image' });
    // The joined resolution walks b.corp.com → corp.com once, not per caller.
    expect(urls(fetchImpl).filter(target => target.includes('/b.corp.com/'))).toHaveLength(1);
  });

  it('resolves a deep chain level by level, caching each level under its own resolved image', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(async target => (target.includes('/corp.com/') ? response(png(64)) : notFound()));

    const result = await getSenderFavicon('w.x.corp.com', { cache, fetchImpl });

    expect(result).toMatchObject({ kind: 'image' });
    expect(urls(fetchImpl)).toEqual([url('w.x.corp.com'), url('x.corp.com'), url('corp.com')]);
    // Every level cached its own resolved outcome — all three the image.
    expect(cache.set).toHaveBeenCalledTimes(3);
    for (const [, serialized, options] of cache.set.mock.calls) {
      expect(JSON.parse(serialized)).toMatchObject({ v: 1, kind: 'image' });
      expect(options).toEqual({ EX: 604800 });
    }

    fetchImpl.mockClear();
    for (const domain of ['w.x.corp.com', 'x.corp.com', 'corp.com']) {
      expect(await getSenderFavicon(domain, { cache, fetchImpl })).toMatchObject({ kind: 'image', source: 'cache' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a domain over the label cap at the front door, without fetching', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(notFound);

    // An 11-label domain is rejected by normalize, so no walk and no fetch occur.
    const result = await getSenderFavicon('a.b.c.d.e.f.g.h.i.j.com', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason: 'invalid-image' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('walks the full ancestry of a ten-label domain, caching every level with none uncached', async () => {
    const cache = cacheDouble();
    const fetchImpl = vi.fn(notFound);

    const result = await getSenderFavicon('a.b.c.d.e.f.g.h.i.com', { cache, fetchImpl });

    expect(result).toEqual({ kind: 'miss', reason: 'not-found' });
    // Nine levels from the ten-label domain down to i.com, each fetched and cached.
    expect(urls(fetchImpl).at(-1)).toBe(url('i.com'));
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(cache.set).toHaveBeenCalledTimes(9);
  });
});
