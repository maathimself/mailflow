import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// IMAP paths wired to the REAL token manager (services/oauth/tokenManager.js). Only its edges are
// mocked: the database, the Redis lock and the provider refresh modules. That way these tests
// prove the behaviour end to end through the single entry point: refresh before connect, one
// refresh for concurrent paths, reconnect-required handling and the timeout budget.
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(v => v), encrypt: vi.fn(v => v) }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'redacted') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./oauth/googleOAuth.js', () => ({ refreshGoogleToken: vi.fn() }));
vi.mock('./oauth/microsoftOAuth.js', () => ({ refreshMicrosoftToken: vi.fn() }));

// Minimal Redis lock semantics: SET NX with expiry and compare-and-delete via EVAL.
const locks = vi.hoisted(() => new Map());
vi.mock('./redis.js', () => ({
  redisClient: {
    set: vi.fn(async (key, value, opts) => {
      if (opts?.NX && locks.has(key)) return null;
      locks.set(key, value);
      return 'OK';
    }),
    eval: vi.fn(async (_script, { keys, arguments: args }) => {
      if (locks.get(keys[0]) === args[0]) { locks.delete(keys[0]); return 1; }
      return 0;
    }),
  },
}));

import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { refreshGoogleToken } from './oauth/googleOAuth.js';
import { refreshMicrosoftToken } from './oauth/microsoftOAuth.js';
import {
  ImapManager, AUTH_FAILURE_COOLDOWN_MS, connectCooldownMs, tokenRefreshTimeoutMs, OAUTH_REFRESH_LOCK_WAIT_MS,
} from './imapManager.js';
// The provider modules are mocked here; their fetch timeout and call counts live in the shared
// constants module they import, so the budget checks track the real values.
import { PROVIDER_FETCH_TIMEOUT_MS, OAUTH_REFRESH_MAX_TOKEN_CALLS } from './oauth/constants.js';

const MINUTE = 60 * 1000;
const inMinutes = (n) => new Date(Date.now() + n * MINUTE);

const imapErr = (props) => Object.assign(new Error(props.message || 'Command failed'), props);
const gmailXoauthFailure = () => imapErr({
  response: '1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
  responseStatus: 'NO',
  responseText: 'Invalid credentials (Failure)',
  serverResponseCode: 'AUTHENTICATIONFAILED',
  authenticationFailed: true,
  oauthError: { status: '400', schemes: 'Bearer', scope: 'https://mail.google.com/' },
});
const loginLimitRefusal = () => imapErr({
  response: '1 NO [LIMIT] Too many simultaneous connections',
  responseText: 'Too many simultaneous connections',
  serverResponseCode: 'LIMIT',
  authenticationFailed: true,
});
const invalidGrant = () => Object.assign(new Error('provider body: revoked refresh token secret-rt'), { oauthError: 'invalid_grant' });

let nextId = 0;
const gmailAccount = (over = {}) => ({
  id: `gmail-${++nextId}`,
  user_id: 'u1',
  enabled: true,
  protocol: 'imap',
  email_address: 'user@gmail.com',
  auth_user: 'user@gmail.com',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  imap_tls: true,
  oauth_provider: 'google',
  oauth_access_token: 'expired-at',
  oauth_refresh_token: 'stored-rt',
  oauth_token_expiry: inMinutes(-1),
  oauth_reconnect_required: false,
  ...over,
});

