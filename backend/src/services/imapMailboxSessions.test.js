// Outlook.com caps concurrent IMAP sessions per mailbox. Past the cap a login succeeds and the
// next command answers "User is authenticated but not connected.", while sessions already open
// keep working. An Outlook.com mailbox was seen refusing every second session while MailFlow
// held only its IDLE one, so no uncached message could be opened.
//
// These pin the per-mailbox session cap (counted by construction: ImapFlow is mocked, so one
// call is one login), the refusal text arming the backoff, and which session serves a click.

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

import { ImapManager, connectImapClient, otherSessionLimit, providerProfile, isConnectionRefusal, acquirePooledClient, releasePooledClient, evictPool } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const OUTLOOK_TEXT = 'User is authenticated but not connected.';
const resolved = { host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null };
const cfg = { policy: { allowPrivateHosts: true, allowInsecureTls: true } };
let seq = 0;
const mailbox = (imap_host) => ({
  id: `acct-mbx-${++seq}`, user_id: 'u1', imap_host, imap_port: 993, imap_tls: true,
  email_address: 'me@example.test', auth_user: 'me', auth_pass: 'enc',
});
const outlook = () => mailbox('outlook.office365.com');
const flush = () => new Promise(r => setImmediate(r));

// One message, text/plain, served by every session. close() emits 'close' as imapflow does.
let connectImpl;
function fakeClient(path = null) {
  const client = new EventEmitter();
  client.usable = true;
  client.mailbox = path ? { path, exists: 1 } : false;
  client.locks = [];
  client.connect = vi.fn(() => connectImpl());
  client.logout = vi.fn(() => Promise.resolve());
  client.noop = vi.fn(() => Promise.resolve());
  client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
  client.getMailboxLock = vi.fn(async (p) => {
    client.locks.push(p);
    client.mailbox = { path: p, exists: 1 };
    return { release() {} };
  });
  client.fetch = vi.fn(async function* (range, query) {
    yield {
      uid: 42,
      bodyStructure: query.bodyStructure ? { type: 'text/plain', part: '1', encoding: '7bit', parameters: { charset: 'utf-8' }, size: 5 } : undefined,
      bodyParts: query.bodyParts ? new Map(query.bodyParts.filter(p => p === '1').map(p => [p, Buffer.from('hello')])) : undefined,
    };
  });
  return client;
}

