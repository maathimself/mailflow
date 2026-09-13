import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('./microsoftOAuth.js', () => ({ refreshMicrosoftToken: vi.fn() }));
vi.mock('./googleOAuth.js', () => ({ refreshGoogleToken: vi.fn() }));

// Minimal Redis lock semantics: SET NX with expiry and compare-and-delete via EVAL.
const locks = vi.hoisted(() => new Map());
vi.mock('../redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value, opts) => {
      if (opts?.NX && locks.has(key)) return null;
      locks.set(key, value);
      return 'OK';
    }),
    eval: vi.fn(async (_script, { keys, arguments: args }) => {
      if (locks.get(keys[0]) === args[0]) {
        locks.delete(keys[0]);
        return 1;
      }
      return 0;
    }),
  },
}));

const { query } = await import('../db.js');
const { redisClient } = await import('../redis.js');
const { refreshMicrosoftToken } = await import('./microsoftOAuth.js');
const { refreshGoogleToken } = await import('./googleOAuth.js');
const { refreshOAuthToken, ensureFreshOAuthAccount, needsTokenRefresh } = await import('./tokenManager.js');

const MINUTE = 60 * 1000;
const expiresIn = (ms) => new Date(Date.now() + ms);
const googleAccount = (over = {}) => ({
  id: 'acc-g',
  oauth_provider: 'google',
  email_address: 'user@gmail.com',
  oauth_access_token: 'enc-at',
  oauth_refresh_token: 'enc-rt',
  oauth_token_expiry: expiresIn(-MINUTE),
  oauth_reconnect_required: false,
  ...over,
});
const providerError = (oauthError, message = 'provider said: secret-refresh-token revoked') =>
  Object.assign(new Error(message), { oauthError });

// Route SQL to handlers so tests can describe the database state declaratively.
function mockDb({ row }) {
  query.mockImplementation(async (sql) => {
    if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) return { rows: row ? [row] : [] };
    return { rows: [], rowCount: 1 };
  });
}