// Database state per account id; SELECT * re-reads return the current row.
const rows = new Map();
function installDb() {
  query.mockImplementation(async (sql, params = []) => {
    if (/^\s*SELECT \* FROM email_accounts WHERE id = \$1/.test(sql)) {
      const row = rows.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/SET oauth_reconnect_required = true/.test(sql)) {
      const row = rows.get(params[0]);
      if (row) rows.set(row.id, { ...row, oauth_reconnect_required: true, sync_error: 'oauth_reconnect_required' });
      return { rows: [], rowCount: 1 };
    }
    // Apply sync_error writes the way Postgres would, honouring the flag guard in the WHERE clause.
    if (sql.startsWith('UPDATE email_accounts SET sync_error = $1')) {
      const [detail, id] = params;
      const row = rows.get(id);
      const guarded = /oauth_reconnect_required = false OR \$1 = 'oauth_reconnect_required'/.test(sql);
      if (!row || (guarded && row.oauth_reconnect_required && detail !== 'oauth_reconnect_required')) {
        return { rows: [], rowCount: 0 };
      }
      rows.set(id, { ...row, sync_error: detail });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}
const syncErrorWrites = (id) => query.mock.calls
  .filter(([sql, params]) => sql.startsWith('UPDATE email_accounts SET sync_error = $1') && params[1] === id)
  .map(([, params]) => params[0]);
const tokensUsed = () => ImapFlow.mock.calls.map(([cfg]) => cfg.auth.accessToken);

// Each scripted outcome is consumed by one ImapFlow connect; the last one repeats.
let connectOutcomes;
function scriptConnects(...outcomes) { connectOutcomes = outcomes; }

function newManager() {
  const mgr = new ImapManager(null);
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer']) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

let intervalSpy;
beforeEach(() => {
  vi.clearAllMocks();
  locks.clear();
  rows.clear();
  installDb();
  intervalSpy = vi.spyOn(globalThis, 'setInterval');
  scriptConnects(() => new Error('connect stopped by test'));
  ImapFlow.mockImplementation(function () {
    const outcome = connectOutcomes.length > 1 ? connectOutcomes.shift() : connectOutcomes[0];
    return Object.assign(new EventEmitter(), {
      connect: vi.fn(() => Promise.reject(outcome())),
      close: vi.fn(),
      logout: vi.fn(() => Promise.resolve()),
    });
  });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: false });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  refreshGoogleToken.mockImplementation(async (account) => {
    const fresh = { ...account, oauth_access_token: `fresh-${account.id}`, oauth_token_expiry: inMinutes(60) };
    rows.set(account.id, fresh);
    return fresh;
  });
  refreshMicrosoftToken.mockImplementation(async (account) => {
    const fresh = { ...account, oauth_access_token: `fresh-ms-${account.id}`, oauth_token_expiry: inMinutes(60) };
    rows.set(account.id, fresh);
    return fresh;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('refresh before IMAP connect', () => {
  it('refreshes an expired Google token and logs in with the fresh one', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, acct);

    await newManager().connectAccount(acct);

    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(tokensUsed()).toEqual([`fresh-${acct.id}`]);
  });

  it('runs Microsoft accounts through the same dispatcher', async () => {
    const acct = gmailAccount({ oauth_provider: 'microsoft', imap_host: 'outlook.office365.com' });
    rows.set(acct.id, acct);

    await newManager().connectAccount(acct);

    expect(refreshMicrosoftToken).toHaveBeenCalledTimes(1);
    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(tokensUsed()).toEqual([`fresh-ms-${acct.id}`]);
  });

  it('shares one refresh between concurrent IMAP paths for the same account', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    let release;
    refreshGoogleToken.mockImplementationOnce(account => new Promise((resolve) => {
      release = () => {
        const fresh = { ...account, oauth_access_token: 'shared-at', oauth_token_expiry: inMinutes(60) };
        rows.set(account.id, fresh);
        resolve(fresh);
      };
    }));

    const first = newManager().connectAccount(acct);
    const second = newManager()._pollOnlyTick(acct);
    await vi.waitFor(() => expect(refreshGoogleToken).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);

    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(tokensUsed()).toEqual(['shared-at', 'shared-at']);
  });

  it('never sends password accounts through the token manager', async () => {
    const acct = { ...gmailAccount({ oauth_provider: null, imap_host: 'imap.example.com' }), auth_pass: 'pw' };
    rows.set(acct.id, acct);

    await newManager().connectAccount(acct);

    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => /SELECT \* FROM email_accounts WHERE id/.test(sql))).toBe(false);
    expect(ImapFlow).toHaveBeenCalledTimes(1);
  });
});

describe('oauth_reconnect_required', () => {
  it('flags the account, reports the stable code and pushes it without arming a retry loop', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    refreshGoogleToken.mockRejectedValue(invalidGrant());
    const mgr = newManager();

    expect(await mgr.connectAccount(acct)).toBe(false);

    expect(rows.get(acct.id).oauth_reconnect_required).toBe(true);
    expect(syncErrorWrites(acct.id)).toEqual(['oauth_reconnect_required']);
    expect(mgr.broadcast).toHaveBeenCalledWith({ type: 'account_error', accountId: acct.id, error: 'oauth_reconnect_required' }, 'u1');
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(mgr.connectingAccounts.has(acct.id)).toBe(false);
    // Neither the refusal backoff nor the auth cooldown: those expire and retry on their own.
    expect(mgr._connectCooldown.get(acct.id)?.until).toBe(Infinity);
    const logged = [...console.error.mock.calls, ...console.warn.mock.calls].flat().join('\n');
    expect(logged).not.toMatch(/secret-rt|provider body/);

    // A later attempt with the same stale row neither calls the provider nor logs in.
    refreshGoogleToken.mockClear();
    expect(await mgr.connectAccount(acct)).toBe(false);
    await mgr._pollOnlyTick(acct);
    await mgr._syncTick(acct);
    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('stops the account timers so the periodic sync no longer runs', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    refreshGoogleToken.mockRejectedValue(invalidGrant());
    const mgr = newManager();
    const timer = setInterval(() => {}, 60000);
    mgr.syncIntervals.set(acct.id, timer);

    await mgr._pollOnlyTick(acct);

    expect(mgr.syncIntervals.has(acct.id)).toBe(false);
    expect(syncErrorWrites(acct.id)).toEqual(['oauth_reconnect_required']);
    clearInterval(timer);
  });

  it('skips flagged accounts in the health check and at startup', async () => {
    const flagged = gmailAccount({ oauth_reconnect_required: true });
    rows.set(flagged.id, flagged);
    const mgr = newManager();
    const healthCheck = intervalSpy.mock.calls.find(([, ms]) => ms === 90000)[0];
    const connectSpy = vi.spyOn(mgr, 'connectAccount');
    // Honour the SQL filter the way Postgres would, so the test fails if the filter is dropped.
    query.mockImplementation(async (sql, params = []) => {
      const visible = [...rows.values()].filter(r => !/oauth_reconnect_required\s*=\s*false|NOT oauth_reconnect_required/.test(sql) || !r.oauth_reconnect_required);
      if (sql.includes('SELECT id, email_address')) return { rows: visible };
      if (sql.startsWith('SELECT preferences')) return { rows: [] };
      if (sql.startsWith('SELECT * FROM email_accounts WHERE user_id')) return { rows: visible };
      if (sql.startsWith('SELECT * FROM email_accounts WHERE id')) return { rows: [rows.get(params[0])].filter(Boolean) };
      return { rows: [] };
    });
    vi.useFakeTimers();

    await healthCheck();
    await mgr.connectAllForUser('u1');
    await vi.runOnlyPendingTimersAsync();

    expect(connectSpy).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(refreshGoogleToken).not.toHaveBeenCalled();
  });

  it('leaves flagged accounts out of the folder-status scheduler', async () => {
    const flagged = gmailAccount({ oauth_reconnect_required: true });
    const healthy = gmailAccount();
    const mgr = newManager();
    const scheduler = intervalSpy.mock.calls.find(([, ms]) => ms === 10000)[0];
    const refresh = vi.spyOn(mgr.folderStatusMonitor, 'refresh').mockResolvedValue(undefined);
    query.mockImplementation(async (sql) => ({
      rows: [flagged, healthy].filter(r => !/oauth_reconnect_required\s*=\s*false|NOT oauth_reconnect_required/.test(sql) || !r.oauth_reconnect_required),
    }));

    scheduler();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());

    expect(refresh.mock.calls.map(([a]) => a.id)).toEqual([healthy.id]);
  });

  it('does not connect a flagged row handed to connectAccount directly', async () => {
    const flagged = gmailAccount({ oauth_reconnect_required: true, oauth_token_expiry: inMinutes(50) });
    rows.set(flagged.id, flagged);
    expect(await newManager().connectAccount(flagged)).toBe(false);
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('connects immediately after reconsent even though the account was skipped before', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    refreshGoogleToken.mockRejectedValueOnce(invalidGrant());
    const mgr = newManager();
    await mgr.connectAccount(acct);
    expect(ImapFlow).not.toHaveBeenCalled();

    // What the Google/Microsoft consent callback does: new tokens, flag reset, cooldown cleared.
    const reconsented = { ...rows.get(acct.id), oauth_access_token: 'consent-at', oauth_token_expiry: inMinutes(60), oauth_reconnect_required: false, sync_error: null };
    rows.set(acct.id, reconsented);
    mgr.clearConnectCooldown(acct.id);
    await mgr.connectAccount(reconsented);

    expect(tokensUsed()).toEqual(['consent-at']);
  });

  it('keeps the stable code in sync_error when a success path clears errors for a flagged account', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, { ...acct, oauth_reconnect_required: true, sync_error: 'oauth_reconnect_required' });
    // Apply the clear the way Postgres would, honouring any flag condition in the WHERE clause.
    query.mockImplementation(async (sql, params = []) => {
      if (sql.startsWith('UPDATE email_accounts SET sync_error = NULL')) {
        const row = rows.get(params[0]);
        if (!row || (/oauth_reconnect_required\s*=\s*false|NOT oauth_reconnect_required/.test(sql) && row.oauth_reconnect_required)) {
          return { rows: [], rowCount: 0 };
        }
        rows.set(row.id, { ...row, sync_error: null });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const mgr = newManager();
    mgr._syncErrorState.set(acct.id, 'IMAP connect timeout (30000ms)');

    // A stale, unflagged copy of the row reaches a success path (connect, poll-only start, sync tick).
    await mgr._clearAccountError(acct);

    expect(rows.get(acct.id).sync_error).toBe('oauth_reconnect_required');
    expect(mgr.broadcast).not.toHaveBeenCalledWith({ type: 'account_connected', accountId: acct.id }, 'u1');
  });

  it('keeps the stable code in sync_error when a refusal streak is recorded for a flagged account', async () => {
    const acct = gmailAccount();
    // Flagged elsewhere (an SMTP send) while the live IMAP session keeps syncing on its stale row.
    rows.set(acct.id, { ...acct, oauth_reconnect_required: true, sync_error: 'oauth_reconnect_required' });
    const mgr = newManager();

    await mgr._recordAccountError(acct, 'Too many requests, throttled');
    await mgr._recordAccountError(acct, 'Too many requests, throttled');

    expect(syncErrorWrites(acct.id)).toHaveLength(1);
    expect(rows.get(acct.id).sync_error).toBe('oauth_reconnect_required');
    expect(mgr._syncErrorState.has(acct.id)).toBe(false);
    expect(mgr.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'account_error' }), 'u1');
  });

  it('still records the stable code itself for a flagged account', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, { ...acct, oauth_reconnect_required: true, sync_error: 'Too many requests, throttled' });
    const mgr = newManager();

    await mgr._noteOAuthReconnectRequired(acct);

    expect(rows.get(acct.id).sync_error).toBe('oauth_reconnect_required');
    expect(mgr._syncErrorState.get(acct.id)).toBe('oauth_reconnect_required');
    expect(mgr.broadcast).toHaveBeenCalledWith(
      { type: 'account_error', accountId: acct.id, error: 'oauth_reconnect_required' }, 'u1');
  });

  it('does not let a late refusal or auth failure replace the reconnect-required gate', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    refreshGoogleToken.mockRejectedValue(invalidGrant());
    const mgr = newManager();
    await mgr.connectAccount(acct);
    const gate = { until: Infinity, failures: 0, oauthReconnectRequired: true };
    expect(mgr._connectCooldown.get(acct.id)).toEqual(gate);

    // An in-flight backfill or sync that fails after the account was flagged.
    mgr._noteConnectionRefusal(acct);
    expect(mgr._connectCooldown.get(acct.id)).toEqual(gate);
    mgr._noteAuthFailure(acct);
    expect(mgr._connectCooldown.get(acct.id)).toEqual(gate);
  });
});

