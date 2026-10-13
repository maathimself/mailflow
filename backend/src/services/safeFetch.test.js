import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { safeFetch } from './safeFetch.js';

let server, port;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: '/ok2' }); return res.end(); }
    if (req.url === '/ok' || req.url === '/ok2') { res.writeHead(200); return res.end('hi'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => server && server.close());

describe('safeFetch — SSRF guard', () => {
  it('connects to a private IP when allowPrivate=true', async () => {
    const r = await safeFetch(`http://127.0.0.1:${port}/ok`, {}, { allowPrivate: true });
    expect(r.status).toBe(200);
  });

  // undici surfaces a connector rejection as `TypeError: fetch failed` with the
  // real error on `.cause`, so assert on the cause code.
  const causeCode = async (promise) => {
    try { await promise; return null; }
    catch (e) { return e.cause?.code ?? e.code; }
  };

  it('blocks a literal private IP when allowPrivate=false', async () => {
    expect(await causeCode(
      safeFetch(`http://127.0.0.1:${port}/ok`, {}, { allowPrivate: false, requireHttps: false })
    )).toBe('ERR_BLOCKED_PRIVATE_IP');
  });

  it('blocks an IPv4-mapped IPv6 literal, which the URL parser rewrites to hex', async () => {
    expect(await causeCode(
      safeFetch(`http://[::ffff:127.0.0.1]:${port}/ok`, {}, { allowPrivate: false, requireHttps: false })
    )).toBe('ERR_BLOCKED_PRIVATE_IP');
  });

  it('blocks a hostname that resolves to a private IP', async () => {
    expect(await causeCode(
      safeFetch(`http://localhost:${port}/ok`, {}, { allowPrivate: false, requireHttps: false })
    )).toBe('ERR_BLOCKED_PRIVATE_IP');
  });

  it('follows redirects, validating each hop', async () => {
    const r = await safeFetch(`http://127.0.0.1:${port}/redir`, {}, { allowPrivate: true });
    expect(r.status).toBe(200);
  });
});

describe('safeFetch — scheme policy', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(safeFetch('ftp://example.com/x')).rejects.toThrow(/http\(s\)/i);
  });

  it('rejects an invalid URL', async () => {
    await expect(safeFetch('not a url')).rejects.toThrow(/invalid url/i);
  });

  it('rejects plaintext http when HTTPS is required', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/ok`, {}, { allowPrivate: true, requireHttps: true })
    ).rejects.toThrow(/HTTP/i);
  });

  it('defaults to requiring HTTPS for public (allowPrivate=false) targets', async () => {
    // Rejected for the HTTPS requirement before any connection is attempted.
    await expect(
      safeFetch('http://example.com/x', {}, { allowPrivate: false })
    ).rejects.toThrow(/HTTP/i);
  });
});
