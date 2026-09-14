import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OAUTH_PROVIDERS, isOAuthAccount, OAUTH_RECONNECT_REQUIRED_MESSAGE, OAUTH_SEND_FAILURES,
} from './constants.js';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(`${SRC}${rel}`, 'utf8');
const CONSUMERS = [
  'services/oauth/tokenManager.js',
  'services/imapManager.js',
  'services/smtpTransport.js',
  'routes/send.js',
];

describe('shared OAuth constants', () => {
  it('lists the OAuth providers', () => {
    expect([...OAUTH_PROVIDERS].sort()).toEqual(['google', 'microsoft']);
    expect(isOAuthAccount({ oauth_provider: 'google' })).toBe(true);
    expect(isOAuthAccount({ oauth_provider: 'microsoft' })).toBe(true);
    expect(isOAuthAccount({ oauth_provider: null })).toBe(false);
    expect(isOAuthAccount(undefined)).toBe(false);
  });

  it('maps token-manager failures to stable, secret-free send results', () => {
    expect(OAUTH_SEND_FAILURES.oauth_reconnect_required).toEqual({
      status: 409,
      error: 'Access to this account was revoked or has expired. Reconnect the account to send mail.',
    });
    expect(OAUTH_SEND_FAILURES.oauth_refresh_failed).toEqual({
      status: 503,
      error: 'Could not renew access to this account. Please try again shortly.',
    });
    expect(OAUTH_RECONNECT_REQUIRED_MESSAGE).toBe('OAuth access was revoked or expired — reconnect the account');
  });

  it('has no imports, so no test ever needs to mock it', () => {
    expect(read('services/oauth/constants.js')).not.toMatch(/^\s*import\b/m);
  });

  it('is the only definition of the provider list and the user-facing strings', () => {
    for (const rel of CONSUMERS) {
      const text = read(rel);
      expect(text, rel).toMatch(/from '[./]*(oauth\/|services\/oauth\/)?constants\.js'/);
      expect(text, rel).not.toMatch(/new Set\(\[\s*'(google|microsoft)',\s*'(google|microsoft)'\s*\]\)/);
      expect(text, rel).not.toContain('Reconnect the account to send mail.');
      expect(text, rel).not.toContain('Could not renew access to this account.');
      expect(text, rel).not.toContain('OAuth access was revoked or expired');
    }
  });
});
