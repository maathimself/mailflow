// Mark all read writes \Seen to the server after answering. A failed write used to be the end of
// it: the DB said read, the server unread, and the next integrity pass took the folder back to
// unread. It is retried now, and the integrity pass keeps out until the last attempt is over.
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

import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { ImapManager, evictPool } from './imapManager.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { query } from './db.js';

const ACCOUNT = { id: 'acct-1', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };

describe('markAllReadImap', () => {
  let mgr, markingDuring;
  beforeEach(() => {
    evictPool(ACCOUNT.id);
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        capabilities: new Map([['IMAP4rev1', true]]), enabled: new Set(),
        states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 }, state: 2, mailbox: false,
        connect: vi.fn(async () => {}), close: vi.fn(), logout: vi.fn(async () => {}), noop: vi.fn(async () => true),
        async getMailboxLock(path) { this.mailbox = { path, exists: 3 }; return { release() {} }; },
      });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mgr = new ImapManager();
    mgr._markAllReadRetryMs = [1, 1];
    markingDuring = [];
  });
  afterEach(() => { evictPool(ACCOUNT.id); vi.restoreAllMocks(); });

  it('tries the \\Seen write again after it fails, and the folder stays marked while it does', async () => {
    let calls = 0;
    mgr._markSeenInFolder = vi.fn(async () => {
      markingDuring.push(mgr._markingAllRead.has(`${ACCOUNT.id}\nINBOX`));
      calls += 1;
      if (calls < 3) throw new Error('NO [THROTTLED] try again later');
      return 3;
    });
    await mgr.markAllReadImap(ACCOUNT, 'INBOX');
    expect(mgr._markSeenInFolder).toHaveBeenCalledTimes(3);
    expect(markingDuring).toEqual([true, true, true]);
    expect(mgr._markingAllRead.has(`${ACCOUNT.id}\nINBOX`)).toBe(false);
  });

  it('gives up after the last retry and lets the integrity pass reconcile', async () => {
    mgr._markSeenInFolder = vi.fn(async () => { throw new Error('NO [UNAVAILABLE]'); });
    await expect(mgr.markAllReadImap(ACCOUNT, 'INBOX')).rejects.toThrow('UNAVAILABLE');
    expect(mgr._markSeenInFolder).toHaveBeenCalledTimes(3);
    expect(mgr._markingAllRead.has(`${ACCOUNT.id}\nINBOX`)).toBe(false);
  });

  it('writes once when the first attempt works', async () => {
    mgr._markSeenInFolder = vi.fn(async () => 3);
    await mgr.markAllReadImap(ACCOUNT, 'INBOX');
    expect(mgr._markSeenInFolder).toHaveBeenCalledTimes(1);
  });

  // A retry comes up to 35 s after the click. It used to search UNSEEN afresh and mark whatever it
  // found: mail that had arrived since, and a message the user had marked unread meanwhile.
  it('writes only up to the uid the click covered, and leaves rows unread in the DB alone', async () => {
    query.mockResolvedValue({ rows: [{ uid: 2 }] });
    mgr._markSeenInFolder = vi.fn(async () => 1);
    await mgr.markAllReadImap(ACCOUNT, 'INBOX', { uidCeiling: 3 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('is_read = false'), [ACCOUNT.id, 'INBOX']);
    expect(mgr._markSeenInFolder).toHaveBeenCalledWith(expect.anything(), 'INBOX', { uidCeiling: 3, skipUids: new Set([2]) });
  });
});

describe('_markSeenInFolder', () => {
  it('searches unread mail up to the ceiling and skips the given uids', async () => {
    const stored = [];
    const client = {
      search: vi.fn(async () => [1, 2, 3]),
      messageFlagsAdd: vi.fn(async (range) => { stored.push(range); return true; }),
    };
    const mgr = new ImapManager();
    expect(await mgr._markSeenInFolder(client, 'INBOX', { uidCeiling: 3, skipUids: new Set([2]) })).toBe(2);
    expect(client.search).toHaveBeenCalledWith({ seen: false, uid: '1:3' }, { uid: true });
    expect(stored).toEqual(['1,3']);
  });

  it('searches every unread message without a ceiling', async () => {
    const client = { search: vi.fn(async () => []), messageFlagsAdd: vi.fn() };
    await new ImapManager()._markSeenInFolder(client, 'INBOX');
    expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
  });
});
