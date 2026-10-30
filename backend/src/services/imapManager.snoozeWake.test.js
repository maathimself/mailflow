// Waking snoozed mail (#269) when what the waker read has gone out of date: the sweep reads every
// due snooze first and wakes them one by one, and the reader can unsnooze one by hand, or give it
// a later time, in between.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../utils/mailUtils.js', async (importOriginal) => ({ ...(await importOriginal()), adjustFolderCounts: vi.fn() }));

import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { ImapManager, evictPool } from './imapManager.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { query } from './db.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';

const HOUR = 3_600_000;
const ACCOUNT = { id: 'acct-1', user_id: 'u1', imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc' };

// The snooze records and the messages they point at, as the database holds them now. Messages
// are a list, since two of them can carry one Message-ID.
let snoozes, messages;
const snooze = (id, { until = -HOUR, uid = 10, isRead = false, mid = `<${id}@x>` } = {}) => {
  snoozes.set(id, { id, user_id: 'u1', account_id: 'acct-1', message_id_header: mid, original_folder: 'INBOX', snoozed_folder: 'Snoozed', snooze_until: Date.now() + until });
  messages.push({ mid, folder: 'Snoozed', uid, is_read: isRead });
};
const messageOf = (sm) => messages.find(m => m.mid === sm.message_id_header && m.folder === sm.snoozed_folder);
const byMid = (mid) => messages.find(m => m.mid === mid);
// What snoozedRows returned for a snooze when it was read: a copy, which later changes miss.
const rowRead = (id, m = messageOf(snoozes.get(id))) => {
  const sm = snoozes.get(id);
  return { snooze_id: id, user_id: sm.user_id, account_id: sm.account_id, message_id_header: sm.message_id_header, original_folder: sm.original_folder, snoozed_folder: sm.snoozed_folder, uid: m.uid, is_read: m.is_read };
};

// Answers the handful of queries a wake makes, from the state above. The message writes match on
// every column their WHERE names, uid included when it does.
const matches = (sql, m, { mid, folder, uid }) => m.mid === mid && m.folder === folder && (!/AND uid = \$\d+$/.test(sql.trim()) || m.uid === uid);
function fakeQuery(sql, params = []) {
  if (sql.includes('FROM snoozed_messages sm')) {
    let live = [...snoozes.values()].filter(sm => messageOf(sm));
    if (sql.includes('sm.id = $1')) live = live.filter(sm => sm.id === params[0]);
    if (sql.includes('sm.snooze_until <= NOW()')) live = live.filter(sm => sm.snooze_until <= Date.now());
    return { rows: live.map(sm => rowRead(sm.id)) };
  }
  if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [ACCOUNT] };
  if (sql.startsWith('UPDATE messages SET folder')) {
    const where = { mid: params[2], folder: sql.includes('uid = $4') ? params[4] : params[3], uid: params[params.length - 1] };
    for (const m of messages.filter(m => matches(sql, m, where))) {
      m.folder = params[0];
      if (sql.includes('uid = $4')) m.uid = params[3];
    }
    return { rows: [] };
  }
  if (sql.startsWith('DELETE FROM messages')) {
    const where = { mid: params[1], folder: params[2], uid: params[3] };
    messages = messages.filter(m => !matches(sql, m, where));
    return { rows: [] };
  }
  if (sql.startsWith('DELETE FROM snoozed_messages WHERE id')) { snoozes.delete(params[0]); return { rows: [] }; }
  return { rows: [] };
}

let mgr;
beforeEach(() => {
  vi.clearAllMocks();
  snoozes = new Map();
  messages = [];
  query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  mgr = new ImapManager(null);
  mgr.broadcast = vi.fn();
  mgr.setFlag = vi.fn(async () => {});
  mgr.moveMessageGetNewUid = vi.fn(async () => 500);
  mgr.syncFolderOnDemand = vi.fn(async () => {});
});

describe('waking a snooze that changed after it was read', () => {
  it('leaves one the reader already brought back by hand', async () => {
    snooze('a');
    const stale = rowRead('a');
    expect(await mgr.wakeSnoozed(rowRead('a'), { markUnread: false })).toBe(true);
    expect(await mgr.wakeSnoozed(stale, { onlyIfDue: true })).toBe(false);
    expect(mgr.moveMessageGetNewUid).toHaveBeenCalledTimes(1);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(2); // out of Snoozed and into INBOX, once
    expect(mgr.broadcast).toHaveBeenCalledTimes(1);
  });

  it('leaves one given a later time, but brings it back by hand', async () => {
    snooze('a');
    const stale = rowRead('a');
    snoozes.get('a').snooze_until = Date.now() + HOUR;
    expect(await mgr.wakeSnoozed(stale, { onlyIfDue: true })).toBe(false);
    expect(mgr.moveMessageGetNewUid).not.toHaveBeenCalled();
    expect(await mgr.wakeSnoozed(stale, { markUnread: false })).toBe(true);
    expect(byMid('<a@x>').folder).toBe('INBOX');
  });

  it("moves the message's UID and counts its read state as they are now", async () => {
    snooze('a', { uid: 10, isRead: false });
    const stale = rowRead('a');
    Object.assign(byMid('<a@x>'), { uid: 12, is_read: true });
    expect(await mgr.wakeSnoozed(stale, { onlyIfDue: true })).toBe(true);
    expect(mgr.moveMessageGetNewUid).toHaveBeenCalledWith(ACCOUNT, 12, 'Snoozed', 'INBOX');
    expect(adjustFolderCounts).toHaveBeenCalledWith('acct-1', 'Snoozed', -1, 0); // it was read
  });

  it('tells a wake already under way apart from nothing to wake', async () => {
    snooze('a');
    const read = rowRead('a');
    let finishMove;
    mgr.moveMessageGetNewUid = vi.fn(() => new Promise(resolve => { finishMove = () => resolve(500); }));
    const first = mgr.wakeSnoozed(read);
    await vi.waitFor(() => expect(mgr.moveMessageGetNewUid).toHaveBeenCalled());
    expect(mgr.isWakingSnooze('a')).toBe(true);
    expect(await mgr.wakeSnoozed(read, { markUnread: false })).toBe(null);
    finishMove();
    expect(await first).toBe(true);
    expect(mgr.isWakingSnooze('a')).toBe(false);
    expect(await mgr.wakeSnoozed(read)).toBe(false);
    expect(mgr.moveMessageGetNewUid).toHaveBeenCalledTimes(1);
  });
});

