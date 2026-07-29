const assert = require('node:assert/strict');
const test = require('node:test');
const security = require('./security.cjs');

test('normalizes HTTPS hosts to an origin', () => {
  assert.equal(
    security.normalizeHost(' https://Mail.Example.com:8443/inbox?view=all#today '),
    'https://mail.example.com:8443',
  );
});

test('allows cleartext only for localhost, loopback, and RFC 1918 literals', () => {
  for (const host of [
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://10.0.0.8',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.20',
    'http://[::1]:8080',
  ]) {
    assert.equal(security.normalizeHost(host), host);
  }
});

test('rejects cleartext public, lookalike, and non-RFC 1918 hosts', () => {
  for (const host of [
    'http://example.com',
    'http://localhost.example.com',
    'http://10.example.com',
    'http://172.32.0.1',
    'http://192.169.0.1',
    'http://169.254.1.1',
  ]) {
    assert.throws(() => security.normalizeHost(host), /https/i);
  }
});

test('matches configured hosts by exact origin instead of string prefix', () => {
  assert.equal(security.isSameOrigin('https://mail.example.com', 'https://mail.example.com/inbox'), true);
  assert.equal(security.isSameOrigin('https://mail.example.com', 'https://mail.example.com:443/inbox'), true);
  assert.equal(security.isSameOrigin('https://mail.example.com', 'https://mail.example.com.attacker.test'), false);
  assert.equal(security.isSameOrigin('https://mail.example.com', 'https://mail.example.com:444'), false);
});

test('navigation policy allows configured-origin pages and a bounded OIDC redirect chain', () => {
  const policy = security.createNavigationPolicy(() => 'https://mail.example.com', { oidcTimeoutMs: 60_000 });

  assert.equal(policy.decide('navigate', 'https://mail.example.com/inbox'), 'allow');
  assert.equal(policy.decide('navigate', 'https://idp.example.test/login'), 'block');

  assert.equal(policy.decide('navigate', 'https://mail.example.com/auth/oidc/work/start'), 'allow');
  assert.equal(policy.decide('redirect', 'https://idp.example.test/authorize'), 'allow');
  assert.equal(policy.decide('navigate', 'https://idp.example.test/login'), 'allow');
  assert.equal(policy.decide('redirect', 'https://login.example.test/mfa'), 'allow');
  assert.equal(policy.decide('redirect', 'https://mail.example.com/auth/oidc/work/callback?code=ok'), 'allow');
  assert.equal(policy.decide('redirect', 'https://mail.example.com/?oidc_success=login'), 'allow');
  assert.equal(policy.decide('navigate', 'https://idp.example.test/login'), 'block');
});

test('navigation policy does not let renderer navigation extend an OIDC origin chain', () => {
  const policy = security.createNavigationPolicy(() => 'https://mail.example.com', { oidcTimeoutMs: 60_000 });

  policy.decide('navigate', 'https://mail.example.com/auth/oidc/work/start');
  policy.decide('redirect', 'https://idp.example.test/authorize');

  assert.equal(policy.decide('navigate', 'https://attacker.test/phish'), 'block');
});

test('Windows signature verification requires a valid matching publisher', () => {
  assert.equal(
    security.hasMatchingWindowsPublisher(
      { status: 'Valid', subject: 'CN=MailFlow LLC' },
      { status: 'Valid', subject: 'CN=MailFlow LLC' },
    ),
    true,
  );
  assert.equal(
    security.hasMatchingWindowsPublisher(
      { status: 'Valid', subject: 'CN=MailFlow LLC' },
      { status: 'Valid', subject: 'CN=Other Publisher' },
    ),
    false,
  );
  assert.equal(
    security.hasMatchingWindowsPublisher(
      { status: 'Valid', subject: 'CN=MailFlow LLC' },
      { status: 'NotSigned', subject: 'CN=MailFlow LLC' },
    ),
    false,
  );
});

test('macOS signature verification requires a matching TeamIdentifier', () => {
  assert.equal(
    security.hasMatchingMacTeam(
      'Authority=Developer ID Application: MailFlow\nTeamIdentifier=ABC123',
      'Authority=Developer ID Application: MailFlow\nTeamIdentifier=ABC123',
    ),
    true,
  );
  assert.equal(
    security.hasMatchingMacTeam(
      'TeamIdentifier=ABC123',
      'TeamIdentifier=EVIL999',
    ),
    false,
  );
});