describe('transient refresh failures take the recoverable path', () => {
  it.each(['google', 'microsoft'])('fits the lock wait plus the worst-case %s token calls inside its refresh budget', (provider) => {
    const worstCase = OAUTH_REFRESH_LOCK_WAIT_MS + OAUTH_REFRESH_MAX_TOKEN_CALLS[provider] * PROVIDER_FETCH_TIMEOUT_MS;
    expect(worstCase).toBeLessThan(tokenRefreshTimeoutMs({ oauth_provider: provider }));
  });

  it('keeps the Google refresh budget at 15 s and gives Microsoft room for its second token call', () => {
    expect(OAUTH_REFRESH_MAX_TOKEN_CALLS).toEqual({ google: 1, microsoft: 2 });
    expect(tokenRefreshTimeoutMs({ oauth_provider: 'google' })).toBe(15000);
    expect(tokenRefreshTimeoutMs({ oauth_provider: 'microsoft' })).toBe(25000);
  });

  it('lets the token manager give up on a busy lock before the refresh budget runs out', async () => {

    vi.useFakeTimers();
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    locks.set(`oauth:refresh-lock:${acct.id}`, 'other-process');
    const mgr = newManager();
    let result = 'pending';
    mgr.connectAccount(acct).then((r) => { result = r; });

    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_LOCK_WAIT_MS - 500);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1000);
    // The token manager gave up on the lock itself, well before the caller's timeout fired.
    expect(result).toBe(false);
    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(mgr.connectingAccounts.has(acct.id)).toBe(false);
    const logged = console.error.mock.calls.flat().join('\n');
    expect(logged).toContain('oauth_refresh_failed');
    expect(logged).not.toMatch(/timeout \(\d+ms\)/);
  });

  it('backs off like a refusal and surfaces the error only when it repeats, never flagging the account', async () => {
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    refreshGoogleToken.mockRejectedValue(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));
    const mgr = newManager();
    const before = Date.now();

    await mgr.connectAccount(acct);
    const cd = mgr._connectCooldown.get(acct.id);
    expect(cd.until).toBeGreaterThanOrEqual(before + connectCooldownMs(1));
    expect(cd.until).toBeLessThan(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(syncErrorWrites(acct.id)).toEqual([]);

    cd.until = 0;
    await mgr.connectAccount(acct);
    expect(syncErrorWrites(acct.id)).toHaveLength(1);
    expect(syncErrorWrites(acct.id)[0]).not.toMatch(/fetch failed|ECONNRESET/);
    expect(rows.get(acct.id).oauth_reconnect_required).toBe(false);
  });

  it('treats a refresh that outlives the budget as transient, not as reconnect-required', async () => {
    vi.useFakeTimers();
    const acct = gmailAccount();
    rows.set(acct.id, acct);
    refreshGoogleToken.mockImplementation(() => new Promise(() => {}));
    const mgr = newManager();
    let result = 'pending';
    mgr.connectAccount(acct).then((r) => { result = r; });

    await vi.advanceTimersByTimeAsync(tokenRefreshTimeoutMs(acct) - 100);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(200);

    expect(result).toBe(false);
    expect(mgr._connectCooldown.get(acct.id).until).toBeLessThan(Date.now() + AUTH_FAILURE_COOLDOWN_MS);
    expect(rows.get(acct.id).oauth_reconnect_required).toBe(false);
    expect(mgr.connectingAccounts.has(acct.id)).toBe(false);
  });

  it('lets a Microsoft refresh that needs both token calls finish instead of counting it as a failure', async () => {
    vi.useFakeTimers();
    const acct = gmailAccount({ oauth_provider: 'microsoft', imap_host: 'outlook.office365.com' });
    rows.set(acct.id, acct);
    // AADSTS90023 self-heal: the first call with the secret and the retry without it both run
    // to their full fetch timeout before the second one succeeds.
    refreshMicrosoftToken.mockImplementation((account) => new Promise((resolve) => {
      setTimeout(() => {
        const fresh = { ...account, oauth_access_token: `fresh-ms-${account.id}`, oauth_token_expiry: inMinutes(60) };
        rows.set(account.id, fresh);
        resolve(fresh);
      }, OAUTH_REFRESH_MAX_TOKEN_CALLS.microsoft * PROVIDER_FETCH_TIMEOUT_MS);
    }));
    const mgr = newManager();
    let result = 'pending';
    mgr.connectAccount(acct).then((r) => { result = r; });

    await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_MAX_TOKEN_CALLS.microsoft * PROVIDER_FETCH_TIMEOUT_MS + 100);
    await vi.waitFor(() => expect(result).not.toBe('pending'));

    expect(tokensUsed()).toEqual([`fresh-ms-${acct.id}`]);
    const logged = console.error.mock.calls.flat().join('\n');
    expect(logged).not.toContain('oauth_refresh_failed');
    expect(logged).not.toMatch(/OAuth token refresh timeout/);
  });

  it('still cuts off a hung Microsoft refresh at its own budget as a transient failure', async () => {
    vi.useFakeTimers();
    const acct = gmailAccount({ oauth_provider: 'microsoft', imap_host: 'outlook.office365.com' });
    rows.set(acct.id, acct);
    refreshMicrosoftToken.mockImplementation(() => new Promise(() => {}));
    const mgr = newManager();
    let result = 'pending';
    mgr.connectAccount(acct).then((r) => { result = r; });

    await vi.advanceTimersByTimeAsync(tokenRefreshTimeoutMs(acct) - 100);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(200);

    expect(result).toBe(false);
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(mgr._connectCooldown.get(acct.id).until).toBeLessThan(Date.now() + AUTH_FAILURE_COOLDOWN_MS);
    expect(rows.get(acct.id).oauth_reconnect_required).toBe(false);
  });
});