describe('the sweep', () => {
  it('wakes what is due, unread, and skips what the reader unsnoozed while it ran', async () => {
    snooze('a');
    snooze('b', { uid: 11 });
    // The reader brings b back by hand while the sweep is moving a.
    mgr.moveMessageGetNewUid = vi.fn(async (_acct, uid) => {
      if (uid === 10) await mgr.wakeSnoozed(rowRead('b'), { markUnread: false });
      return uid + 100;
    });
    await mgr._runSnoozeWakeup();
    expect(mgr.moveMessageGetNewUid.mock.calls.map(c => c[1])).toEqual([10, 11]); // b once, by hand
    expect(mgr.setFlag).toHaveBeenCalledTimes(1);
    expect(mgr.setFlag).toHaveBeenCalledWith(ACCOUNT, 110, 'INBOX', '\\Seen', false);
    expect(snoozes.size).toBe(0);
    expect(adjustFolderCounts).toHaveBeenCalledTimes(4);
  });
});

// The source uid can belong to another message in the folder it comes back to (#665).
describe('waking a snooze whose move names no new uid', () => {
  it('drops the row and pulls the folder, rather than keep the row on its Snoozed uid', async () => {
    snooze('a');
    mgr.moveMessageGetNewUid = vi.fn(async () => null);
    expect(await mgr.wakeSnoozed(rowRead('a'), { markUnread: false })).toBe(true);
    expect(byMid('<a@x>')).toBeUndefined();
    expect(mgr.syncFolderOnDemand).toHaveBeenCalledWith(ACCOUNT, 'INBOX');
    expect(snoozes.size).toBe(0);
    expect(adjustFolderCounts.mock.calls).toEqual([['acct-1', 'Snoozed', -1, -1]]);
  });
});

// Two messages in Snoozed can carry one Message-ID. The wake writes only the row it moved.
describe('waking one of two messages that share a Message-ID', () => {
  beforeEach(() => {
    snooze('a', { uid: 10, mid: '<dup@x>' });
    messages.push({ mid: '<dup@x>', folder: 'Snoozed', uid: 11, is_read: false });
  });
  const woken = () => rowRead('a', messages.find(m => m.uid === 10));

  it('drops only its own row when the move names no new uid', async () => {
    mgr.moveMessageGetNewUid = vi.fn(async () => null);
    expect(await mgr.wakeSnoozed(woken(), { markUnread: false })).toBe(true);
    expect(messages).toEqual([{ mid: '<dup@x>', folder: 'Snoozed', uid: 11, is_read: false }]);
  });

  it('moves only its own row when the move names the new uid', async () => {
    expect(await mgr.wakeSnoozed(woken(), { markUnread: false })).toBe(true);
    expect(messages).toEqual([
      { mid: '<dup@x>', folder: 'INBOX', uid: 500, is_read: false },
      { mid: '<dup@x>', folder: 'Snoozed', uid: 11, is_read: false },
    ]);
  });
});

// Without a new uid the woken message is marked unread on the server by a Message-ID SEARCH, which
// may find more than one message.
describe('marking a woken message unread without its new uid', () => {
  let found, unflagged;
  beforeEach(() => {
    evictPool(ACCOUNT.id);
    unflagged = [];
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
    resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
    ImapFlow.mockImplementation(function () {
      return Object.assign(new EventEmitter(), {
        capabilities: new Map([['IMAP4rev1', true]]), enabled: new Set(),
        states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 }, state: 2, mailbox: false,
        connect: vi.fn(async () => {}), close: vi.fn(), logout: vi.fn(async () => {}), noop: vi.fn(async () => true),
        async getMailboxLock(path) { this.mailbox = { path, exists: 1 }; return { release() {} }; },
        async search() { return found; },
        async messageFlagsRemove(range) { unflagged.push(range); return true; },
      });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    snooze('a');
    mgr.moveMessageGetNewUid = vi.fn(async () => null);
  });

  it('unflags the one message that carries the Message-ID', async () => {
    found = [7];
    expect(await mgr.wakeSnoozed(rowRead('a'))).toBe(true);
    expect(unflagged).toEqual(['7']);
    evictPool(ACCOUNT.id);
  });

  it('leaves them all alone when more than one carries it', async () => {
    found = [7, 8];
    expect(await mgr.wakeSnoozed(rowRead('a'))).toBe(true);
    expect(unflagged).toEqual([]);
    evictPool(ACCOUNT.id);
  });
});
