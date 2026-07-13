import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { senderDomainFromEmail, avatarImageCandidates } from './senderAvatar.js';

describe('senderDomainFromEmail', () => {
  it('returns a lowercase ASCII domain only', () => {
    assert.equal(senderDomainFromEmail('Alice@Example.COM'), 'example.com');
    assert.equal(senderDomainFromEmail('alice@münich.example'), 'xn--mnich-kva.example');
  });

  it('rejects malformed or unsafe addresses', () => {
    for (const email of [
      '', 'alice', '@example.com', 'alice@', 'a@@example.com',
      'a@localhost', 'a@127.0.0.1', 'a@example.com:443', 'a@example.com/path',
    ]) {
      assert.equal(senderDomainFromEmail(email), null, email);
    }
  });
});

describe('avatarImageCandidates', () => {
  const email = 'alice@example.com';
  const contact = '/api/contacts/photo?email=alice%40example.com';
  const favicon = '/api/sender-favicons/example.com';

  it('orders a known contact photo before the optional favicon', () => {
    assert.deepEqual(avatarImageCandidates({ email, hasContactPhoto: true, senderFavicons: true }), [
      { kind: 'contact', src: contact },
      { kind: 'favicon', src: favicon },
    ]);
  });

  it('skips the contact probe when absence is known', () => {
    assert.deepEqual(avatarImageCandidates({ email, hasContactPhoto: false, senderFavicons: true }), [
      { kind: 'favicon', src: favicon },
    ]);
  });

  it('probes contact first when availability is unknown', () => {
    assert.deepEqual(avatarImageCandidates({ email, hasContactPhoto: undefined, senderFavicons: true }), [
      { kind: 'contact', src: contact },
      { kind: 'favicon', src: favicon },
    ]);
  });

  it('removes only the favicon when disabled or not hydrated', () => {
    assert.deepEqual(avatarImageCandidates({ email, hasContactPhoto: true, senderFavicons: false }), [
      { kind: 'contact', src: contact },
    ]);
    assert.deepEqual(avatarImageCandidates({ email, hasContactPhoto: false, senderFavicons: false }), []);
  });

  it('never puts the local part in a favicon candidate', () => {
    const candidates = avatarImageCandidates({ email, hasContactPhoto: false, senderFavicons: true });
    assert.equal(candidates[0].src.includes('@'), false);
    assert.equal(candidates[0].src.includes('alice'), false);
  });

  it('keeps the contact photo when the domain is unparseable', () => {
    assert.deepEqual(avatarImageCandidates({ email: 'ops@intranet', hasContactPhoto: true, senderFavicons: true }), [
      { kind: 'contact', src: '/api/contacts/photo?email=ops%40intranet' },
    ]);
    assert.deepEqual(avatarImageCandidates({ email: 'admin@192.168.1.5', hasContactPhoto: undefined, senderFavicons: true }), [
      { kind: 'contact', src: '/api/contacts/photo?email=admin%40192.168.1.5' },
    ]);
  });

  it('returns no candidates without a usable email', () => {
    for (const bad of [undefined, null, '', '   ', 42]) {
      assert.deepEqual(avatarImageCandidates({ email: bad, hasContactPhoto: undefined, senderFavicons: true }), [], String(bad));
    }
  });
});
