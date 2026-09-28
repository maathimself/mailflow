// A move must never destroy the message it failed to move.
//
// On a server without the MOVE extension (RFC 6851) imapflow emulates MOVE as COPY, then
// \Deleted + EXPUNGE, and it runs the EXPUNGE whether or not the COPY succeeded
// (imapflow lib/commands/move.js). Its COPY reports a server NO by returning false rather
// than throwing, so a COPY the server refuses (destination gone, over quota) still expunges
// the source. MailFlow's `result === false` check runs after that, when the mail is gone.
//
// The fake connection below hands messageMove to imapflow's own move command, so these
// tests exercise the fallback as imapflow ships it rather than a model of it. Everything
// under that command (COPY, EXPUNGE, SEARCH, STATUS) is a small in-memory server that
// outlives any one connection, because withFreshClient evicts a connection whose callback
// threw and the next call builds a new one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import imapflowMove from 'imapflow/lib/commands/move.js';

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

import { ImapManager, evictPool } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const acct = {
  id: 'no-move', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993,
  imap_tls: true, auth_user: 'u', auth_pass: 'enc', enabled: true,
};

// An IMAP server. `capabilities` and `enabled` decide whether it has MOVE and UIDPLUS;
// `refuseCopy` makes it answer COPY with NO, as it would for a missing destination or a full
// quota, and `refuseExpunge` and `refuseStatus` do the same for EXPUNGE and STATUS.
function makeServer({ capabilities = ['IMAP4rev1', 'UIDPLUS'], enabled = [], refuseCopy = false, refuseExpunge = false, refuseStatus = false } = {}) {
  return {
    capabilities, enabled, refuseCopy, refuseExpunge, refuseStatus,
    folders: { INBOX: { uids: [4, 5, 6], uidNext: 7 }, Archive: { uids: [], uidNext: 1 } },
    commands: [],
  };
}

// UID set to a list, with RFC 3501 `*` semantics: it is the highest UID in the mailbox, so
// `n:*` past the end still names that message.
function uidSet(range, present) {
  const max = present.length ? Math.max(...present) : 0;
  const out = new Set();
  for (const part of String(range).split(',')) {
    const [a, b = a] = part.split(':').map(v => (v === '*' ? max : Number(v)));
    for (let u = Math.min(a, b); u <= Math.max(a, b); u++) out.add(u);
  }
  return present.filter(u => out.has(u));
}

function connectionTo(server) {
  const client = Object.assign(new EventEmitter(), {
    capabilities: new Map(server.capabilities.map(c => [c, true])),
    enabled: new Set(server.enabled),
    states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 },
    state: 2,
    mailbox: false,
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    logout: vi.fn(async () => {}),

    async getMailboxLock(path) {
      this.mailbox = { path, exists: server.folders[path].uids.length };
      this.state = this.states.SELECTED;
      return { release: () => {} };
    },
    async status(path) {
      if (server.refuseStatus) throw new Error('Command failed');
      return { path, uidNext: server.folders[path].uidNext };
    },
    async search(q) {
      return uidSet(q.uid, server.folders[this.mailbox.path].uids);
    },
    // Without `uid` imapflow sends the range as sequence numbers and would act on whichever
    // message sits at that position, so refuse anything but a UID command.
    async messageCopy(range, destination, options) {
      if (!options?.uid) throw new Error('COPY by sequence number');
      const src = server.folders[this.mailbox.path];
      const uids = uidSet(range, src.uids);
      server.commands.push(['COPY', uids, destination]);
      if (server.refuseCopy) return false; // imapflow copy.js: a NO resolves false
      const dst = server.folders[destination];
      const uidMap = new Map(uids.map(u => [u, dst.uidNext++]));
      dst.uids.push(...uidMap.values());
      const res = { path: this.mailbox.path, destination };
      if (this.capabilities.has('UIDPLUS')) Object.assign(res, { uidValidity: 1n, uidMap });
      return res;
    },
    async messageDelete(range, options) {
      if (!options?.uid) throw new Error('EXPUNGE by sequence number');
      const src = server.folders[this.mailbox.path];
      const uids = uidSet(range, src.uids);
      server.commands.push(['EXPUNGE', uids]);
      if (server.refuseExpunge) return false; // imapflow expunge.js: a NO resolves false
      src.uids = src.uids.filter(u => !uids.includes(u));
      return true;
    },
    // The native branch of imapflow's move command talks to the connection directly.
    async exec(command, attributes) {
      if (command !== 'UID MOVE') throw new Error(`unexpected ${command}`);
      const src = server.folders[this.mailbox.path];
      const dst = server.folders[attributes[1].value];
      const uids = uidSet(attributes[0].value, src.uids);
      server.commands.push(['MOVE', uids]);
      src.uids = src.uids.filter(u => !uids.includes(u));
      uids.forEach(() => dst.uids.push(dst.uidNext++));
      return { next: () => {}, response: { attributes: [] } };
    },
    // imapflow's resolveRange turns MailFlow's array of UID strings into a sequence string
    // before the command runs; do the same, then hand over to imapflow's own MOVE.
    messageMove(range, destination, options) {
      return imapflowMove(this, [].concat(range).join(','), destination, options);
    },
  });
  return client;
}

