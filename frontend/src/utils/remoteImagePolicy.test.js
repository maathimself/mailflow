// The CSP that limits a body's remote loads (utils/remoteImagePolicy.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteLoadsCsp, proxiedRemoteLoads, BLOCKED_REMOTE_LOADS } from './remoteImagePolicy.js';

test('blocked: no remote image, font or media at all', () => {
  assert.equal(remoteLoadsCsp(true, false, 'https://mail.example.invalid'), ` ${BLOCKED_REMOTE_LOADS}`);
  assert.doesNotMatch(BLOCKED_REMOTE_LOADS, /'self'|https?:/);
});

// Firefox does not count the page's origin as 'self' inside a srcdoc frame, and refused every
// proxied image; naming the origin fixes it there and changes nothing elsewhere.
test('proxied: images from MailFlow, named by origin as well as self', () => {
  assert.equal(proxiedRemoteLoads('https://mail.example.invalid'), "img-src 'self' https://mail.example.invalid data: blob:; font-src data:; media-src data: blob:;");
  assert.equal(remoteLoadsCsp(false, true, 'http://127.0.0.1:8080'), " img-src 'self' http://127.0.0.1:8080 data: blob:; font-src data:; media-src data: blob:;");
});

test('an origin that is not a plain http(s) origin is left out rather than written into the policy', () => {
  for (const origin of ['null', '', undefined, "https://x.example; script-src *", 'https://x.example data:"', 'javascript:alert(1)']) {
    assert.equal(proxiedRemoteLoads(origin), "img-src 'self' data: blob:; font-src data:; media-src data: blob:;", String(origin));
  }
});

test('allowed and not proxied: nothing added', () => {
  assert.equal(remoteLoadsCsp(false, false, 'https://mail.example.invalid'), '');
});
