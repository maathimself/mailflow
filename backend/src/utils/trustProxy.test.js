import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import { parseTrustProxyHops } from './trustProxy.js';

// The frontend (frontend/caddy/Caddyfile) appends the address of whoever connected to it to
// X-Forwarded-For. Behind a reverse proxy of the operator's own, that is the proxy, which has
// already set the header to the client's address.
const PROXY = '172.18.0.5';

// Sets 'trust proxy' the way index.js does (index.js starts the server as soon as it loads, so
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
  it('trusts only the frontend when unset, so a client cannot pick its own address', async () => {
    for (const value of [undefined, '']) {
      expect(parseTrustProxyHops(value)).toBe(1);
      expect(await seenAs(parseTrustProxyHops(value), '6.6.6.6, 203.0.113.7'))
        .toEqual({ ip: '203.0.113.7', secure: true });
    }
  });

  it('gives each client behind a proxy of your own its own address with 2', async () => {
    const hops = parseTrustProxyHops('2');
    expect(await seenAs(hops, `203.0.113.7, ${PROXY}`)).toEqual({ ip: '203.0.113.7', secure: true });
    expect(await seenAs(hops, `198.51.100.9, ${PROXY}`)).toEqual({ ip: '198.51.100.9', secure: true });
  });

  it('ignores addresses further back than the hops it trusts', async () => {
    expect((await seenAs(parseTrustProxyHops('2'), `6.6.6.6, 203.0.113.7, ${PROXY}`)).ip)
      .toBe('203.0.113.7');
  });

  it('sees every client behind a proxy of your own as that proxy with 1', async () => {
    expect((await seenAs(1, `203.0.113.7, ${PROXY}`)).ip).toBe(PROXY);
    expect((await seenAs(1, `198.51.100.9, ${PROXY}`)).ip).toBe(PROXY);
  });

  it('accepts a whole number of proxies, trimmed, and rejects anything else', () => {
    expect(parseTrustProxyHops('1')).toBe(1);
    expect(parseTrustProxyHops(' 2 ')).toBe(2);
    for (const value of ['0', '-1', '1.5', 'true', 'loopback', '2,3', 'abc']) {
      expect(parseTrustProxyHops(value)).toBeNull();
    }
  });

  // Before 4.4 the overlay put a separate Caddy in front of nginx and said 2. The frontend is the
  // only proxy now, and a 2 left over would take the address a client wrote itself.
  it('is 1 in the https overlay, whatever .env says, where the frontend is the only proxy', async () => {
    const overlay = readFileSync(new URL('../../../docker-compose.https.yml', import.meta.url), 'utf8');
    const backend = overlay.split(/^ {2}(?=\S)/m).find(service => service.startsWith('backend:')) ?? '';
    const hops = parseTrustProxyHops(backend.match(/^\s*TRUST_PROXY_HOPS: "(\d+)"$/m)?.[1]);
    expect(hops).toBe(1);
    // A client that connects straight to the frontend and writes its own X-Forwarded-For.
    expect((await seenAs(hops, '6.6.6.6, 203.0.113.7')).ip).toBe('203.0.113.7');
  });
});