const opened = [];
beforeEach(() => {
  vi.clearAllMocks();
  opened.length = 0;
  connectImpl = () => Promise.resolve();
  ImapFlow.mockImplementation(function () { const c = fakeClient(); opened.push(c); return c; });
  getConnectionPolicy.mockResolvedValue(cfg.policy);
  resolveForConnection.mockResolvedValue(resolved);
  query.mockResolvedValue({ rows: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('per-mailbox session cap', () => {
  it('gives Outlook three sessions: IDLE, one pooled, one for everything else', () => {
    const profile = providerProfile({ imap_host: 'outlook.office365.com' });
    expect(profile.maxSessions).toBe(3);
    expect(profile.poolSize).toBe(1);
    expect(otherSessionLimit(profile)).toBe(1);
    // Every other provider stays uncapped.
    for (const host of ['imap.gmail.com', 'imap.mail.yahoo.com', 'imap.purelymail.com', 'imap.zoho.com', 'imap.example.com']) {
      expect(otherSessionLimit(providerProfile({ imap_host: host }))).toBe(Infinity);
    }
  });

  it('queues a second background login until the first session closes', async () => {
    const account = outlook();
    const first = await connectImapClient(account, resolved, cfg, 30000, 'Backfill connect');
    const second = connectImapClient(account, resolved, cfg, 30000, 'Snippet indexer connect');
    await flush();
    expect(ImapFlow).toHaveBeenCalledTimes(1);

    // The IDLE session and the pool have their own share and do not wait.
    await connectImapClient(account, resolved, cfg, 30000, 'IMAP connect', { session: 'persistent' });
    await connectImapClient(account, resolved, cfg, 30000, 'IMAP pool connect', { session: 'pool' });
    expect(ImapFlow).toHaveBeenCalledTimes(3);

    first.close();
    (await second).close();
    expect(ImapFlow).toHaveBeenCalledTimes(4);
  });

  it('lets a login a user is waiting on go ahead of queued background work', async () => {
    const account = outlook();
    const holder = await connectImapClient(account, resolved, cfg, 30000, 'Backfill connect');
    const order = [];
    const background = connectImapClient(account, resolved, cfg, 30000, 'Flag-sync connect').then(c => { order.push('background'); return c; });
    await flush();
    const user = connectImapClient(account, resolved, cfg, 30000, 'IMAP fresh-login connect', { session: 'user' }).then(c => { order.push('user'); return c; });
    await flush();

    holder.close();
    (await user).close();
    (await background).close();
    expect(order).toEqual(['user', 'background']);
  });

  it("queues a background body retry's login behind a user's", async () => {
    const mgr = new ImapManager({ clients: new Set() });
    const account = outlook();
    evictPool(account.id);
    const holder = await connectImapClient(account, resolved, cfg, 1000, 'test');
    const order = [];
    const user = connectImapClient(account, resolved, cfg, 1000, 'test', { session: 'user' })
      .then(c => { order.push('user'); return c; });
    // The prefetch's pooled session finds nothing, so it retries on a fresh login.
    ImapFlow.mockImplementationOnce(function () {
      const c = fakeClient();
      c.fetch = vi.fn(async function* () {});
      opened.push(c);
      return c;
    });
    const prefetch = mgr.fetchMessageBody(account, 42, 'INBOX', { background: true })
      .then(b => { order.push('prefetch'); return b; });
    for (let i = 0; i < 20; i++) await flush();
    holder.close();
    (await user).close();
    expect((await prefetch).text).toBe('hello');
    expect(order).toEqual(['user', 'prefetch']);
    evictPool(account.id);
  });

  it('frees the slot of a login that failed', async () => {
    const account = outlook();
    connectImpl = () => Promise.reject(Object.assign(new Error('Command failed'), { responseText: OUTLOOK_TEXT }));
    await expect(connectImapClient(account, resolved, cfg, 30000, 'Backfill connect')).rejects.toThrow();
    connectImpl = () => Promise.resolve();
    const next = await connectImapClient(account, resolved, cfg, 30000, 'Backfill connect');
    expect(next).toBeTruthy();
    next.close();
  });

  it('counts each mailbox on its own, and leaves uncapped providers alone', async () => {
    const a = outlook();
    const b = outlook();
    const held = [await connectImapClient(a, resolved, cfg, 30000, 'Backfill connect'), await connectImapClient(b, resolved, cfg, 30000, 'Backfill connect')];
    const gmail = mailbox('imap.gmail.com');
    for (let i = 0; i < 4; i++) held.push(await connectImapClient(gmail, resolved, cfg, 30000, 'Backfill connect'));
    expect(ImapFlow).toHaveBeenCalledTimes(6);
    for (const c of held) c.close();
  });
});

describe("Outlook's session refusal", () => {
  it('reads as a refusal, in both shapes imapflow reports it', () => {
    expect(isConnectionRefusal(OUTLOOK_TEXT)).toBe(true);
    expect(isConnectionRefusal(`Authentication failed: ${OUTLOOK_TEXT}`)).toBe(true);
  });

  it('stops the bulk flag refresh at the first refused login', async () => {
    const mgr = new ImapManager({ clients: new Set() });
    const account = outlook();
    query.mockImplementation(async (sql) => ({
      rows: /is_bulk IS NULL/.test(sql)
        ? [{ id: 'm1', uid: 1, folder: 'INBOX' }, { id: 'm2', uid: 2, folder: 'Archive' }, { id: 'm3', uid: 3, folder: 'Sent' }]
        : [account],
    }));
    connectImpl = () => Promise.reject(Object.assign(new Error('Command failed'), { responseText: OUTLOOK_TEXT }));
    await mgr.refreshBulkFlags(account);
    expect(ImapFlow).toHaveBeenCalledTimes(1);
    expect(mgr._secondaryConnectBlocked(account.id)).toBeTruthy();
  });

  it('backs a refused reconnect off instead of retrying it every health check', async () => {
    const mgr = new ImapManager({ clients: new Set() });
    const account = outlook();
    connectImpl = () => Promise.reject(Object.assign(new Error('Command failed'), { responseText: OUTLOOK_TEXT }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await mgr.connectAccount(account)).toBe(false);
    expect(mgr._connectCooldown.get(account.id)?.until).toBeGreaterThan(Date.now());
    // The next health check finds it cooling down and opens nothing.
    const logins = ImapFlow.mock.calls.length;
    expect(await mgr.connectAccount(account)).toBe(false);
    expect(ImapFlow.mock.calls.length).toBe(logins);
  });
});

describe('which session serves an opened message', () => {
  let mgr;
  let idle;
  function withIdleSession(account) {
    mgr = new ImapManager({ clients: new Set() });
    idle = fakeClient('INBOX');
    mgr.connections.set(account.id, idle);
    evictPool(account.id);
    return account;
  }
  afterEach(() => { if (mgr) for (const id of mgr.connections.keys()) evictPool(id); });

  it('reads it over the IDLE session on a capped mailbox, with no login', async () => {
    const account = withIdleSession(outlook());
    const body = await mgr.fetchMessageBody(account, 42, 'INBOX');
    expect(body.text).toBe('hello');
    expect(idle.fetch).toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('selects INBOX again after reading another folder over the IDLE session', async () => {
    const account = withIdleSession(outlook());
    const exists = [];
    idle.on('exists', e => exists.push(e));
    await mgr.fetchMessageBody(account, 42, 'Archive');
    await flush();
    expect(idle.locks).toEqual(['Archive', 'INBOX']);
    expect(idle.mailbox.path).toBe('INBOX');
    expect(exists).toEqual([]); // nothing new arrived
  });

  // imapflow leaves no mailbox selected after a failed SELECT, and does not IDLE without one.
  it('selects INBOX again when the other folder could not be selected', async () => {
    const account = withIdleSession(outlook());
    idle.getMailboxLock.mockImplementationOnce(async (p) => {
      idle.locks.push(p);
      idle.mailbox = false;
      throw new Error('Mailbox does not exist');
    });
    await mgr.fetchMessageBody(account, 42, 'Archive').catch(() => {});
    await flush();
    expect(idle.locks.slice(0, 2)).toEqual(['Archive', 'INBOX']);
    expect(idle.mailbox.path).toBe('INBOX');
  });

  // The SELECT reply carries the new count and imapflow raises no 'exists' for it.
  it('reports mail that reached INBOX while another folder was selected', async () => {
    const account = withIdleSession(outlook());
    idle.getMailboxLock.mockImplementation(async (p) => {
      idle.locks.push(p);
      idle.mailbox = { path: p, exists: p === 'INBOX' ? 2 : 7 };
      return { release() {} };
    });
    const exists = [];
    idle.on('exists', e => exists.push(e));
    await mgr.fetchMessageBody(account, 42, 'Archive');
    await flush();
    expect(exists).toEqual([{ path: 'INBOX', count: 2, prevCount: 1 }]);
  });

  it('keeps background prefetch off the IDLE session', async () => {
    const account = withIdleSession(outlook());
    await mgr.fetchMessageBody(account, 42, 'INBOX', { background: true });
    expect(idle.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledTimes(1); // the pooled session
  });

  it('uses an idle pooled session when there is one', async () => {
    const account = withIdleSession(outlook());
    releasePooledClient(account, await acquirePooledClient(account));
    const body = await mgr.fetchMessageBody(account, 42, 'INBOX');
    expect(body.text).toBe('hello');
    expect(idle.fetch).not.toHaveBeenCalled();
    expect(opened[0].fetch).toHaveBeenCalled();
  });

  it('reads it over the IDLE session when the pool login is refused (any provider)', async () => {
    const account = withIdleSession(mailbox('imap.example.com'));
    connectImpl = () => Promise.reject(Object.assign(new Error('Command failed'), { responseText: OUTLOOK_TEXT }));
    const body = await mgr.fetchMessageBody(account, 42, 'INBOX');
    expect(body.text).toBe('hello');
    expect(idle.fetch).toHaveBeenCalled();
    expect(mgr._secondaryConnectBlocked(account.id)).toBeTruthy();
    // While the backoff holds, the next click goes straight there: no login at all.
    const logins = ImapFlow.mock.calls.length;
    expect((await mgr.fetchMessageBody(account, 42, 'INBOX')).text).toBe('hello');
    expect(ImapFlow.mock.calls.length).toBe(logins);
  });

  it('leaves an uncapped provider on the pool while nothing refuses it', async () => {
    const account = withIdleSession(mailbox('imap.gmail.com'));
    await mgr.fetchMessageBody(account, 42, 'INBOX');
    expect(idle.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledTimes(1);
  });

  it('still fails fast and typed while refused when there is no IDLE session', async () => {
    mgr = new ImapManager({ clients: new Set() });
    const account = outlook();
    mgr._secondaryCooldown.set(account.id, { until: Date.now() + 30000, failures: 1 });
    await expect(mgr.fetchMessageBody(account, 42, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
    expect(ImapFlow).not.toHaveBeenCalled();
  });
});
