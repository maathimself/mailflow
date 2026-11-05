// A hung LOGOUT must never pin a lock.
//
// LOGOUT is a command, so it queues behind whatever wedged the transport and can hang
// indefinitely. _syncTick already learned this and force-closes instead, with a test
// asserting close() and not logout(). Several other teardown paths still `await logout()`
// with the lock release sitting AFTER it, so a wedged connection holds:
//
//   _pollOnlyTick   -> the per-host background semaphore slot AND syncingAccounts
//   snippet indexer -> the same semaphore slot AND snippetIndexerRunning
//   syncNow         -> syncingAccounts and syncStartedAt (cleared in a later finally)
//
// The consequence is an account that stops syncing, or background work that stops running
// for every account on that host, until the process restarts. These tests fail before the
// change and pass after, and they are written against the same hung-logout client the
// existing recovery test uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { ImapManager } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { EventEmitter } from 'node:events';

const acct = {
  id: 'teardown', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993,
  imap_tls: true, auth_user: 'u', auth_pass: 'enc', enabled: true,
};
const HOST = 'imap.example.com';

// The connection every path under test gets: it connects, then never answers LOGOUT.
let lastClient = null;
function installHungImapFlow() {
  ImapFlow.mockImplementation(function () {
    const c = new EventEmitter();
    c.connect = vi.fn(() => Promise.resolve());
    c.logout = vi.fn(() => new Promise(() => {}));   // hangs forever
    c.close = vi.fn();
    c.mailbox = { exists: 0, uidValidity: 1n, highestModseq: 1n };
    c.getMailboxLock = async () => ({ release: vi.fn() });
    c.search = async () => [];
    c.fetch = async function* () { yield null; };
    lastClient = c;
    return c;
  });
}

function manager() {
  const mgr = new ImapManager(null);
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer']) {
    clearInterval(mgr[key]);
  }
  mgr.broadcast = vi.fn();            // no websocket server in a unit test
  mgr.syncFolders = vi.fn().mockResolvedValue({});
  mgr.syncMessages = vi.fn().mockResolvedValue({});
  return mgr;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  lastClient = null;
  installHungImapFlow();
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [acct] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a hung LOGOUT in _pollOnlyTick', () => {
  it('does not hold the per-host background slot or the sync guard', async () => {
    const mgr = manager();
    const tick = mgr._pollOnlyTick(acct);
    await vi.advanceTimersByTimeAsync(120000);
    await tick;

    expect(mgr._bgConnSem.activeCount(HOST)).toBe(0);
    expect(mgr.syncingAccounts.has(acct.id)).toBe(false);
    expect(lastClient.close).toHaveBeenCalled();
    expect(lastClient.logout).not.toHaveBeenCalled();
  });
});

describe('a poll-only tick for an account removed or disabled meanwhile', () => {
  it('disconnects it instead of logging in', async () => {
    const mgr = manager();
    for (const rows of [[], [{ ...acct, enabled: false }]]) {
      query.mockResolvedValue({ rows });
      mgr.syncIntervals.set(acct.id, setInterval(() => {}, 60000));
      lastClient = null;
      await mgr._pollOnlyTick(acct);
      expect(lastClient).toBeNull();
      expect(mgr.syncIntervals.has(acct.id)).toBe(false);
      expect(mgr.syncingAccounts.has(acct.id)).toBe(false);
    }
  });
});

describe('a hung LOGOUT in syncNow', () => {
  it('does not hold the sync guard for the account', async () => {
    const mgr = manager();
    const client = { close: vi.fn(), logout: vi.fn(() => new Promise(() => {})) };
    mgr.connections.set(acct.id, client);
    mgr.syncMessages = vi.fn().mockRejectedValue(new Error('boom'));

    const run = mgr.syncNow(acct.id);
    await vi.advanceTimersByTimeAsync(120000);
    await run;

    expect(mgr.syncingAccounts.has(acct.id)).toBe(false);
    expect(mgr.syncStartedAt.has(acct.id)).toBe(false);
    expect(client.close).toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
  });
});
