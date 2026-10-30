import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => {
  const query = vi.fn();
  return { query, withTransaction: vi.fn(async fn => fn({ query })) };
});

import crypto from 'crypto';
import { query } from './db.js';
import {
  apiTokenCredential, apiTokensEnabled, confirmationAllowed, createToken, expiryDate, findTokenByHash, generateToken, hashToken,
  invalidateApiTokenSettingsCache, isTokenFormat, listTokens, MAX_TOKENS_PER_USER, normalizeIp,
  normalizeScopes, normalizeTokenName, recordTokenUse, RECORD_USE_EVERY_MS, resetTokenUseForTests, revokedTokensNote,
  revokeProviderTokens, revokeTokensForPolicy, tokenStillValid,
} from './apiTokens.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  query.mockReset();
  invalidateApiTokenSettingsCache();
  resetTokenUseForTests();
});

describe('token format', () => {
  it('is mfat_ and 32 random bytes in base64url, different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^mfat_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token.slice(5), 'base64url')).toHaveLength(32);
      expect(isTokenFormat(token)).toBe(true);
    }
  });

  it('refuses anything else as a token', () => {
    const good = generateToken();
    for (const bad of [good.slice(0, -1), `${good}x`, good.replace('mfat_', 'MFAT_'), `${good.slice(0, -1)}=`,
      `${good.slice(0, -1)}+`, ` ${good}`, 'mfat_', null, undefined, 42]) {
      expect(isTokenFormat(bad), String(bad)).toBe(false);
    }
  });

  it('is hashed whole, prefix included, with SHA-256', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('which Authorization header makes a token request', () => {
  it('Bearer mfat_…, with the scheme in any case', () => {
    expect(apiTokenCredential('Bearer mfat_abc')).toBe('mfat_abc');
    expect(apiTokenCredential('bearer mfat_abc')).toBe('mfat_abc');
    expect(apiTokenCredential('BEARER\tmfat_abc  ')).toBe('mfat_abc');
    // Malformed after the prefix is still a token request, and fails as one.
    expect(apiTokenCredential('Bearer mfat_ has spaces')).toBe('mfat_ has spaces');
  });

  it('nothing else: a JWT an auth proxy adds, Basic, other schemes, no header', () => {
    for (const header of ['Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'Basic YWxpY2U6c2VjcmV0', 'Bearer',
      'Bearer ', 'Bearermfat_abc', 'Token mfat_abc', 'mfat_abc', 'Bearer MFAT_abc', '', undefined, null]) {
      expect(apiTokenCredential(header), String(header)).toBe(null);
    }
  });
});

describe('scopes', () => {
  it('are a non-empty list of read, organize and draft, stored in that order', () => {
    expect(normalizeScopes(['draft', 'read'])).toEqual(['read', 'draft']);
    expect(normalizeScopes(['organize'])).toEqual(['organize']);
    expect(normalizeScopes(['read', 'organize', 'draft'])).toEqual(['read', 'organize', 'draft']);
  });

  it('refuse anything else', () => {
    for (const scopes of [[], ['read', 'read'], ['send'], ['READ'], ['read', 'admin'], 'read', null, undefined, [1]]) {
      expect(normalizeScopes(scopes), JSON.stringify(scopes)).toBe(null);
    }
  });
});

describe('names', () => {
  it('are trimmed and 1 to 60 characters, counted as the column counts them', () => {
    expect(normalizeTokenName('  Claude at work ')).toEqual({ name: 'Claude at work' });
    expect(normalizeTokenName('x'.repeat(60))).toEqual({ name: 'x'.repeat(60) });
    // 60 characters of two UTF-16 units each still fit VARCHAR(60).
    expect(normalizeTokenName('📬'.repeat(60))).toEqual({ name: '📬'.repeat(60) });
  });

  it('refuse empty, over-long, control characters and non-strings', () => {
    for (const raw of ['', '   ', 'x'.repeat(61), '📬'.repeat(61), 'a\nb', 'tab\there', 'nul\u0000', 'del\u007f', 'c1\u0085', 7, null]) {
      expect(normalizeTokenName(raw).error, JSON.stringify(raw)).toBeTruthy();
    }
  });
});

describe('expiry', () => {
  it('is that many days from now', () => {
    const now = Date.UTC(2026, 9, 14);
    expect(expiryDate(90, now)).toEqual(new Date(now + 90 * 24 * 60 * 60 * 1000));
  });
});

describe('client addresses', () => {
  it('pass through when they are addresses', () => {
    for (const ip of ['203.0.113.7', '::1', '2001:db8::1', '::ffff:198.51.100.2']) expect(normalizeIp(ip)).toBe(ip);
  });

  it('are dropped when they are anything else, or too long for the columns', () => {
    for (const ip of ['unknown', '203.0.113.7, 10.0.0.1', `2001:db8::1%${'x'.repeat(60)}`, '', undefined, null, 7]) {
      expect(normalizeIp(ip), String(ip)).toBe(null);
    }
  });
});

describe('the instance switch', () => {
  const setting = value => query.mockResolvedValue({ rows: value === undefined ? [] : [{ value }] });

  it('is on only when set to true, and off when missing', async () => {
    setting('true');
    expect(await apiTokensEnabled()).toBe(true);
    invalidateApiTokenSettingsCache();
    setting('false');
    expect(await apiTokensEnabled()).toBe(false);
    invalidateApiTokenSettingsCache();
    setting(undefined);
    expect(await apiTokensEnabled()).toBe(false);
  });

  it('is read once per 30 seconds, and again at once after invalidation', async () => {
    vi.useFakeTimers();
    try {
      setting('true');
      await apiTokensEnabled();
      await apiTokensEnabled();
      expect(query).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_001);
      await apiTokensEnabled();
      expect(query).toHaveBeenCalledTimes(2);
      setting('false');
      invalidateApiTokenSettingsCache();
      expect(await apiTokensEnabled()).toBe(false);
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a read that was under way when the switch changed', async () => {
    let answer;
    query.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = apiTokensEnabled();
    // The admin turns tokens off while the read that started before is still out.
    invalidateApiTokenSettingsCache();
    answer({ rows: [{ value: 'true' }] });
    expect(await pending).toBe(true);
    setting('false');
    expect(await apiTokensEnabled()).toBe(false);
  });
});

describe('recording when a token was last used', () => {
  it('writes the time and address at most once a minute per token', async () => {
    const write = vi.fn().mockResolvedValue({});
    recordTokenUse('t1', '203.0.113.7', { now: 1000, write });
    recordTokenUse('t1', '203.0.113.8', { now: 1000 + RECORD_USE_EVERY_MS - 1, write });
    recordTokenUse('t2', null, { now: 1000, write });
    recordTokenUse('t1', '203.0.113.9', { now: 1000 + RECORD_USE_EVERY_MS, write });
    await flush();
    expect(write.mock.calls).toEqual([
      ['UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1', ['t1', '203.0.113.7']],
      ['UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1', ['t2', null]],
      ['UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1', ['t1', '203.0.113.9']],
    ]);
  });

  it('tries again on the next request when a write fails, without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({});
    recordTokenUse('t1', null, { now: 1000, write });
    await flush();
    recordTokenUse('t1', null, { now: 1001, write });
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('looking tokens up', () => {
  afterEach(() => query.mockReset());

  it('finds a token by its hash alone, with its owner, and keeps only known scopes', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 't1', user_id: 'u1', username: 'maria', scopes: ['read', 'bogus'], expired: false }] });
    const token = await findTokenByHash('a'.repeat(64));
    expect(token).toMatchObject({ id: 't1', user_id: 'u1', username: 'maria', scopes: ['read'] });
    expect(query.mock.calls[0][0]).toMatch(/WHERE t\.token_hash = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['a'.repeat(64)]);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await findTokenByHash('b'.repeat(64))).toBe(null);
  });

  // The only expiry check before a token is let in, so it is pinned here as well as run against
  // PostgreSQL in apiTokens.postgres.test.js, which CI does not do.
  it('takes a token for expired once the database clock reaches its expiry', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 't1', user_id: 'u1', username: 'maria', scopes: ['read'], expired: true }] });
    expect(await findTokenByHash('a'.repeat(64))).toMatchObject({ expired: true });
    expect(query.mock.calls[0][0]).toMatch(/\bt\.expires_at <= NOW\(\) AS expired\b/);
  });

  it('a token still valid mid-request needs its row, unexpired, and tokens still on', async () => {
    query.mockImplementation(async sql => (/system_settings/.test(sql) ? { rows: [{ value: 'true' }] } : { rows: [{}] }));
    expect(await tokenStillValid('t1')).toBe(true);
    expect(query.mock.calls.at(-1)[0]).toMatch(/WHERE id = \$1 AND expires_at > NOW\(\)$/);
    query.mockImplementation(async sql => (/system_settings/.test(sql) ? { rows: [{ value: 'true' }] } : { rows: [] }));
    expect(await tokenStillValid('t1')).toBe(false);
    invalidateApiTokenSettingsCache();
    query.mockImplementation(async sql => (/system_settings/.test(sql) ? { rows: [{ value: 'false' }] } : { rows: [{}] }));
    expect(await tokenStillValid('t1')).toBe(false);
  });

  it('lists the user\'s tokens newest first, in the shape the settings page reads', async () => {
    const created = new Date('2026-10-01T10:00:00Z');
    const expires = new Date('2026-12-30T10:00:00Z');
    query.mockResolvedValueOnce({ rows: [{
      id: 't1', name: 'Claude', scopes: ['read'], created_at: created, expires_at: expires,
      last_used_at: null, last_used_ip: null, expired: false, token_hash: 'never-sent', confirmed_with: 'totp',
    }] });
    expect(await listTokens('u1')).toEqual([{
      id: 't1', name: 'Claude', scopes: ['read'], createdAt: created, expiresAt: expires,
      lastUsedAt: null, lastUsedIp: null, expired: false,
    }]);
    expect(query.mock.calls[0][0]).toMatch(/WHERE user_id = \$1 ORDER BY created_at DESC/);
    expect(query.mock.calls[0][0]).toMatch(/\bexpires_at <= NOW\(\) AS expired\b/);
    expect(query.mock.calls[0][0]).not.toMatch(/token_hash/);
  });
});

