// Run with: node --test src/caddyConfig.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const caddyfile = readFileSync(new URL('../caddy/Caddyfile', import.meta.url), 'utf8')
  .replace(/#.*$/gm, '');

// The (app) snippet, which every site imports.
const app = (() => {
  const start = caddyfile.indexOf('(app) {');
  let end = start + '(app) {'.length;
  for (let depth = 1; depth && end < caddyfile.length; end++) {
    if (caddyfile[end] === '{') depth++;
    else if (caddyfile[end] === '}') depth--;
  }
  return caddyfile.slice(start, end);
})();

// Caddy's path matcher: exact, or a prefix when it ends in *.
const matches = (pattern, uri) => (pattern.endsWith('*') ? uri.startsWith(pattern.slice(0, -1)) : uri === pattern);

// Every path the app's handle blocks send to the backend.
const proxied = [
  ...[...app.matchAll(/^\s*handle (\/\S+) \{/gm)].map(m => m[1]),
  ...(app.match(/^\s*@backend path (.+)$/m)?.[1].trim().split(/\s+/) ?? []),
];

// RFC 6764 discovery, the root, a principal, an address book and a card.
const CARDDAV = ['/.well-known/carddav', '/.well-known/carddav/', '/carddav', '/carddav/',
  '/carddav/7/', '/carddav/7/3/', '/carddav/7/3/5f0c-uid.vcf'];
const BACKEND = ['/api/health', '/api/ai/reply', '/api/admin/backup', '/api/admin/backup/restore',
  '/oauth/google/callback', '/auth/oidc/1/callback', '/ws', ...CARDDAV];
const APP = ['/', '/index.html', '/manifest.json', '/sw.js', '/assets/index-abc123.js', '/inbox', '/api'];

describe('Caddy config', () => {
  it('sends the API, sign-in redirects, the WebSocket and CardDAV to the backend', () => {
    assert.ok(proxied.length >= 3, 'no proxied paths found');
    const missed = BACKEND.filter(uri => !proxied.some(p => matches(p, uri)));
    assert.deepEqual(missed, []);
  });

  it('keeps the app itself out of the backend', () => {
    const leaked = APP.filter(uri => proxied.some(p => matches(p, uri)));
    assert.deepEqual(leaked, []);
  });

  it('forwards every proxied path with the same headers', () => {
    // The backend rate-limits and logs by the forwarded client address.
    const proxies = [...app.matchAll(/reverse_proxy \{\$MAILFLOW_BACKEND\} \{\n([\s\S]*?)\n\t*\}/g)].map(m => m[1]);
    assert.equal(proxies.length, 3);
    for (const body of proxies) assert.match(body, /import forward-\{args\[0\]\}/);
  });

  it('sends HSTS over HTTPS only', () => {
    const snippet = name => caddyfile.match(new RegExp(`\\(${name}\\) \\{([^}]*)\\}`))?.[1] ?? '';
    assert.match(snippet('headers-https'), /Strict-Transport-Security/);
    assert.doesNotMatch(snippet('headers-http'), /Strict-Transport-Security/);
  });

  it('every site file imports the app', () => {
    for (const mode of ['self-signed', 'letsencrypt', 'letsencrypt-no-email', 'off']) {
      const sites = readFileSync(new URL(`../caddy/sites-${mode}.caddy`, import.meta.url), 'utf8');
      assert.match(sites, /import app (https|http)/, mode);
    }
  });
});