let errorSpy;
beforeEach(() => {
  locks.clear();
  query.mockReset();
  redisClient.set.mockClear();
  redisClient.eval.mockClear();
  refreshMicrosoftToken.mockReset();
  refreshGoogleToken.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('needsTokenRefresh', () => {
  it('uses a 5-minute skew window and treats missing token or expiry as stale', () => {
    expect(needsTokenRefresh(googleAccount({ oauth_token_expiry: expiresIn(10 * MINUTE) }))).toBe(false);
    expect(needsTokenRefresh(googleAccount({ oauth_token_expiry: expiresIn(4 * MINUTE) }))).toBe(true);
    expect(needsTokenRefresh(googleAccount({ oauth_token_expiry: expiresIn(-MINUTE) }))).toBe(true);
    expect(needsTokenRefresh(googleAccount({ oauth_token_expiry: expiresIn(10 * MINUTE), oauth_access_token: null }))).toBe(true);
    expect(needsTokenRefresh(googleAccount({ oauth_token_expiry: null }))).toBe(true);
  });
});

describe('refreshOAuthToken', () => {
  it('dispatches by provider', async () => {
    refreshGoogleToken.mockResolvedValue({ id: 'acc-g', oauth_access_token: 'g' });
    refreshMicrosoftToken.mockResolvedValue({ id: 'acc-m', oauth_access_token: 'm' });

    expect(await refreshOAuthToken(googleAccount())).toEqual({ id: 'acc-g', oauth_access_token: 'g' });
    expect(await refreshOAuthToken({ id: 'acc-m', oauth_provider: 'microsoft' })).toEqual({ id: 'acc-m', oauth_access_token: 'm' });
    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(refreshMicrosoftToken).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown providers', async () => {
    const err = await refreshOAuthToken({ id: 'x', oauth_provider: 'yahoo' }).catch(e => e);
    expect(err.code).toBe('oauth_unsupported_provider');
  });

  it.each(['google', 'microsoft'])('marks %s invalid_grant as oauth_reconnect_required without leaking the provider text', async (provider) => {
    const impl = provider === 'google' ? refreshGoogleToken : refreshMicrosoftToken;
    impl.mockRejectedValue(providerError('invalid_grant'));
    query.mockResolvedValue({ rows: [], rowCount: 1 });

    const err = await refreshOAuthToken(googleAccount({ oauth_provider: provider })).catch(e => e);

    expect(err.code).toBe('oauth_reconnect_required');
    expect(err.message).not.toMatch(/secret-refresh-token|provider said/);
    expect(err.cause).toBeUndefined();
    const flag = query.mock.calls.find(([sql]) => /oauth_reconnect_required = true/.test(sql));
    expect(flag).toBeTruthy();
    expect(flag[0]).toMatch(/sync_error = 'oauth_reconnect_required'/);
    expect(flag[1]).toEqual(['acc-g']);
  });

  it('treats a missing refresh token as requiring reconnect', async () => {
    refreshGoogleToken.mockRejectedValue(providerError('missing_refresh_token'));
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const err = await refreshOAuthToken(googleAccount()).catch(e => e);
    expect(err.code).toBe('oauth_reconnect_required');
  });

  it('keeps other failures retryable and does not flag the account', async () => {
    refreshGoogleToken.mockRejectedValue(providerError(undefined, 'socket hang up secret-refresh-token'));
    const err = await refreshOAuthToken(googleAccount()).catch(e => e);
    expect(err.code).toBe('oauth_refresh_failed');
    expect(err.message).not.toMatch(/secret-refresh-token/);
    expect(query).not.toHaveBeenCalled();
  });

  it('never logs provider messages or tokens', async () => {
    refreshGoogleToken.mockRejectedValue(providerError('invalid_grant', 'Bad secret-refresh-token enc-at'));
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await refreshOAuthToken(googleAccount()).catch(() => {});
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toMatch(/secret-refresh-token|enc-at|enc-rt|user@gmail\.com/);
  });
});

describe('ensureFreshOAuthAccount', () => {
  it('returns non-OAuth accounts unchanged without touching Redis or the database', async () => {
    const account = { id: 'p1', oauth_provider: null, auth_pass: 'x' };
    expect(await ensureFreshOAuthAccount(account)).toBe(account);
    expect(query).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();
  });

  it('returns a fresh OAuth account unchanged', async () => {
    const account = googleAccount({ oauth_token_expiry: expiresIn(30 * MINUTE) });
    expect(await ensureFreshOAuthAccount(account)).toBe(account);
    expect(refreshGoogleToken).not.toHaveBeenCalled();
  });

  it('takes the cross-process lock, re-reads the row and refreshes a stale token', async () => {
    const stale = googleAccount();
    mockDb({ row: stale });
    refreshGoogleToken.mockResolvedValue({ ...stale, oauth_access_token: 'new-at', oauth_token_expiry: expiresIn(60 * MINUTE) });

    const result = await ensureFreshOAuthAccount(stale);

    expect(result.oauth_access_token).toBe('new-at');
    const [lockKey, , lockOpts] = redisClient.set.mock.calls[0];
    expect(lockKey).toBe('oauth:refresh-lock:acc-g');
    expect(lockOpts).toMatchObject({ NX: true });
    expect(query.mock.calls[0][0]).toMatch(/SELECT \* FROM email_accounts WHERE id = \$1/);
    // Refresh ran with the re-read row, and the lock was released afterwards.
    expect(refreshGoogleToken).toHaveBeenCalledWith(stale);
    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    expect(locks.size).toBe(0);
  });

  it('reuses a refresh another process already completed', async () => {
    const fresh = googleAccount({ oauth_access_token: 'other-process-at', oauth_token_expiry: expiresIn(55 * MINUTE) });
    mockDb({ row: fresh });

    const result = await ensureFreshOAuthAccount(googleAccount());

    expect(result).toEqual(fresh);
    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
  });

  it('dedups concurrent refreshes for the same account in-process', async () => {
    const stale = googleAccount();
    mockDb({ row: stale });
    let resolveRefresh;
    refreshGoogleToken.mockImplementation(() => new Promise((r) => { resolveRefresh = r; }));

    const calls = [ensureFreshOAuthAccount(stale), ensureFreshOAuthAccount({ ...stale }), ensureFreshOAuthAccount(stale)];
    await vi.waitFor(() => expect(refreshGoogleToken).toHaveBeenCalled());
    resolveRefresh({ ...stale, oauth_access_token: 'shared-at' });
    const results = await Promise.all(calls);

    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(redisClient.set).toHaveBeenCalledTimes(1);
    expect(results.map(r => r.oauth_access_token)).toEqual(['shared-at', 'shared-at', 'shared-at']);
  });

  it('waits for a lock held by another process and then reuses its result', async () => {
    const stale = googleAccount();
    locks.set('oauth:refresh-lock:acc-g', 'other-process');
    let row = stale;
    query.mockImplementation(async () => ({ rows: [row] }));

    const pending = ensureFreshOAuthAccount(stale, { lockPollMs: 5, lockWaitMs: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(refreshGoogleToken).not.toHaveBeenCalled();
    // The other process finishes: persists fresh tokens and releases its lock.
    row = googleAccount({ oauth_access_token: 'peer-at', oauth_token_expiry: expiresIn(60 * MINUTE) });
    locks.delete('oauth:refresh-lock:acc-g');

    const result = await pending;
    expect(result.oauth_access_token).toBe('peer-at');
    expect(refreshGoogleToken).not.toHaveBeenCalled();
  });

  it('fails without refreshing when the lock cannot be acquired in time', async () => {
    locks.set('oauth:refresh-lock:acc-g', 'stuck-process');
    mockDb({ row: googleAccount() });
    const err = await ensureFreshOAuthAccount(googleAccount(), { lockPollMs: 5, lockWaitMs: 25 }).catch(e => e);
    expect(err.code).toBe('oauth_refresh_failed');
    expect(refreshGoogleToken).not.toHaveBeenCalled();
    // A lock owned by someone else is never deleted.
    expect(locks.get('oauth:refresh-lock:acc-g')).toBe('stuck-process');
  });

  it('does not call the provider for an account already flagged for reconnect', async () => {
    const flagged = googleAccount({ oauth_reconnect_required: true });
    mockDb({ row: flagged });
    const err = await ensureFreshOAuthAccount(flagged).catch(e => e);
    expect(err.code).toBe('oauth_reconnect_required');
    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
  });

  it('propagates oauth_reconnect_required from invalid_grant and releases the lock', async () => {
    mockDb({ row: googleAccount() });
    refreshGoogleToken.mockRejectedValue(providerError('invalid_grant'));
    const err = await ensureFreshOAuthAccount(googleAccount()).catch(e => e);
    expect(err.code).toBe('oauth_reconnect_required');
    expect(query.mock.calls.some(([sql]) => /oauth_reconnect_required = true/.test(sql))).toBe(true);
    expect(locks.size).toBe(0);
  });

  it('fails when the account no longer exists', async () => {
    mockDb({ row: null });
    const err = await ensureFreshOAuthAccount(googleAccount()).catch(e => e);
    expect(err.code).toBe('oauth_account_not_found');
    expect(locks.size).toBe(0);
  });
});
