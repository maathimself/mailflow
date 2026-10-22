// New mail announced (an untagged EXISTS) while a sync is running for the account. The running
// sync may already have read the mailbox, so the message could wait for the next interval tick,
// a minute away. It is remembered instead, and one more sync runs as soon as that one ends.
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { ImapManager } from './imapManager.js';
import { query } from './db.js';

const acct = { id: 'acct-1', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, enabled: true, protocol: 'imap' };
const tick = () => new Promise(resolve => setImmediate(resolve));

let mgr, client;
beforeEach(() => {
  vi.clearAllMocks();
  mgr = new ImapManager(null);
  mgr.broadcast = vi.fn();
  client = new EventEmitter();
  mgr._attachIdleListeners(client, acct);
});

describe('new mail during a sync', () => {
  it('syncs right away when no sync is running, as before', async () => {
    mgr._syncTick = vi.fn(async () => {});
    client.emit('exists', { count: 5, prevCount: 4 });
    expect(mgr._syncTick).toHaveBeenCalledTimes(1);
  });

  it('is remembered, and synced once the running sync ends', async () => {
    mgr._syncTick = vi.fn(async () => {});
    mgr.syncingAccounts.add(acct.id);
    client.emit('exists', { count: 5, prevCount: 4 });
    client.emit('exists', { count: 6, prevCount: 5 });
    expect(mgr._syncTick).not.toHaveBeenCalled();
    mgr.syncingAccounts.delete(acct.id);
    mgr._syncAgainIfMailArrived(acct);
    mgr._syncAgainIfMailArrived(acct);
    await tick();
    expect(mgr._syncTick).toHaveBeenCalledTimes(1); // two announcements, one more sync
  });

  it('is synced after an interval tick that ends early, and only once', async () => {
    // A tick with no connection, in a refusal cooldown, returns without syncing: the follow-up
    // still runs from its finally, and itself queues nothing more.
    mgr._connectCooldown.set(acct.id, { until: Date.now() + 60_000, failures: 1 });
    const real = mgr._syncTick.bind(mgr);
    mgr._syncTick = vi.fn(real);
    mgr._pendingNewMail.add(acct.id);
    await mgr._syncTick(acct);
    await tick();
    await tick();
    expect(mgr._syncTick).toHaveBeenCalledTimes(2);
    expect(mgr._pendingNewMail.has(acct.id)).toBe(false);
  });

  it('is synced after a manual sync during which it arrived', async () => {
    query.mockResolvedValue({ rows: [acct] });
    mgr.connections.set(acct.id, client);
    mgr.syncMessages = vi.fn(async () => { client.emit('exists', { count: 7, prevCount: 6 }); });
    const followUp = vi.fn(async () => {});
    mgr._syncTick = followUp;
    await mgr.syncNow('u1', acct.id);
    expect(mgr.syncMessages).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled(); // not while the manual sync held the account
    await tick();
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('is forgotten when the account disconnects', async () => {
    mgr._syncTick = vi.fn(async () => {});
    mgr.syncingAccounts.add(acct.id);
    client.emit('exists', { count: 5, prevCount: 4 });
    await mgr.disconnectAccount(acct.id);
    mgr.syncingAccounts.delete(acct.id);
    mgr._syncAgainIfMailArrived(acct);
    await tick();
    expect(mgr._syncTick).not.toHaveBeenCalled();
  });
});
