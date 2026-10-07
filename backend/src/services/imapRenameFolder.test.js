// Renaming a folder must not destroy mail in it.
//
// imapflow's RENAME sends CLOSE first when the session has that mailbox selected
// (lib/commands/rename.js), and CLOSE permanently expunges every message flagged \Deleted
// (RFC 3501 6.4.2). Pooled sessions keep whatever mailbox they last selected, so the rename
// often runs on a session that still holds the folder. Messages another client only flagged
// (Thunderbird's "Just mark it as deleted", Roundcube's flag_for_deletion) are ordinary rows
// in MailFlow, and that CLOSE would silently delete them.
//
// The fake connection below hands RENAME and CLOSE to imapflow's own commands, so these tests
// exercise them as imapflow ships them. Everything under those commands is a small in-memory
// server that outlives any one connection.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import imapflowRename from 'imapflow/lib/commands/rename.js';
import imapflowClose from 'imapflow/lib/commands/close.js';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p), headersToRawString: vi.fn(() => 'Subject: hello') }));
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
  id: 'rename-folder', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993,
  imap_tls: true, auth_user: 'u', auth_pass: 'enc', enabled: true,
};

// UIDs 2, 11 and 31 are flagged \Deleted by another client but not expunged. INBOX.Projects is
// how every personal folder is named on a server whose namespace prefix is "INBOX.".
function makeServer() {
  return {
    folders: {
      INBOX: { uids: [1, 2], deleted: new Set([2]) },
      Projects: { uids: [10, 11, 12], deleted: new Set([11]) },
      Archive: { uids: [20], deleted: new Set() },
      'INBOX.Projects': { uids: [30, 31], deleted: new Set([31]) },
    },
    commands: [],
  };
}

function connectionTo(server) {
  return Object.assign(new EventEmitter(), {
    capabilities: new Map([['IMAP4rev1', true], ['UIDPLUS', true]]),
    enabled: new Set(),
    states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 },
    state: 2,
    mailbox: false,
    log: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    logout: vi.fn(async () => {}),
    noop: vi.fn(async () => true),

    // SELECT of another mailbox closes the current one without expunging (RFC 3501 6.4.2).
    // Like imapflow, it sends no SELECT for the mailbox already selected, and a lock that is
    // never released blocks the session's next one.
    locked: false,
    async getMailboxLock(path) {
      if (!server.folders[path]) throw new Error(`no mailbox ${path}`);
      if (this.locked) throw new Error('previous mailbox lock was never released');
      if (this.mailbox?.path !== path) {
        server.commands.push(['SELECT', path]);
        this.mailbox = { path, exists: server.folders[path].uids.length };
        this.state = this.states.SELECTED;
      }
      this.locked = true;
      return { release: () => { this.locked = false; } };
    },
    async *fetch(range) {
      yield { uid: Number(range), headers: Buffer.from('Subject: hello\r\n') };
    },
    // imapflow's ImapFlow.run dispatches to lib/commands; only the two a rename can reach.
    run(command, ...args) {
      if (command === 'RENAME') return imapflowRename(this, ...args);
      if (command === 'CLOSE') return imapflowClose(this);
      throw new Error(`unexpected run ${command}`);
    },
    mailboxRename(path, newPath) {
      return this.run('RENAME', path, newPath);
    },
    async exec(command, attributes) {
      if (command === 'CLOSE') {
        const f = server.folders[this.mailbox.path];
        server.commands.push(['CLOSE', this.mailbox.path]);
        f.uids = f.uids.filter(u => !f.deleted.has(u));
        f.deleted.clear();
        return { next: () => {} };
      }
      if (command === 'RENAME') {
        const [from, to] = attributes.map(a => a.value);
        server.commands.push(['RENAME', from, to]);
        server.folders[to] = server.folders[from];
        delete server.folders[from];
        return { next: () => {} };
      }
      throw new Error(`unexpected ${command}`);
    },
  });
}

const sent = (name) => server.commands.filter(([c]) => c === name);

let server;
let mgr;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  evictPool(acct.id);
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  query.mockResolvedValue({ rows: [] });
  server = makeServer();
  ImapFlow.mockImplementation(function () { return connectionTo(server); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mgr = new ImapManager(null);
  vi.clearAllTimers(); // the constructor's schedulers are not under test
});

afterEach(() => {
  evictPool(acct.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('renameFolder', () => {
  it('keeps mail another client flagged when a pooled session still has the folder selected', async () => {
    // Reading a message leaves its folder selected on the pooled session that did it.
    await mgr.fetchHeaders(acct, 10, 'Projects');
    await mgr.renameFolder(acct, 'Projects', 'Projects 2024');

    expect(ImapFlow).toHaveBeenCalledTimes(1); // the rename ran on that same session
    expect(sent('CLOSE')).toEqual([]);
    expect(sent('RENAME')).toEqual([['RENAME', 'Projects', 'Projects 2024']]);
    expect(server.folders.Projects).toBeUndefined();
    expect(server.folders['Projects 2024'].uids).toEqual([10, 11, 12]);
    expect([...server.folders['Projects 2024'].deleted]).toEqual([11]);

    // The session goes back to the pool usable: the guard's lock was released.
    await mgr.fetchHeaders(acct, 10, 'Projects 2024');
    expect(ImapFlow).toHaveBeenCalledTimes(1);
  });

  it('renames without an extra SELECT when the session holds another folder', async () => {
    await mgr.fetchHeaders(acct, 20, 'Archive');
    const selectsBefore = sent('SELECT').length;
    await mgr.renameFolder(acct, 'Projects', 'Projects 2024');

    expect(sent('SELECT').length).toBe(selectsBefore);
    expect(sent('CLOSE')).toEqual([]);
    expect(server.folders['Projects 2024'].uids).toEqual([10, 11, 12]);
  });

  it('still renames a folder whose path only starts with INBOX', async () => {
    await mgr.fetchHeaders(acct, 30, 'INBOX.Projects');
    await mgr.renameFolder(acct, 'INBOX.Projects', 'INBOX.Projects 2024');

    expect(sent('CLOSE')).toEqual([]);
    expect(server.folders['INBOX.Projects 2024'].uids).toEqual([30, 31]);
    expect([...server.folders['INBOX.Projects 2024'].deleted]).toEqual([31]);
  });

  it.each(['INBOX', 'inbox'])('refuses to rename %s, which it could not deselect first', async (inbox) => {
    await mgr.fetchHeaders(acct, 1, 'INBOX');
    await expect(mgr.renameFolder(acct, inbox, 'Old mail')).rejects.toThrow(/INBOX/);

    expect(sent('CLOSE')).toEqual([]);
    expect(sent('RENAME')).toEqual([]);
    expect(server.folders.INBOX.uids).toEqual([1, 2]);
    expect([...server.folders.INBOX.deleted]).toEqual([2]);
  });
});
