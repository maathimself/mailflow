// Outlook answers a login it will not serve with "User is authenticated but not connected.",
// while a session already open keeps working. A hotmail.com mailbox was refused that way by
// every front end in one region and served by every one in another, so with only its IDLE
// session working, no uncached message could be opened.
//
// These pin the refusal text arming the backoffs (counted by construction: ImapFlow is mocked,
// so one call is one login), which session serves a click, and IMAP_RESOLVE_VIA.

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

import { ImapManager, isConnectionRefusal, acquirePooledClient, releasePooledClient, evictPool, resolveAccountHost, makeClientCfg } from './imapManager.js';
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
  // The provider has refused a login, so the secondary backoff is armed.
  const refusing = (account) => { mgr._secondaryCooldown.set(account.id, { until: Date.now() + 30000, failures: 1 }); return account; };
  afterEach(() => { if (mgr) for (const id of mgr.connections.keys()) evictPool(id); });

  it('reads it over the IDLE session while the provider refuses logins, with no login', async () => {
    const account = refusing(withIdleSession(outlook()));
    const body = await mgr.fetchMessageBody(account, 42, 'INBOX');
    expect(body.text).toBe('hello');
    expect(idle.fetch).toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('selects INBOX again after reading another folder over the IDLE session', async () => {
    const account = refusing(withIdleSession(outlook()));
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
    const account = refusing(withIdleSession(outlook()));
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
    const account = refusing(withIdleSession(outlook()));
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
    const account = refusing(withIdleSession(outlook()));
    await expect(mgr.fetchMessageBody(account, 42, 'INBOX', { background: true })).rejects.toMatchObject({ providerRefusing: true });
    expect(idle.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('uses an idle pooled session when there is one', async () => {
    const account = withIdleSession(outlook());
    releasePooledClient(account, await acquirePooledClient(account));
    refusing(account);
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

  it('leaves a click on the pool while nothing refuses it', async () => {
    const account = withIdleSession(outlook());
    await mgr.fetchMessageBody(account, 42, 'INBOX');
    expect(idle.fetch).not.toHaveBeenCalled();
    expect(ImapFlow).toHaveBeenCalledTimes(1);
  });

  // A sync tick can hold the IDLE session's mailbox lock. A click given up on must not run later,
  // for nobody, ahead of that sync.
  it('bounds the wait for the IDLE session and never runs a click given up on', async () => {
    vi.useFakeTimers();
    try {
      const account = refusing(withIdleSession(outlook()));
      let grant;
      const release = vi.fn();
      idle.getMailboxLock.mockImplementationOnce((path, opts) => new Promise((resolve) => {
        idle.lockOpts = opts;
        grant = () => resolve({ release });
      }));
      const click = mgr.fetchMessageBody(account, 42, 'Archive').catch(e => e);
      await vi.advanceTimersByTimeAsync(16000);
      expect(await click).toMatchObject({ providerRefusing: true });
      expect(idle.lockOpts.acquireTimeout).toBeLessThan(16000);
      grant(); // the sync tick lets go at last
      await vi.advanceTimersByTimeAsync(0);
      expect(idle.fetch).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers typed when the IDLE session cannot serve a refused click either', async () => {
    const account = refusing(withIdleSession(outlook()));
    idle.getMailboxLock.mockImplementationOnce(async () => { throw new Error('Connection not available'); });
    await expect(mgr.fetchMessageBody(account, 42, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('still fails fast and typed while refused when there is no IDLE session', async () => {
    mgr = new ImapManager({ clients: new Set() });
    const account = outlook();
    mgr._secondaryCooldown.set(account.id, { until: Date.now() + 30000, failures: 1 });
    await expect(mgr.fetchMessageBody(account, 42, 'INBOX')).rejects.toMatchObject({ providerRefusing: true });
    expect(ImapFlow).not.toHaveBeenCalled();
  });
});

// The front ends a Singapore server's DNS returned answered a mailbox's every login with that
// text, while Tokyo ones served it. IMAP_RESOLVE_VIA sends the host to a pool that can serve it.
describe('front ends named by IMAP_RESOLVE_VIA', () => {
  afterEach(() => { delete process.env.IMAP_RESOLVE_VIA; });

  it("connects to the named pool's addresses and still verifies the account's host", async () => {
    process.env.IMAP_RESOLVE_VIA = 'imap.example.com=other.example.com, Outlook.Office365.com = HND-efz.ms-acdc.office.com';
    const lookup = () => {};
    resolveForConnection.mockResolvedValueOnce({ host: '40.99.65.66', servername: 'hnd-efz.ms-acdc.office.com', addresses: ['40.99.65.66'], lookup });
    const account = outlook();
    const { resolved, policy } = await resolveAccountHost(account);
    expect(resolveForConnection).toHaveBeenCalledWith('hnd-efz.ms-acdc.office.com', expect.anything());
    const cfg = makeClientCfg(account, resolved, { policy });
    expect(cfg.host).toBe('outlook.office365.com');
    expect(cfg.tls).toMatchObject({ servername: 'outlook.office365.com', lookup, rejectUnauthorized: true });
  });

  it('leaves every other host on its own DNS', async () => {
    process.env.IMAP_RESOLVE_VIA = 'outlook.office365.com=HND-efz.ms-acdc.office.com';
    await resolveAccountHost(mailbox('imap.gmail.com'));
    expect(resolveForConnection).toHaveBeenCalledWith('imap.gmail.com', expect.anything());
  });
});