let server;
let mgr;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  evictPool(acct.id);
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  ImapFlow.mockImplementation(function () { return connectionTo(server); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mgr = new ImapManager(null);
  vi.clearAllTimers(); // the constructor's schedulers are not under test
  mgr.syncFolderOnDemand = vi.fn(async () => {});
});

afterEach(() => {
  evictPool(acct.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('move on a server without MOVE, when the server refuses the COPY', () => {
  beforeEach(() => { server = makeServer({ refuseCopy: true }); });

  it('moveMessage fails and leaves the message in the source folder', async () => {
    await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).rejects.toThrow();
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
    expect(server.commands.filter(([c]) => c === 'EXPUNGE')).toEqual([]);
  });

  it('moveMessageGetNewUid fails and leaves the message in the source folder', async () => {
    await expect(mgr.moveMessageGetNewUid(acct, 5, 'INBOX', 'Archive')).rejects.toThrow();
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
    expect(server.commands.filter(([c]) => c === 'EXPUNGE')).toEqual([]);
  });

  it('bulkMoveMessages reports every UID failed and leaves them all in the source', async () => {
    const r = await mgr.bulkMoveMessages(acct, [4, 5, 6], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([4, 5, 6]);
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
    expect(server.commands.filter(([c]) => c === 'EXPUNGE')).toEqual([]);
  });

  it('bulkMoveMessages does not report the batch moved when the UIDNEXT probe also failed', async () => {
    // With no destination UIDNEXT the reconcile trusts source absence alone, so an
    // expunged-but-never-copied batch reads as a successful move and callers drop the rows.
    server.refuseStatus = true;
    const r = await mgr.bulkMoveMessages(acct, [4, 5, 6], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([]);
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
  });

  it('moveMessage checks the COPY on a server that advertises IMAP4rev2 without enabling it', async () => {
    // imapflow does not count MOVE as present here (a profile with disableIMAP4rev2, or a
    // server that rejected ENABLE IMAP4rev2), so handing this to messageMove would run its
    // unchecked fallback.
    server = makeServer({ capabilities: ['IMAP4rev1', 'IMAP4rev2', 'UIDPLUS'], refuseCopy: true });
    await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).rejects.toThrow();
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
    expect(server.commands.filter(([c]) => c === 'EXPUNGE')).toEqual([]);
  });
});

describe('move on a server without MOVE, when the COPY succeeds but the EXPUNGE is refused', () => {
  beforeEach(() => { server = makeServer({ refuseExpunge: true }); });

  it('moveMessage reports the copy and warns that the message is now in both folders', async () => {
    await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).resolves.toBe(1);
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
    expect(server.folders.Archive.uids).toEqual([1]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('in both folders'));
  });
});

describe('move on a server without MOVE, when the COPY succeeds', () => {
  beforeEach(() => { server = makeServer(); });

  it('moveMessage still moves the message and returns its new UID', async () => {
    await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).resolves.toBe(1);
    expect(server.folders.INBOX.uids).toEqual([4, 6]);
    expect(server.folders.Archive.uids).toEqual([1]);
  });

  it('moveMessageGetNewUid still moves the message and returns its new UID', async () => {
    await expect(mgr.moveMessageGetNewUid(acct, 5, 'INBOX', 'Archive')).resolves.toBe(1);
    expect(server.folders.INBOX.uids).toEqual([4, 6]);
  });

  it('bulkMoveMessages still moves the batch and maps the new UIDs', async () => {
    const r = await mgr.bulkMoveMessages(acct, [4, 5, 6], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([4, 5, 6]);
    expect([...r.uidMap]).toEqual([[4, 1], [5, 2], [6, 3]]);
    expect(server.folders.INBOX.uids).toEqual([]);
  });
});

describe('move on a server with MOVE', () => {
  // IMAP4rev2 includes MOVE (RFC 9051), and imapflow sends MOVE to a rev2 session whose
  // server does not list it separately. The move has to agree, or it would split an atomic
  // MOVE into COPY and EXPUNGE.
  it.each([
    ['advertises MOVE', ['IMAP4rev1', 'UIDPLUS', 'MOVE'], []],
    ['has IMAP4rev2 enabled', ['IMAP4rev1', 'IMAP4rev2'], ['IMAP4REV2']],
    ['speaks only IMAP4rev2', ['IMAP4rev2'], []],
  ])('uses the single atomic MOVE when the server %s', async (_label, capabilities, enabled) => {
    server = makeServer({ capabilities, enabled });
    await mgr.moveMessage(acct, 5, 'INBOX', 'Archive');
    expect(server.commands.map(([c]) => c)).toEqual(['MOVE']);
    expect(server.folders.INBOX.uids).toEqual([4, 6]);
  });
});