describe('creating a token', () => {
  it('stores only the SHA-256 of the secret it returns once', async () => {
    query.mockImplementation(async sql => {
      if (/COUNT/.test(sql)) return { rows: [{ count: 3 }] };
      if (/INSERT INTO api_tokens/.test(sql)) {
        return { rows: [{ id: 't9', name: 'Claude', scopes: ['read', 'draft'], created_at: new Date(), expires_at: expires, last_used_at: null, last_used_ip: null, expired: false }] };
      }
      return { rows: [] };
    });
    const expires = new Date(Date.now() + 86_400_000);
    const created = await createToken('u1', { name: 'Claude', scopes: ['read', 'draft'], expiresAt: expires, confirmedWith: 'totp' });
    expect(isTokenFormat(created.token)).toBe(true);
    expect(created.apiToken).toMatchObject({ id: 't9', scopes: ['read', 'draft'], lastUsedAt: null, expired: false });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO api_tokens'));
    expect(insert[1]).toEqual(['u1', 'Claude', hashToken(created.token), '["read","draft"]', expires, 'totp', null]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(created.token);
    // The sign-in policy is read inside the transaction and held shared until it commits, so an
    // admin's change to it waits for this insert or is seen by it.
    const sqls = query.mock.calls.map(([sql]) => sql);
    const policy = sqls.findIndex(sql => sql === "SELECT key, value FROM system_settings WHERE key IN ('mfa_enforcement', 'internal_auth_disabled') FOR SHARE");
    expect(policy).toBeGreaterThan(sqls.indexOf('SELECT 1 FROM users WHERE id = $1 FOR UPDATE'));
    expect(policy).toBeLessThan(sqls.findIndex(sql => sql.includes('INSERT INTO api_tokens')));
  });

  it('refuses, inside its transaction, a token the sign-in policy no longer allows, and stores nothing', async () => {
    let settings = [{ key: 'mfa_enforcement', value: 'required' }, { key: 'internal_auth_disabled', value: 'false' }];
    query.mockImplementation(async sql => {
      if (/COUNT/.test(sql)) return { rows: [{ count: 0 }] };
      if (/FOR SHARE/.test(sql)) return { rows: settings };
      if (/INSERT INTO api_tokens/.test(sql)) return { rows: [{ id: 't9', scopes: ['read'] }] };
      return { rows: [] };
    });
    const create = confirmedWith => createToken('u1', { name: 'x', scopes: ['read'], expiresAt: new Date(), confirmedWith, oidcProviderId: confirmedWith === 'oidc' ? 'p1' : null });
    expect(await create('password')).toEqual({ policyChanged: true });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
    expect(await create('totp')).toMatchObject({ apiToken: { id: 't9' } });
    settings = [{ key: 'mfa_enforcement', value: 'off' }, { key: 'internal_auth_disabled', value: 'true' }];
    expect(await create('totp')).toEqual({ policyChanged: true });
    expect(await create('oidc')).toMatchObject({ apiToken: { id: 't9' } });
  });

  it('allows a confirmation by the same rule that revokes tokens after a policy change', () => {
    const allowed = (settings) => ['password', 'totp', 'oidc'].filter(c => confirmationAllowed(settings, c));
    expect(allowed({})).toEqual(['password', 'totp', 'oidc']);
    expect(allowed({ mfa_enforcement: 'off', internal_auth_disabled: 'false' })).toEqual(['password', 'totp', 'oidc']);
    expect(allowed({ mfa_enforcement: 'required' })).toEqual(['totp', 'oidc']);
    expect(allowed({ internal_auth_disabled: 'true' })).toEqual(['oidc']);
    expect(allowed({ mfa_enforcement: 'required', internal_auth_disabled: 'true' })).toEqual(['oidc']);
  });

  it('records the provider when single sign-on confirmed it', async () => {
    query.mockImplementation(async sql => (/COUNT/.test(sql) ? { rows: [{ count: 0 }] } : { rows: [{ id: 't9', scopes: ['read'] }] }));
    await createToken('u1', { name: 'x', scopes: ['read'], expiresAt: new Date(), confirmedWith: 'oidc', oidcProviderId: 'p1' });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO api_tokens'));
    expect(insert[1].slice(-2)).toEqual(['oidc', 'p1']);
  });

  it('holds the user row while it counts, and stores nothing at the limit', async () => {
    query.mockImplementation(async sql => (/COUNT/.test(sql) ? { rows: [{ count: MAX_TOKENS_PER_USER }] } : { rows: [] }));
    expect(await createToken('u1', { name: 'x', scopes: ['read'], expiresAt: new Date(), confirmedWith: 'password' })).toBe(null);
    const sqls = query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toBe('SELECT 1 FROM users WHERE id = $1 FOR UPDATE');
    expect(sqls.some(sql => sql.includes('INSERT'))).toBe(false);
  });
});

// Run against PostgreSQL in apiTokens.postgres.test.js, which CI does not do, so pinned here too.
describe('deleting the tokens a sign-in policy no longer allows', () => {
  const client = { query: vi.fn(async () => ({ rowCount: 2 })) };
  beforeEach(() => client.query.mockClear());

  it('keeps only single sign-on tokens once password sign-in is off', async () => {
    expect(await revokeTokensForPolicy(client, 'ssoOnly')).toBe(2);
    expect(client.query.mock.calls).toEqual([[
      'DELETE FROM api_tokens WHERE NOT (confirmed_with = ANY($1::text[]))', [['oidc']],
    ]]);
  });

  it('keeps two-factor and single sign-on tokens once two-factor is required', async () => {
    await revokeTokensForPolicy(client, 'mfaRequired');
    expect(client.query.mock.calls[0][1]).toEqual([['totp', 'oidc']]);
  });

  it('refuses a policy it does not know rather than deleting nothing', async () => {
    await expect(revokeTokensForPolicy(client, 'ssoonly')).rejects.toThrow('No API token policy named ssoonly');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('deletes the tokens confirmed through a provider being turned off', async () => {
    expect(await revokeProviderTokens(client, 'p1')).toBe(2);
    expect(client.query.mock.calls).toEqual([['DELETE FROM api_tokens WHERE oidc_provider_id = $1', ['p1']]]);
  });

  it('says how many went, for the admin log line', () => {
    expect(revokedTokensNote(0)).toBe('');
    expect(revokedTokensNote(1)).toBe(', and deleted 1 API token');
    expect(revokedTokensNote(3)).toBe(', and deleted 3 API tokens');
  });
});
