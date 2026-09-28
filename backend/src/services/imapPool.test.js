// How many IMAP connections does one account open when the pool is stalled?
//
// #474 reports the sequence: body FETCHes time out, and afterwards every other IMAP
// operation on that backend starts failing with "Command failed" — on Gmail accounts as
// well as the Yahoo one, so it is not provider-specific.
//
// The mechanism was in acquirePooledClient. The pool holds POOL_SIZE connections, and a
// caller that found them all busy used to give up waiting after 10 seconds and open a
// connection of its own. Nothing bounded how many callers did that at once, so two
// stalled body fetches were enough to turn every queued operation (mark-read, bulk-read,
// the folder status cycle, pool pre-warm) into its own login.
//
// It now queues instead, which is what Thunderbird, Evolution and offlineimap all do.
// These tests pin the ceiling: no amount of queued work may add a connection.
//
// Connections are counted by construction: ImapFlow is mocked, so one call is one socket.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { acquirePooledClient, releasePooledClient, evictPool, POOL_SIZE, ACQUIRE_TIMEOUT_MS, POOL_REFRESH_TIMEOUT_MS } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const ACCOUNT = {
  id: 'acct-474',
  imap_host: '127.0.0.1',
  imap_port: 1143,
  imap_tls: true,
  imap_skip_tls_verify: false,
  auth_user: 'user',
  auth_pass: 'enc',
};


beforeEach(() => {
  vi.clearAllMocks();
  evictPool(ACCOUNT.id);
  vi.useFakeTimers();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  ImapFlow.mockImplementation(function () {
    const client = new EventEmitter();
    client.connect = vi.fn(() => Promise.resolve());
    client.logout = vi.fn(() => Promise.resolve());
    client.close = vi.fn();
    return client;
  });
});

afterEach(() => {
  evictPool(ACCOUNT.id);
  vi.useRealTimers();
});

describe('connection fan-out when the pool is stalled (#474)', () => {
  it('serves queued work from the pool instead of opening a connection each', async () => {
    // Fill the pool: POOL_SIZE slow body fetches that hold their connections.
    const stalled = [];
    for (let i = 0; i < POOL_SIZE; i++) stalled.push(await acquirePooledClient(ACCOUNT));
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    // Meanwhile the ordinary work of an open mailbox wants connections: marking messages
    // read, a bulk-read, a folder status cycle over several folders, pool pre-warm.
    const WAITING_OPERATIONS = 8;
    const queued = Array.from({ length: WAITING_OPERATIONS }, () => acquirePooledClient(ACCOUNT));
    // Settled up front: these promises are rejected while timers advance, and a rejection
    // with no handler yet attached is reported as an unhandled rejection by the runner.
    const settled = Promise.allSettled(queued);

    // Past the old 10s overflow, where each of these used to open its own login.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    // They are queued, not failed, and a released connection is handed to the next one.
    releasePooledClient(ACCOUNT, stalled[0]);
    const served = await queued[0];
    expect(served).toBe(stalled[0]);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    releasePooledClient(ACCOUNT, served);
    for (let i = 1; i < stalled.length; i++) releasePooledClient(ACCOUNT, stalled[i]);
    await vi.advanceTimersByTimeAsync(1);
    // Drain whatever is still queued so the test leaves no pending timers.
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    await settled;
  });

  it('holds the ceiling no matter how much work piles up', async () => {
    // The count must track the limit, not demand. A folder status cycle alone queues one
    // per folder, which is what made this a storm rather than a slowdown.
    const stalled = [];
    for (let i = 0; i < POOL_SIZE; i++) stalled.push(await acquirePooledClient(ACCOUNT));

    const queued = Array.from({ length: 25 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(queued);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    // Past the acquire timeout they fail, rather than silently opening sockets. Failing
    // the operation is the honest outcome when an account is genuinely saturated.
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS);
    const results = await settled;
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(results[0].reason.poolExhausted).toBe(true);
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    for (const c of stalled) releasePooledClient(ACCOUNT, c);
  });

  it('never exceeds the ceiling when several callers ask at once', async () => {
    // The grow path checks pool.clients.length, then awaits a token refresh, a host resolve
    // and a connect, and only then pushes. Callers that arrive together all pass the check
    // before any of them has pushed, so the pool can open more than POOL_SIZE sockets. The
    // ceiling is the safety property #474 introduced, so it has to hold under concurrency.
    const asks = Array.from({ length: POOL_SIZE * 3 }, () => acquirePooledClient(ACCOUNT));
    const settled = Promise.allSettled(asks);
    // Let the reservations and connects resolve, then let the surplus give up.
    await vi.advanceTimersByTimeAsync(ACQUIRE_TIMEOUT_MS + 1000);
    const results = await settled;

    expect(ImapFlow.mock.calls.length).toBeLessThanOrEqual(POOL_SIZE);
    // And the ceiling is a real ceiling, not a stall: POOL_SIZE callers were served.
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(POOL_SIZE);
    for (const r of results) if (r.status === 'fulfilled') releasePooledClient(ACCOUNT, r.value);
  });

  it('a failed connect does not leave a reservation that shrinks the pool forever', async () => {
    // The ceiling is enforced by reserving a slot before the awaits. If a reservation
    // outlived a failed connect, every failure would permanently cost the account one
    // connection until restart, and enough failures would wedge the pool at zero.
    ImapFlow.mockImplementationOnce(function () {
      const c = new EventEmitter();
      c.connect = vi.fn(() => Promise.reject(new Error('refused')));
      c.logout = vi.fn(() => Promise.resolve());
      c.close = vi.fn();
      return c;
    });
    await expect(acquirePooledClient(ACCOUNT)).rejects.toThrow();

    // The pool must still be able to open its full complement afterwards.
    const got = [];
    for (let i = 0; i < POOL_SIZE; i++) got.push(await acquirePooledClient(ACCOUNT));
    expect(got).toHaveLength(POOL_SIZE);
    for (const c of got) releasePooledClient(ACCOUNT, c);
  });

  it('releasing a stalled connection lets a waiter reuse it rather than open one', async () => {
    // The control case: when the pool is not stalled the design works, so the fix must
    // preserve this. A released slot is handed straight to a waiter.
    const held = [];
    for (let i = 0; i < POOL_SIZE; i++) held.push(await acquirePooledClient(ACCOUNT));
    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);

    const queued = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    const reused = await queued;

    expect(ImapFlow).toHaveBeenCalledTimes(POOL_SIZE);
    expect(reused).toBe(held[0]);

    for (let i = 1; i < held.length; i++) releasePooledClient(ACCOUNT, held[i]);
    releasePooledClient(ACCOUNT, reused);
  });
});

