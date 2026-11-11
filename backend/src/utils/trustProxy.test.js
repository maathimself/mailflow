import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import { parseTrustProxyHops } from './trustProxy.js';

// frontend/nginx.conf appends the address of whoever connected to it to X-Forwarded-For. In
// the https profile that is Caddy, which has already set the header to the client's address.
const CADDY = '172.18.0.5';

// Sets 'trust proxy' the way index.js does (index.js connects to Redis as soon as it loads, so
// it is not imported here). The assertions are on the req.ip Express derives, not on the parsed
// number, because req.ip is what the login rate limit is keyed on.
async function seenAs(setting, forwardedFor) {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      headers: { 'X-Forwarded-For': forwardedFor, 'X-Forwarded-Proto': 'https' },
    });
    return await res.json();
  } finally {
    server.close();
  }
}

describe('TRUST_PROXY_HOPS', () => {
  it('trusts only nginx when unset, so a client cannot pick its own address', async () => {
    for (const value of [undefined, '']) {
      expect(parseTrustProxyHops(value)).toBe(1);
      expect(await seenAs(parseTrustProxyHops(value), '6.6.6.6, 203.0.113.7'))
        .toEqual({ ip: '203.0.113.7', secure: true });
    }
  });

  it('gives each client behind Caddy its own address with 2', async () => {
    const hops = parseTrustProxyHops('2');
    expect(await seenAs(hops, `203.0.113.7, ${CADDY}`)).toEqual({ ip: '203.0.113.7', secure: true });
    expect(await seenAs(hops, `198.51.100.9, ${CADDY}`)).toEqual({ ip: '198.51.100.9', secure: true });
  });

  it('ignores addresses further back than the hops it trusts', async () => {
    expect((await seenAs(parseTrustProxyHops('2'), `6.6.6.6, 203.0.113.7, ${CADDY}`)).ip)
      .toBe('203.0.113.7');
  });

  it('sees every client behind Caddy as Caddy with 1, which is the behavior being fixed', async () => {
    expect((await seenAs(1, `203.0.113.7, ${CADDY}`)).ip).toBe(CADDY);
    expect((await seenAs(1, `198.51.100.9, ${CADDY}`)).ip).toBe(CADDY);
  });

  it('accepts a whole number of proxies, trimmed, and rejects anything else', () => {
    expect(parseTrustProxyHops('1')).toBe(1);
    expect(parseTrustProxyHops(' 2 ')).toBe(2);
    for (const value of ['0', '-1', '1.5', 'true', 'loopback', '2,3', 'abc']) {
      expect(parseTrustProxyHops(value)).toBeNull();
    }
  });

  it('is 2 in the https overlay, where Caddy sits in front of nginx', async () => {
    const overlay = readFileSync(new URL('../../../docker-compose.https.yml', import.meta.url), 'utf8');
    const backend = overlay.split(/^ {2}(?=\S)/m).find(service => service.startsWith('backend:')) ?? '';
    const fallback = backend.match(/^\s*TRUST_PROXY_HOPS: \$\{TRUST_PROXY_HOPS:-([^}]*)\}/m)?.[1];
    const hops = parseTrustProxyHops(fallback);
    expect(await seenAs(hops, `203.0.113.7, ${CADDY}`)).toEqual({ ip: '203.0.113.7', secure: true });
    // One hop fewer sees Caddy, and one more takes whatever precedes the entry Caddy wrote.
    expect((await seenAs(hops, `6.6.6.6, 203.0.113.7, ${CADDY}`)).ip).toBe('203.0.113.7');
  });
});