describe('IMAP AUTHENTICATE failure on an OAuth account', () => {
  const validAccount = () => gmailAccount({ oauth_access_token: 'rejected-at', oauth_token_expiry: inMinutes(40) });

  it('forces exactly one refresh and retries the login once with the new token', async () => {
    const acct = validAccount();
    rows.set(acct.id, acct);
    scriptConnects(gmailXoauthFailure, () => new Error('connect stopped by test'));

    await newManager().connectAccount(acct);

    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(tokensUsed()).toEqual(['rejected-at', `fresh-${acct.id}`]);
  });

  it('falls back to the 30-minute auth cooldown when the refreshed token is rejected too', async () => {
    const acct = validAccount();
    rows.set(acct.id, acct);
    scriptConnects(gmailXoauthFailure);
    const mgr = newManager();
    const before = Date.now();

    expect(await mgr.connectAccount(acct)).toBe(false);

    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(ImapFlow).toHaveBeenCalledTimes(2);
    expect(mgr._connectCooldown.get(acct.id).until).toBeGreaterThanOrEqual(before + AUTH_FAILURE_COOLDOWN_MS);
    expect(mgr._connectCooldown.get(acct.id).until).not.toBe(Infinity);
    expect(syncErrorWrites(acct.id)).toEqual(['[AUTHENTICATIONFAILED] Invalid credentials (Failure) (oauth status 400)']);
  });

  it('applies reconnect-required when the forced refresh reports a revoked grant', async () => {
    const acct = validAccount();
    rows.set(acct.id, acct);
    scriptConnects(gmailXoauthFailure);
    refreshGoogleToken.mockRejectedValue(invalidGrant());
    const mgr = newManager();

    await mgr.connectAccount(acct);

    expect(ImapFlow).toHaveBeenCalledTimes(1);
    expect(syncErrorWrites(acct.id)).toEqual(['oauth_reconnect_required']);
    expect(mgr._connectCooldown.get(acct.id).until).toBe(Infinity);
  });

  it('retries the same way on the interval reconnect path', async () => {
    const acct = validAccount();
    rows.set(acct.id, acct);
    scriptConnects(gmailXoauthFailure, () => new Error('connect stopped by test'));

    await newManager()._syncTick(acct);

    expect(refreshGoogleToken).toHaveBeenCalledTimes(1);
    expect(tokensUsed()).toEqual(['rejected-at', `fresh-${acct.id}`]);
  });

  it('does not refresh on a login-stage connection limit', async () => {
    const acct = validAccount();
    rows.set(acct.id, acct);
    scriptConnects(loginLimitRefusal);

    await newManager().connectAccount(acct);

    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for a password account', async () => {
    const acct = { ...validAccount(), oauth_provider: null, imap_host: 'imap.example.com', auth_pass: 'pw' };
    rows.set(acct.id, acct);
    scriptConnects(gmailXoauthFailure);

    await newManager().connectAccount(acct);

    expect(refreshGoogleToken).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledTimes(1);
  });
});
