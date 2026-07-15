import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { safeFetch } from './safeFetch.js';

let server, port, redirectServer, redirectPort;
let serverBAuthorizations;
let serverBRequests;
let sameOriginRequests;
let chainRequests;
beforeAll(async () => {
  serverBAuthorizations = [];
  serverBRequests = 0;
  sameOriginRequests = [];
  chainRequests = [];
  redirectServer = http.createServer((req, res) => {
    serverBRequests += 1;
    serverBAuthorizations.push(req.headers.authorization);
    res.writeHead(200);
    res.end('cross-origin target');
  });
  await new Promise(r => redirectServer.listen(0, '127.0.0.1', r));
  redirectPort = redirectServer.address().port;

  server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: '/ok2' }); return res.end(); }
    if (req.url === '/cross') {
      res.writeHead(302, { Location: `http://127.0.0.1:${redirectPort}/target` });
      return res.end();
    }
    if (req.url?.startsWith('/same-origin/')) {
      const [, , statusOrTarget] = req.url.split('/');
      if (statusOrTarget !== 'target') {
        res.writeHead(Number(statusOrTarget), { Location: '/same-origin/target' });
        return res.end();
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        sameOriginRequests.push({
          authorization: req.headers.authorization,
          body,
          method: req.method,
        });
        res.writeHead(200);
        res.end('same-origin target');
      });
      return;
    }
    if (req.url?.startsWith('/chain/')) {
      chainRequests.push(req.url);
      const step = Number(req.url.slice('/chain/'.length));
      if (step < 6) {
        res.writeHead(302, { Location: `/chain/${step + 1}` });
        return res.end();
      }
      res.writeHead(200);
      return res.end('redirect target');
    }
    if (req.url === '/ok' || req.url === '/ok2') { res.writeHead(200); return res.end('hi'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(async () => {
  await Promise.all([
    new Promise(resolve => server?.close(resolve)),
    new Promise(resolve => redirectServer?.close(resolve)),
  ]);
});

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

  it('blocks a hostname that resolves to a private IP', async () => {
    expect(await causeCode(
      safeFetch(`http://localhost:${port}/ok`, {}, { allowPrivate: false, requireHttps: false })
    )).toBe('ERR_BLOCKED_PRIVATE_IP');
  });

  it('blocks hexadecimal IPv4-mapped loopback before connecting', async () => {
    let requestCount = 0;
    const loopbackServer = http.createServer((_req, res) => {
      requestCount += 1;
      res.end('loopback reached');
    });
    await new Promise((resolve, reject) => {
      loopbackServer.once('error', reject);
      loopbackServer.listen(0, '127.0.0.1', resolve);
    });
    const loopbackPort = loopbackServer.address().port;

    try {
      expect(await causeCode(
        safeFetch(`http://[::ffff:7f00:1]:${loopbackPort}`, {}, {
          allowPrivate: false,
          requireHttps: false,
        })
      )).toBe('ERR_BLOCKED_PRIVATE_IP');
      expect(requestCount).toBe(0);
    } finally {
      await new Promise(resolve => loopbackServer.close(resolve));
    }
  });

  it('follows redirects, validating each hop', async () => {
    const r = await safeFetch(`http://127.0.0.1:${port}/redir`, {}, { allowPrivate: true });
    expect(r.status).toBe(200);
  });
});

describe('safeFetch — credential origin policy', () => {
  const credentialedRequest = {
    method: 'PROPFIND',
    headers: { Authorization: 'Basic secret' },
    body: '<propfind/>',
    redirect: 'follow',
  };

  it('rejects a cross-origin redirect before sending the next request', async () => {
    const origin = `http://127.0.0.1:${port}`;

    await expect(safeFetch(`${origin}/cross`, credentialedRequest, {
      allowPrivate: true,
      credentialOrigin: origin,
    })).rejects.toMatchObject({ code: 'ERR_CROSS_ORIGIN_REDIRECT' });

    expect(serverBRequests).toBe(0);
    expect(serverBAuthorizations).toEqual([]);
  });

  it('rejects an initial URL outside the credential origin before sending a request', async () => {
    const credentialOrigin = `http://127.0.0.1:${port}`;
    const requestCount = serverBRequests;

    await expect(safeFetch(`http://127.0.0.1:${redirectPort}/target`, credentialedRequest, {
      allowPrivate: true,
      credentialOrigin,
    })).rejects.toMatchObject({ code: 'ERR_CROSS_ORIGIN_REDIRECT' });

    expect(serverBRequests).toBe(requestCount);
  });

  it.each([301, 302, 307, 308])(
    'preserves DAV method, body, and authorization across a same-origin %i redirect',
    async status => {
      const origin = `http://127.0.0.1:${port}`;
      const response = await safeFetch(`${origin}/same-origin/${status}`, credentialedRequest, {
        allowPrivate: true,
        credentialOrigin: origin,
      });

      expect(await response.text()).toBe('same-origin target');
      expect(sameOriginRequests.at(-1)).toEqual({
        authorization: 'Basic secret',
        body: '<propfind/>',
        method: 'PROPFIND',
      });
    },
  );

  it('validates a same-origin redirect before issuing the next request', async () => {
    const origin = `http://127.0.0.1:${port}`;
    const requestCount = sameOriginRequests.length;
    const redirectError = Object.assign(new Error('redirect escaped its resource scope'), {
      code: 'ERR_DAV_HREF_SCOPE',
    });
    const validateRedirect = vi.fn(() => { throw redirectError; });

    await expect(safeFetch(`${origin}/same-origin/307`, credentialedRequest, {
      allowPrivate: true,
      credentialOrigin: origin,
      validateRedirect,
    })).rejects.toBe(redirectError);

    expect(validateRedirect).toHaveBeenCalledWith(`${origin}/same-origin/target`);
    expect(sameOriginRequests).toHaveLength(requestCount);
  });

  it('cancels a redirect body before issuing the next same-origin request', async () => {
    const originalFetch = globalThis.fetch;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const redirected = {
      body: { cancel },
      headers: new Headers({ Location: '/final' }),
      status: 302,
    };
    const finalResponse = {
      body: null,
      headers: new Headers(),
      status: 207,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirected)
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledOnce();
        return finalResponse;
      });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(safeFetch('https://example.com/start', credentialedRequest, {
        credentialOrigin: 'https://example.com',
      })).resolves.toBe(finalResponse);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('rejects a 303 instead of changing an authenticated DAV request to GET', async () => {
    const origin = `http://127.0.0.1:${port}`;
    const requestCount = sameOriginRequests.length;

    await expect(safeFetch(`${origin}/same-origin/303`, credentialedRequest, {
      allowPrivate: true,
      credentialOrigin: origin,
    })).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_REDIRECT' });

    expect(sameOriginRequests).toHaveLength(requestCount);
  });

  it('rejects the sixth redirect without issuing a seventh request', async () => {
    const origin = `http://127.0.0.1:${port}`;

    await expect(safeFetch(`${origin}/chain/0`, credentialedRequest, {
      allowPrivate: true,
      credentialOrigin: origin,
    })).rejects.toMatchObject({ code: 'ERR_TOO_MANY_REDIRECTS' });

    expect(chainRequests).toEqual([
      '/chain/0',
      '/chain/1',
      '/chain/2',
      '/chain/3',
      '/chain/4',
      '/chain/5',
    ]);
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
