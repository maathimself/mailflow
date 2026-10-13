// Run with: node --test src/nginxConfig.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The server blocks of an nginx config and their locations. One leading '#' comes off each line
// first, so the commented-out HTTPS server in contrib/nginx.conf, which native installs uncomment
// to terminate TLS, is read too. The comments left after that are dropped.
function servers(path) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/^# ?/gm, '')
    .replace(/#.*$/gm, '');
  return [...text.matchAll(/\bserver\s*\{/g)].map(start => {
    let end = start.index + start[0].length;
    for (let depth = 1; depth && end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') depth--;
    }
    const body = text.slice(start.index, end);
    return {
      listen: body.match(/\blisten\s+([^;]+);/)?.[1],
      locations: [...body.matchAll(/\blocation\s+(=|\^~|~\*?)?\s*(\S+)\s*\{([^{}]*)\}/g)]
        .map(([, modifier = '', pattern, directives]) => ({
          modifier,
          pattern,
          proxyPass: directives.match(/\bproxy_pass\s+([^;]+);/)?.[1],
          headers: [...directives.matchAll(/\bproxy_set_header\s+([^;]+);/g)]
            .map(m => m[1].replace(/\s+/g, ' '))
            .sort(),
        })),
    };
  });
}

// How nginx picks a location: an exact match, else the longest matching prefix, unless that
// prefix lacks ^~ and a regex matches (the first one in the file wins).
function locate(locations, uri) {
  const exact = locations.find(l => l.modifier === '=' && l.pattern === uri);
  if (exact) return exact;
  const prefix = locations
    .filter(l => (l.modifier === '' || l.modifier === '^~') && uri.startsWith(l.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (prefix?.modifier === '^~') return prefix;
  return locations.find(l => l.modifier.startsWith('~')
    && new RegExp(l.pattern, l.modifier === '~*' ? 'i' : '').test(uri)) ?? prefix;
}

// RFC 6764 discovery, the root, a principal, an address book and a card.
const CARDDAV = ['/.well-known/carddav', '/.well-known/carddav/', '/carddav', '/carddav/',
  '/carddav/7/', '/carddav/7/3/', '/carddav/7/3/5f0c-uid.vcf'];
const APP = ['/', '/index.html', '/manifest.json', '/assets/index-abc123.js'];

// Each config's server blocks by listen line, so a block that stops being parsed (the commented
// one in contrib, say) fails the test instead of going unchecked.
const CONFIGS = {
  '../nginx.conf': ['443 ssl', '80'],
  '../../contrib/nginx.conf': ['80', '443 ssl'],
};

describe('nginx config', () => {
  for (const [path, listens] of Object.entries(CONFIGS)) {
    it(`${path} sends CardDAV to the backend the way it sends the API`, () => {
      const blocks = servers(path);
      assert.deepEqual(blocks.map(b => b.listen), listens);
      // Every miss at once, rather than stopping at the first.
      const misrouted = [];
      for (const { listen, locations } of blocks) {
        const api = locate(locations, '/api/health');
        assert.ok(api?.proxyPass, `the API is not proxied on listen ${listen}`);
        for (const uri of CARDDAV) {
          const location = locate(locations, uri);
          if (location?.proxyPass !== api.proxyPass) {
            misrouted.push(`listen ${listen}: ${uri} does not reach the backend`);
          } else if (String(location.headers) !== String(api.headers)) {
            // The backend rate-limits and logs by the forwarded client address, not nginx's.
            misrouted.push(`listen ${listen}: ${uri} is not forwarded with the API's headers`);
          }
        }
        for (const uri of APP) {
          if (locate(locations, uri)?.proxyPass) misrouted.push(`listen ${listen}: ${uri} left the app`);
        }
      }
      assert.deepEqual(misrouted, []);
    });
  }
});
