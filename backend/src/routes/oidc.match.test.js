import { describe, it, expect, vi } from 'vitest';

// resolveLoginMatchValue decides which value an SSO login is matched against users.username
// during the initial link (provisioning_mode = login_existing_only). It is the security-
// sensitive core of #289: the default MUST stay 'email' (unchanged behavior), a non-email
// claim is only honored when explicitly configured, and a missing/blank/non-string claim MUST
// resolve to null (→ "no matching account") rather than matching something unintended.
// oidc.js's module-load dependencies are stubbed to isolate the pure helper.
vi.mock('../services/db.js', () => ({ query: vi.fn(), pool: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: (v) => v, encrypt: (v) => v, isEncrypted: () => false }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));

import { resolveLoginMatchValue } from './oidc.js';

describe('resolveLoginMatchValue', () => {
  const email = 'Alice@Example.com';
  const payload = { email, preferred_username: 'Alice', upn: 'alice@corp.local', name: 'Alice A' };

  it('defaults to the email claim when login_match_claim is unset', () => {
    expect(resolveLoginMatchValue({}, payload, email)).toBe('alice@example.com');
    expect(resolveLoginMatchValue({ login_match_claim: null }, payload, email)).toBe('alice@example.com');
    expect(resolveLoginMatchValue({ login_match_claim: '' }, payload, email)).toBe('alice@example.com');
  });

  it('matches the email claim explicitly (lowercased, trimmed)', () => {
    expect(resolveLoginMatchValue({ login_match_claim: 'email' }, payload, '  Alice@Example.com ')).toBe('alice@example.com');
  });

  it('matches a configured non-email claim from the verified payload', () => {
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, payload, email)).toBe('alice');
    expect(resolveLoginMatchValue({ login_match_claim: 'upn' }, payload, email)).toBe('alice@corp.local');
  });

  it('returns null when the configured claim is absent from the payload', () => {
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, { email }, email)).toBeNull();
    expect(resolveLoginMatchValue({ login_match_claim: 'nonexistent' }, payload, email)).toBeNull();
  });

  it('returns null for non-string claim values (arrays/objects/numbers/booleans)', () => {
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, { preferred_username: ['a', 'b'] }, email)).toBeNull();
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, { preferred_username: 42 }, email)).toBeNull();
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, { preferred_username: { x: 1 } }, email)).toBeNull();
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, { preferred_username: true }, email)).toBeNull();
  });

  it('returns null for a blank/whitespace claim value', () => {
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, { preferred_username: '   ' }, email)).toBeNull();
  });

  it('returns null when matching by email but no email was provided', () => {
    expect(resolveLoginMatchValue({ login_match_claim: 'email' }, payload, null)).toBeNull();
    expect(resolveLoginMatchValue({}, payload, undefined)).toBeNull();
  });

  it('is safe when provider or payload is missing', () => {
    expect(resolveLoginMatchValue(null, payload, email)).toBe('alice@example.com');
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, null, email)).toBeNull();
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, undefined, email)).toBeNull();
  });

  it('returns null for object-prototype key names, incl. the JSON __proto__ own-property', () => {
    // A JSON-parsed {"__proto__":"victim"} is a string own-property that passes a typeof guard —
    // resolveLoginMatchValue must still refuse to match on it. constructor/prototype too.
    const poisoned = JSON.parse('{"__proto__":"victim","constructor":"x","prototype":"y"}');
    expect(resolveLoginMatchValue({ login_match_claim: '__proto__' }, poisoned, email)).toBeNull();
    expect(resolveLoginMatchValue({ login_match_claim: 'constructor' }, poisoned, email)).toBeNull();
    expect(resolveLoginMatchValue({ login_match_claim: 'prototype' }, poisoned, email)).toBeNull();
  });

  it('never falls back to email when a non-email claim is configured but empty', () => {
    // Guards against identity confusion: an admin who chose preferred_username must not
    // silently match on email if the username claim is missing.
    expect(resolveLoginMatchValue({ login_match_claim: 'preferred_username' }, { email }, email)).toBeNull();
  });
});
