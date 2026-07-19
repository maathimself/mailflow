import { describe, it, expect, vi, afterEach } from 'vitest';
import { EmbeddingClient, isPermanent4xx } from './client.js';

function mockFetchOnce(status, body, headers = {}) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
const okBody = (n, dim = 3) => ({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: Array(dim).fill(0.1) })), model: 'm' });

afterEach(() => vi.unstubAllGlobals());

describe('EmbeddingClient.embed', () => {
  it('returns one vector per input in order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(mockFetchOnce(200, okBody(2))));
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3 });
    const out = await c.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([0.1, 0.1, 0.1]);
  });

  it('empty input is a no-op (no HTTP call)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3 });
    expect(await c.embed([])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('retries a 429 (Retry-After: 0) then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(mockFetchOnce(429, 'slow down', { 'retry-after': '0' }))
      .mockResolvedValueOnce(mockFetchOnce(200, okBody(1)));
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3, maxRetries: 3 });
    const out = await c.embed(['a']);
    expect(out).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('rejects a dimension mismatch without retrying', async () => {
    const f = vi.fn().mockResolvedValueOnce(mockFetchOnce(200, okBody(1, 5)));
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3 });
    await expect(c.embed(['a'])).rejects.toThrow(/dimension mismatch/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('accepts any vector length when constructed without a dimension expectation (probe mode)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(mockFetchOnce(200, okBody(1, 5))));
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: null });
    const out = await c.embed(['a']);
    expect(out[0]).toHaveLength(5); // discovered, not asserted — the Test probe path
  });

  it('marks a 400 as a permanent 4xx (no retry)', async () => {
    const f = vi.fn().mockResolvedValueOnce(mockFetchOnce(400, 'bad request'));
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3, maxRetries: 3 });
    const err = await c.embed(['a']).catch((e) => e);
    expect(isPermanent4xx(err)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries on a persistent network error', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3, maxRetries: 1 });
    await expect(c.embed(['a'])).rejects.toThrow(/giving up after 1 attempts/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  // Undici keeps the socket checked out until the body is read/cancelled; the
  // retry paths throw without decoding a body, so they must drain it first or a
  // burst of rate limiting across scheduler ticks leaks connections.
  it('consumes the response body on a retryable 429 before throwing', async () => {
    const textSpy = vi.fn(async () => 'slow down');
    const resp429 = { status: 429, headers: { get: () => null }, json: async () => ({}), text: textSpy };
    const f = vi.fn()
      .mockResolvedValueOnce(resp429)
      .mockResolvedValueOnce(mockFetchOnce(200, okBody(1)));
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3, maxRetries: 3 });
    await c.embed(['a']);
    expect(textSpy).toHaveBeenCalledTimes(1);
  });

  it('consumes the response body on a retryable 5xx before throwing', async () => {
    const textSpy = vi.fn(async () => 'upstream boom');
    const resp503 = { status: 503, headers: { get: () => null }, json: async () => ({}), text: textSpy };
    const f = vi.fn()
      .mockResolvedValueOnce(resp503)
      .mockResolvedValueOnce(mockFetchOnce(200, okBody(1)));
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3, maxRetries: 3 });
    await c.embed(['a']);
    expect(textSpy).toHaveBeenCalledTimes(1);
  });

  it('still retries a 429 even if draining the body throws (best-effort)', async () => {
    const resp429 = {
      status: 429,
      headers: { get: () => null },
      json: async () => ({}),
      text: vi.fn().mockRejectedValue(new Error('body already released')),
    };
    const f = vi.fn()
      .mockResolvedValueOnce(resp429)
      .mockResolvedValueOnce(mockFetchOnce(200, okBody(1)));
    vi.stubGlobal('fetch', f);
    const c = new EmbeddingClient({ endpoint: 'http://h/v1', model: 'm', dimension: 3, maxRetries: 3 });
    const out = await c.embed(['a']);
    expect(out).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