// A reused session keeps the view of its selected mailbox that it had when released, and
// Yahoo does not catch that view up until the client sends a command that lets it: STATUS
// of the selected mailbox returned SELECT-time counts, and a UID STORE naming mail delivered
// since answered OK and changed nothing. The pool NOOPs a reused session before handing it
// out, and a session that cannot answer is closed rather than handed out or pooled again.
describe('refreshing a reused pooled session', () => {
  // Makes an acquired client look like a real ImapFlow session with INBOX selected.
  const selectInbox = (client, noop = vi.fn(async () => true)) => {
    client.mailbox = { path: 'INBOX', exists: 17 };
    client.noop = noop;
    return client;
  };

  it('NOOPs a reused session with a mailbox selected before handing it out', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT));
    releasePooledClient(ACCOUNT, first);

    const again = await acquirePooledClient(ACCOUNT);

    expect(again).toBe(first);
    expect(first.noop).toHaveBeenCalledTimes(1);
    expect(ImapFlow).toHaveBeenCalledTimes(1);   // reuse, not a new login
    releasePooledClient(ACCOUNT, again);
  });

  it('sends nothing for a reused session with no mailbox selected', async () => {
    const first = await acquirePooledClient(ACCOUNT);
    first.mailbox = false;
    first.noop = vi.fn(async () => true);
    releasePooledClient(ACCOUNT, first);

    await acquirePooledClient(ACCOUNT);

    expect(first.noop).not.toHaveBeenCalled();
  });

  it('closes a session whose NOOP fails instead of handing it out, and the next caller gets a new one', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT), vi.fn(async () => false));
    releasePooledClient(ACCOUNT, first);

    await expect(acquirePooledClient(ACCOUNT)).rejects.toThrow(/NOOP/);
    expect(first.close).toHaveBeenCalled();

    const next = await acquirePooledClient(ACCOUNT);
    expect(next).not.toBe(first);
    expect(ImapFlow).toHaveBeenCalledTimes(2);
    releasePooledClient(ACCOUNT, next);
  });

  it('closes a session whose NOOP hangs, since that command is still in flight', async () => {
    const first = selectInbox(await acquirePooledClient(ACCOUNT), vi.fn(() => new Promise(() => {})));
    releasePooledClient(ACCOUNT, first);

    const attempt = acquirePooledClient(ACCOUNT);
    const settled = expect(attempt).rejects.toThrow(/refresh/i);
    await vi.advanceTimersByTimeAsync(POOL_REFRESH_TIMEOUT_MS + 10);
    await settled;
    expect(first.close).toHaveBeenCalled();
  });

  it('also refreshes a session handed to a queued caller', async () => {
    const held = [];
    for (let i = 0; i < POOL_SIZE; i++) held.push(await acquirePooledClient(ACCOUNT));
    selectInbox(held[0]);

    const queued = acquirePooledClient(ACCOUNT);
    releasePooledClient(ACCOUNT, held[0]);
    const got = await queued;

    expect(got).toBe(held[0]);
    expect(held[0].noop).toHaveBeenCalledTimes(1);
    for (const c of [got, ...held.slice(1)]) releasePooledClient(ACCOUNT, c);
  });
});
