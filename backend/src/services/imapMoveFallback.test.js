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
vi.mock('./messageParser.js', () => ({ MAX_HEADER_FIELD: 500, parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
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
// `flagged` pre-marks UIDs \Deleted, as another client leaves them; `refuseStore` and
// `refuseUnflag` make the server answer a +\Deleted or -\Deleted STORE with NO.
function makeServer({ capabilities = ['IMAP4rev1', 'UIDPLUS'], enabled = [], refuseCopy = false, refuseExpunge = false, refuseStatus = false, flagged = [], refuseStore = false, refuseUnflag = false } = {}) {
  return {
    capabilities, enabled, refuseCopy, refuseExpunge, refuseStatus, refuseStore, refuseUnflag,
    folders: {
      INBOX: { uids: [4, 5, 6], uidNext: 7, deleted: new Set(flagged) },
      Archive: { uids: [], uidNext: 1, deleted: new Set() },
      Trash: { uids: [7, 8], uidNext: 9, deleted: new Set() },
    },
    // What each folder's messages are, by uid; a message moves or copies with its content.
    // Mail without an entry here is given one named after its folder and uid (contentOf).
    content: new Map(),
    // Runs once, just before the next MOVE or COPY reaches the server: whatever else lands in
    // the destination meanwhile.
    beforeMove: null,
    commands: [],
  };
}

function contentOf(server, folder, uid) {
  const key = `${folder}:${uid}`;
  if (!server.content.has(key)) server.content.set(key, { messageId: `<${folder.toLowerCase()}-${uid}@example.com>`, subject: `${folder} ${uid}` });
  return server.content.get(key);
}

// Files a message into a folder under its next uid, as delivery or another client would.
function deliver(server, folder, content) {
  const f = server.folders[folder];
  const uid = f.uidNext++;
  f.uids.push(uid);
  server.content.set(`${folder}:${uid}`, content);
  return uid;
}

function carry(server, from, to, uidMap) {
  for (const [src, dst] of uidMap) server.content.set(`${to}:${dst}`, contentOf(server, from, src));
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
    // As imapflow's close(): the socket goes, and 'close' tells the pool.
    close: vi.fn(function () { this.emit('close'); }),
    logout: vi.fn(async () => {}),
    // A pooled session with a mailbox selected is refreshed with NOOP before its next use.
    noop: vi.fn(async () => true),

    async getMailboxLock(path) {
      this.mailbox = { path, exists: server.folders[path].uids.length };
      this.state = this.states.SELECTED;
      return { release: () => {} };
    },
    async status(path) {
      if (server.refuseStatus) throw new Error('Command failed');
      return { path, uidNext: server.folders[path].uidNext };
    },
    // The envelope and size a FETCH reports, from the message's content.
    async *fetch(range, query, options) {
      if (!options?.uid) throw new Error('FETCH by sequence number');
      const path = this.mailbox.path;
      // `failFetchIn` makes a FETCH in that folder break off, as a stalled session's would.
      if (server.failFetchIn === path) throw new Error('Connection not available');
      for (const uid of uidSet(range, server.folders[path].uids)) {
        const c = contentOf(server, path, uid);
        yield {
          uid,
          size: c.size ?? 100,
          envelope: { messageId: c.messageId, subject: c.subject, from: [{ address: c.from ?? 'sender@example.com' }], date: new Date('2026-10-01T10:00:00Z') },
        };
      }
    },
    async search(q) {
      const f = server.folders[this.mailbox.path];
      // A folder's `searchResult` stands in for imapflow's answers that are not a list:
      // undefined when no mailbox is selected, false when the SEARCH fails.
      if ('searchResult' in f) return f.searchResult;
      if (q.deleted) return f.uids.filter(u => f.deleted.has(u));
      return uidSet(q.uid, f.uids);
    },
    // imapflow's store.js: a NO resolves false rather than throwing.
    async messageFlagsAdd(range, flags, options) {
      if (!options?.uid) throw new Error('STORE by sequence number');
      const f = server.folders[this.mailbox.path];
      if (flags.includes('\\Deleted') && server.refuseStore) return false;
      uidSet(range, f.uids).forEach(u => f.deleted.add(u));
      return true;
    },
    async messageFlagsRemove(range, flags, options) {
      if (!options?.uid) throw new Error('STORE by sequence number');
      const f = server.folders[this.mailbox.path];
      if (server.refuseUnflag) return false;
      uidSet(range, f.uids).forEach(u => f.deleted.delete(u));
      return true;
    },
    // Without `uid` imapflow sends the range as sequence numbers and would act on whichever
    // message sits at that position, so refuse anything but a UID command.
    async messageCopy(range, destination, options) {
      if (!options?.uid) throw new Error('COPY by sequence number');
      const src = server.folders[this.mailbox.path];
      const uids = uidSet(range, src.uids);
      server.commands.push(['COPY', uids, destination]);
      if (server.refuseCopy) return false; // imapflow copy.js: a NO resolves false
      if (server.beforeMove) { const run = server.beforeMove; server.beforeMove = null; run(); }
      const dst = server.folders[destination];
      const uidMap = new Map(uids.map(u => [u, dst.uidNext++]));
      dst.uids.push(...uidMap.values());
      carry(server, this.mailbox.path, destination, uidMap);
      const res = { path: this.mailbox.path, destination };
      if (this.capabilities.has('UIDPLUS')) Object.assign(res, { uidValidity: 1n, uidMap });
      return res;
    },
    // As imapflow's expunge.js ships: flag the range \Deleted without checking the STORE, then
    // UID EXPUNGE the range with UIDPLUS, or a plain EXPUNGE of everything flagged without it.
    async messageDelete(range, options) {
      if (!options?.uid) throw new Error('EXPUNGE by sequence number');
      const src = server.folders[this.mailbox.path];
      await this.messageFlagsAdd(range, ['\\Deleted'], options);
      const scope = this.capabilities.has('UIDPLUS') ? uidSet(range, src.uids) : src.uids;
      const uids = scope.filter(u => src.deleted.has(u));
      server.commands.push(['EXPUNGE', uids]);
      if (server.refuseExpunge) return false; // imapflow expunge.js: a NO resolves false
      src.uids = src.uids.filter(u => !uids.includes(u));
      uids.forEach(u => src.deleted.delete(u));
      return true;
    },
    // The native branch of imapflow's move command talks to the connection directly.
    async exec(command, attributes) {
      if (command !== 'UID MOVE') throw new Error(`unexpected ${command}`);
      const src = server.folders[this.mailbox.path];
      const dst = server.folders[attributes[1].value];
      const uids = uidSet(attributes[0].value, src.uids);
      server.commands.push(['MOVE', uids]);
      if (server.beforeMove) { const run = server.beforeMove; server.beforeMove = null; run(); }
      src.uids = src.uids.filter(u => !uids.includes(u));
      const uidMap = new Map(uids.map(u => [u, dst.uidNext++]));
      dst.uids.push(...uidMap.values());
      carry(server, this.mailbox.path, attributes[1].value, uidMap);
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

// Without UIDPLUS, EXPUNGE is mailbox-wide: it takes every message flagged \Deleted, including
// ones another client flagged and left for the user to undelete. Moves and deletes must remove
// only their own UIDs, and must not report a delete the server refused.
describe('expunging on a server without UIDPLUS, when another message is already flagged \\Deleted', () => {
  beforeEach(() => { server = makeServer({ capabilities: ['IMAP4rev1'], flagged: [4] }); });

  it('moveMessage moves its message and leaves the flagged one in place, still flagged', async () => {
    await mgr.moveMessage(acct, 5, 'INBOX', 'Archive');
    expect(server.folders.INBOX.uids).toEqual([4, 6]);
    expect(server.folders.INBOX.deleted.has(4)).toBe(true);
  });

  it('bulkMoveMessages moves its batch and leaves the flagged one in place', async () => {
    await mgr.bulkMoveMessages(acct, [5, 6], 'INBOX', 'Archive');
    expect(server.folders.INBOX.uids).toEqual([4]);
    expect(server.folders.INBOX.deleted.has(4)).toBe(true);
  });

  it('permanentDeleteMessage deletes only its message', async () => {
    await expect(mgr.permanentDeleteMessage(acct, 6, 'INBOX')).resolves.toBe(true);
    expect(server.folders.INBOX.uids).toEqual([4, 5]);
    expect(server.folders.INBOX.deleted.has(4)).toBe(true);
  });

  it('expunges nothing when the other message cannot be unflagged', async () => {
    server.refuseUnflag = true;
    await expect(mgr.permanentDeleteMessage(acct, 6, 'INBOX')).rejects.toThrow();
    const r = await mgr.bulkPermanentDelete(acct, [5, 6], 'INBOX');
    expect(r.succeeded).toEqual([]);
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
    expect(server.commands.filter(([c]) => c === 'EXPUNGE')).toEqual([]);
  });
});

describe('expunging when the server refuses the \\Deleted STORE', () => {
  it.each([['with UIDPLUS', ['IMAP4rev1', 'UIDPLUS']], ['without UIDPLUS', ['IMAP4rev1']]])(
    '%s: a delete reports failure instead of success, and nothing is expunged', async (_l, capabilities) => {
      server = makeServer({ capabilities, refuseStore: true });
      await expect(mgr.permanentDeleteMessage(acct, 6, 'INBOX')).rejects.toThrow();
      expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
      expect(server.commands.filter(([c]) => c === 'EXPUNGE')).toEqual([]);
    });

  it('an emulated move warns that the message is in both folders', async () => {
    server = makeServer({ capabilities: ['IMAP4rev1', 'UIDPLUS'], refuseStore: true });
    await mgr.moveMessage(acct, 5, 'INBOX', 'Archive');
    expect(server.folders.INBOX.uids).toEqual([4, 5, 6]);
    expect(server.folders.Archive.uids).toEqual([1]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('in both folders'));
  });
});

// With no COPYUID to read, bulkMoveMessages works out what moved by searching the destination
// from the UIDNEXT it had before the move. A server without UIDPLUS gets here on every move, and
// one with it when another client already moved or deleted the UIDs (#407: Dovecot answers such a
// MOVE with OK and no COPYUID). A move that fails outright is checked the same way. The search is
// `n:*`, which past the last UID still names the newest message already in the folder.
describe.each([
  ['sends no COPYUID for a MOVE', ['IMAP4rev1', 'MOVE']],
  ['has neither MOVE nor UIDPLUS', ['IMAP4rev1']],
])('move into a folder that already holds mail, on a server that %s', (_label, capabilities) => {
  beforeEach(() => {
    server = makeServer({ capabilities });
    server.folders.Archive = { uids: [1, 2, 3], uidNext: 4, deleted: new Set() };
  });

  it('reports a UID that is no longer in the source as failed, not as moved onto existing mail', async () => {
    const r = await mgr.bulkMoveMessages(acct, [9], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([9]);
    expect([...r.uidMap]).toEqual([]);
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(acct, 'Archive');
  });

  it('still maps a message that really moved to its new UID', async () => {
    const r = await mgr.bulkMoveMessages(acct, [5], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([5]);
    expect([...r.uidMap]).toEqual([[5, 4]]);
  });
});

describe('move into a folder that already holds mail, when the move itself fails', () => {
  beforeEach(() => {
    server = makeServer({ refuseCopy: true });
    server.folders.Archive = { uids: [1, 2, 3], uidNext: 4, deleted: new Set() };
  });

  it('reports a UID that is no longer in the source as failed, not as moved onto existing mail', async () => {
    const r = await mgr.bulkMoveMessages(acct, [9], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([]);
    expect(r.failed).toEqual([9]);
    expect([...r.uidMap]).toEqual([]);
  });
});

describe('move without COPYUID, when the destination SEARCH returns no list', () => {
  beforeEach(() => { server = makeServer({ capabilities: ['IMAP4rev1', 'MOVE'] }); });

  it.each([[false], [undefined]])('leaves the move unverified when it returns %s, instead of reporting it stale', async (result) => {
    server.folders.Archive.searchResult = result;
    const r = await mgr.bulkMoveMessages(acct, [5], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([5]);
    expect(r.failed).toEqual([]);
    expect([...r.uidMap]).toEqual([]);
    expect(mgr.syncFolderOnDemand).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`destination UID SEARCH returned ${result}`));
  });
});

// Without COPYUID the moved message's new uid is found by its content among what reached the
// destination from the UIDNEXT read before the move (#665). The source uid is never a stand-in:
// in the destination it can belong to another message, which later actions on the row would reach.
describe.each([
  ['sends no COPYUID for a MOVE', ['IMAP4rev1', 'MOVE']],
  ['has neither MOVE nor UIDPLUS', ['IMAP4rev1']],
])('the new UID of a message moved on a server that %s', (_label, capabilities) => {
  beforeEach(() => {
    server = makeServer({ capabilities });
    server.folders.Archive = { uids: [1, 2, 3], uidNext: 4, deleted: new Set() };
  });

  it.each([['moveMessage'], ['moveMessageGetNewUid']])('%s returns it', async (fn) => {
    await expect(mgr[fn](acct, 5, 'INBOX', 'Archive')).resolves.toBe(4);
  });

  it('moveMessage returns the uid the message really has when other mail lands in the folder first', async () => {
    server.beforeMove = () => deliver(server, 'Archive', { messageId: '<other@example.com>', subject: 'Other' });
    await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).resolves.toBe(5);
    expect(contentOf(server, 'Archive', 4).messageId).toBe('<other@example.com>');
  });

  it('moveMessage returns null when another arrival carries the same message, rather than pick one', async () => {
    server.beforeMove = () => deliver(server, 'Archive', { ...contentOf(server, 'INBOX', 5) });
    await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).resolves.toBeNull();
  });

  it('moveMessage closes the session when the arrivals cannot be FETCHed, instead of pooling it again', async () => {
    server.failFetchIn = 'Archive';
    await expect(mgr.moveMessage(acct, 5, 'INBOX', 'Archive')).resolves.toBeNull();
    expect(server.folders.INBOX.uids).toEqual([4, 6]);
    const first = ImapFlow.mock.results[0].value;
    expect(first.close).toHaveBeenCalled();
    server.failFetchIn = null;
    await expect(mgr.moveMessage(acct, 6, 'INBOX', 'Archive')).resolves.toBe(5);
    expect(ImapFlow).toHaveBeenCalledTimes(2);
  });

  it('moveMessage returns null for a UID the source no longer holds, never a uid in the destination', async () => {
    server.beforeMove = () => deliver(server, 'Archive', { messageId: '<other@example.com>', subject: 'Other' });
    await expect(mgr.moveMessage(acct, 9, 'INBOX', 'Archive')).resolves.toBeNull();
  });

  // The overlap: the batch has a UID that is no longer in the source, and one other message lands
  // in the destination meanwhile. Counting arrivals, the two cancel out, so the stale UID looked
  // moved and the batch was mapped by order onto the other message.
  it('bulkMoveMessages maps a batch with a stale UID correctly when other mail lands meanwhile', async () => {
    server.beforeMove = () => deliver(server, 'Archive', { messageId: '<other@example.com>', subject: 'Other' });
    const r = await mgr.bulkMoveMessages(acct, [5, 9], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([5]);
    expect(r.failed).toEqual([9]);
    expect([...r.uidMap]).toEqual([[5, 5]]);
    expect(contentOf(server, 'Archive', 5).messageId).toBe('<inbox-5@example.com>');
  });

  it('bulkMoveMessages maps every message of a batch that other mail interleaves with', async () => {
    server.beforeMove = () => deliver(server, 'Archive', { messageId: '<other@example.com>', subject: 'Other' });
    const r = await mgr.bulkMoveMessages(acct, [4, 6], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([4, 6]);
    for (const [src, dst] of r.uidMap) expect(contentOf(server, 'Archive', dst)).toBe(contentOf(server, 'INBOX', src));
    expect(r.uidMap.size).toBe(2);
  });

  it('bulkMoveMessages leaves unmapped two moved messages that cannot be told apart', async () => {
    server.content.set('INBOX:6', { ...contentOf(server, 'INBOX', 5) });
    const r = await mgr.bulkMoveMessages(acct, [4, 5, 6], 'INBOX', 'Archive');
    expect(r.succeeded).toEqual([4, 5, 6]);
    expect([...r.uidMap]).toEqual([[4, 4]]);
  });
});

// Removing a label copy expunges its uid only while the server copy there is still the row's
// message: a row left on a stale uid would otherwise remove another message (#665).
describe('removeMessageCopy', () => {
  const rowAt = {};
  beforeEach(() => {
    server = makeServer({ capabilities: ['IMAP4rev1', 'UIDPLUS', 'MOVE'] });
    for (const k of Object.keys(rowAt)) delete rowAt[k];
    query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [acct] };
      if (sql.startsWith('SELECT message_id, date, subject, from_email FROM messages')) {
        const row = rowAt[`${params[2]}:${params[1]}`];
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('DELETE FROM messages')) {
        const key = `${params[2]}:${params[1]}`;
        const had = rowAt[key];
        delete rowAt[key];
        return { rows: had ? [{ is_read: true }] : [] };
      }
      return { rows: [] };
    });
  });

  it("expunges a copy that is still its row's message", async () => {
    rowAt['Trash:7'] = { message_id: '<trash-7@example.com>' };
    await expect(mgr.removeMessageCopy(acct.id, 7, 'Trash')).resolves.toBe(1);
    expect(server.folders.Trash.uids).toEqual([8]);
  });

  it('leaves the message at a stale uid alone, drops the row and pulls the folder', async () => {
    rowAt['Trash:7'] = { message_id: '<moved-away@example.com>' };
    await expect(mgr.removeMessageCopy(acct.id, 7, 'Trash')).rejects.toMatchObject({ copyChanged: true, message: expect.stringMatching(/holds another message/) });
    expect(server.folders.Trash.uids).toEqual([7, 8]);
    expect(server.commands.filter(([c]) => c === 'EXPUNGE')).toEqual([]);
    expect(rowAt['Trash:7']).toBeUndefined();
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(acct, 'Trash');
  });

  it('expunges nothing for a uid with no row to check it against', async () => {
    await expect(mgr.removeMessageCopy(acct.id, 7, 'Trash')).resolves.toBe(0);
    expect(server.folders.Trash.uids).toEqual([7, 8]);
  });
});
