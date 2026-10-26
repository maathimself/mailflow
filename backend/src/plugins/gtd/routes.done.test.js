import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST /api/gtd/done end-to-end for the archive step's two race/failure contracts (a
// concurrent /done racing the same INBOX row, and an archive move that throws) —
// behaviour the pure resolveDoneFolders tests can't reach. db + imapManager are
// stubbed; mailUtils' side-effecting helpers (archive resolution, count adjust, read fan-out)
// are mocked so the archive DB write's rowCount is the only thing under test. getGtdConfig is
// mocked to a fixed enabled config; requireAuth is a passthrough injecting a session.
vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveArchiveFolder: vi.fn(),
    isAllMailFolder: vi.fn(),
    adjustFolderCounts: vi.fn(),
    fanOutReadToSiblings: vi.fn(),
    resolveAllDraftsPaths: vi.fn(),
    resolveAllTrashPaths: vi.fn(),
    resolveAllSpamPaths: vi.fn(),
  };
});
// markThreadRead runs for real unless a test stubs its result (e.g. a failed DB fan-out).
vi.mock('../../services/labels.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, markThreadRead: vi.fn(actual.markThreadRead) };
});
vi.mock('./gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});

import express from 'express';
import { query } from '../../services/db.js';
import { setMailEngine } from '../mailEngine.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings, resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths } from '../../utils/mailUtils.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from './gtdConfig.js';
import { markThreadRead } from '../../services/labels.js';
const actualLabels = await vi.importActual('../../services/labels.js');
const actualMailUtils = await vi.importActual('../../utils/mailUtils.js');

// The done route's mail actions (label strip, mark-read, archive, broadcast) go through the bound
// plugin-api capabilities; inject a mock engine, asserted on directly below.
const imapManager = {
  moveMessage: vi.fn(),
  setFlag: vi.fn(),
  removeMessageCopy: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
  broadcast: vi.fn(),
  hasMessageCopy: vi.fn(),
  isLabelStore: vi.fn(),
  supportsUidPlus: vi.fn(),
  syncFolderOnDemand: vi.fn(),
};
setMailEngine(imapManager);
import gtdRoutes from './routes.js';

const MSG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// The rail acts on the Watch-folder copy; a distinct INBOX sibling is what the archive step
// moves. is_read true on both keeps the mark-read path off the IMAP setFlag mock.
const msg = { id: MSG_ID, account_id: ACCT_ID, uid: 10, folder: 'Watch', message_id: '<m@x>', is_read: true };
const account = { id: ACCT_ID, user_id: 'u1', folder_mappings: {} };
const inboxCopy = { id: 'ib-1', uid: 77, is_read: true };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  return app;
}

// Route every query /done issues; archiveWrite is the swappable rowCount of the INBOX row's
// archive UPDATE/DELETE — the authority for whether this call or a concurrent /done won the race.
// `copies` is where the message's live copies are, for the only-copy check. A folder whose copy is
// removed or archived drops out of later lookups. A row read by id reflects the read fan-out.
function stubQueries({ row = msg, inbox = inboxCopy, archiveWrite = { rowCount: 1 }, copies = [] } = {}) {
  const cleared = new Set();
  let markedRead = false;
  imapManager.removeMessageCopy.mockImplementation(async (_acct, _uid, folder) => { cleared.add(folder); });
  query.mockImplementation(async (sql, params = []) => {
    if (sql.startsWith('SELECT DISTINCT folder FROM messages')) {
      return { rows: [...copies, ...(inbox ? ['INBOX'] : [])].filter(folder => !cleared.has(folder)).map(folder => ({ folder })) };
    }
    if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) {
      const found = inbox && params[0] === inbox.id ? inbox : row;
      return { rows: [{ ...found, is_read: markedRead || found.is_read }] };
    }
    if (sql.startsWith('UPDATE messages SET is_read')) {
      markedRead = params[0];
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
    if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: inbox ? [inbox] : [] };
    if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
    if (sql.startsWith('DELETE FROM messages') || sql.startsWith('UPDATE messages SET folder')) {
      if (archiveWrite.rowCount > 0) cleared.add(params[params.length - 1]);
      return archiveWrite;
    }
    return { rows: [] };
  });
}

const done = (body) => fetch(`${base}/api/gtd/done`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  markThreadRead.mockReset();
  markThreadRead.mockImplementation(actualLabels.markThreadRead);
  query.mockReset();
  Object.values(imapManager).forEach(fn => fn.mockReset());
  [resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings, getGtdConfig].forEach(fn => fn.mockReset());
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  resolveArchiveFolder.mockResolvedValue('Archive');
  isAllMailFolder.mockResolvedValue(false);
  // The real fan-out, so its UPDATE runs through the query stub (and can fail there).
  fanOutReadToSiblings.mockImplementation(actualMailUtils.fanOutReadToSiblings);
  [resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths].forEach(fn => fn.mockReset());
  resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
  resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
  resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
  // By default the server confirms a surviving copy, and the account is not Gmail.
  imapManager.hasMessageCopy.mockResolvedValue(true);
  imapManager.isLabelStore.mockReturnValue(false);
  imapManager.supportsUidPlus.mockResolvedValue(true);
  imapManager.syncFolderOnDemand.mockResolvedValue(undefined);
});

describe('POST /api/gtd/done — id validation', () => {
  it('rejects a malformed (non-UUID) id with 400 before any lookup', async () => {
    const res = await done({ id: 'not-a-uuid', states: ['watch'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid message id/i);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/done — archive count-adjust race', () => {
  it('archives + adjusts both counts when the INBOX-scoped write applied (rowCount 1)', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88); // UIDPLUS newUid
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    expect(adjustFolderCounts).toHaveBeenCalledTimes(2);
    // The terminal refresh so the rail converges post-done.
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: ACCT_ID }, 'u1');
  });

  it('no count drift, archived=false when a concurrent /done already moved the INBOX row (rowCount 0)', async () => {
    stubQueries({ archiveWrite: { rowCount: 0 } });
    imapManager.moveMessage.mockResolvedValue(null); // silent server-side no-op
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: false });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });
});

// removeMessageCopy refuses a label copy whose uid holds another message on the server (#665).
// Done leaves that one copy, strips the rest and archives, and reports it.
describe('POST /api/gtd/done: a label copy that changed on the server', () => {
  const changedIn = (bad) => {
    const strip = imapManager.removeMessageCopy.getMockImplementation();
    imapManager.removeMessageCopy.mockImplementation(async (acct, uid, folder) => {
      if (folder === bad) throw Object.assign(new Error('holds another message'), { copyChanged: true });
      return strip(acct, uid, folder);
    });
  };

  it('skips that copy, strips the other labels, archives, and reports it', async () => {
    stubQueries({ copies: ['Todo', 'Watch'] });
    changedIn('Todo');
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['todo', 'watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, removed: ['Watch'], changed: ['Todo'], archived: true, threadRemains: true });
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2]).sort()).toEqual(['Todo', 'Watch']);
    expect(imapManager.moveMessage).toHaveBeenCalled();
  });

  it('still answers 500 for any other strip failure', async () => {
    stubQueries();
    imapManager.removeMessageCopy.mockRejectedValue(new Error('connection lost'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(500);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/done — strip-ok + archive-fail', () => {
  it('returns 200 archived=false archiveFailed=true when only the archive step throws', async () => {
    stubQueries();
    imapManager.moveMessage.mockRejectedValue(new Error('IMAP move failed'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true });
    expect(imapManager.removeMessageCopy).toHaveBeenCalled(); // step (b) still ran
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('releases the move guard when the non-UIDPLUS archive write throws', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT DISTINCT folder FROM messages')) return { rows: [{ folder: 'INBOX' }] };
      if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: [msg] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: [inboxCopy] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
      if (sql.startsWith('DELETE FROM messages')) throw new Error('archive write failed');
      return { rows: [] };
    });
    imapManager.moveMessage.mockResolvedValue(null);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true });
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCT_ID, 'INBOX', inboxCopy.uid);
    expect(imapManager._guardMoveUid).not.toHaveBeenCalledWith(ACCT_ID, 'Archive', inboxCopy.uid);
  });

  // The source uid at the destination may belong to another message, or to none and hide the
  // moved one, so the row is dropped and a sync of Archive files the message under its real uid.
  it('drops the row and syncs Archive when the move names no new uid', async () => {
    stubQueries({ archiveWrite: { rowCount: 1, rows: [{ is_read: true }] } });
    imapManager.moveMessage.mockResolvedValue(null);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    const writes = query.mock.calls.map(([sql]) => sql).filter(sql => /^(UPDATE messages SET folder|DELETE FROM messages)/.test(sql));
    expect(writes).toEqual([expect.stringMatching(/^DELETE FROM messages WHERE id = \$1 AND folder = \$2/)]);
    expect(imapManager.syncFolderOnDemand).toHaveBeenCalledWith(account, 'Archive');
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCT_ID, 'INBOX', -1, 0);
    expect(adjustFolderCounts).not.toHaveBeenCalledWith(ACCT_ID, 'Archive', expect.anything(), expect.anything());
  });

  it('full success: archived=true, archiveFailed=false, noArchiveFolder=false', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false, noArchiveFolder: false, threadRemains: false });
    // The terminal refresh so the rail converges post-done.
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: ACCT_ID }, 'u1');
  });

  it('strip failure still 500s — the contract only softens the archive step, not the label strip', async () => {
    stubQueries();
    imapManager.removeMessageCopy.mockRejectedValue(new Error('IMAP delete failed'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(500);
    expect(imapManager.moveMessage).not.toHaveBeenCalled(); // never reached the archive step
  });

  // The INBOX lookup comes before any change, so a failure leaves nothing half done to retry.
  it('stops with 500 before stripping anything when the INBOX lookup throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      stubQueries({ row: { ...msg, is_read: false }, inbox: null, copies: ['Watch'] });
      const stubbed = query.getMockImplementation();
      query.mockImplementation(async (sql, params) => {
        if (sql.startsWith('SELECT id, uid, is_read FROM messages')) throw new Error('db down');
        return stubbed(sql, params);
      });
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(res.status).toBe(500);
      expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
      expect(adjustFolderCounts).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('strips the acted folder LAST, so an earlier strip failure leaves the acted row retryable', async () => {
    stubQueries();
    // msg.folder is 'Watch' (the acted head). A merged Waiting done strips watch+delegated;
    // fail the NON-acted folder's removal so the loop throws before reaching the acted copy.
    imapManager.removeMessageCopy.mockImplementation(async (_acct, _uid, folder) => {
      if (folder === 'Delegated') throw new Error('IMAP delete failed');
    });
    const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
    expect(res.status).toBe(500);
    // Acted-folder-last ordering: the non-acted 'Delegated' copy is attempted first…
    expect(imapManager.removeMessageCopy.mock.calls[0][2]).toBe('Delegated');
    // …and since it threw, the acted 'Watch' copy is never removed — the acted DB row stays
    // alive, so a same-id retry still resolves it via loadOwnedMessage (no 404, no orphan).
    const strippedFolders = imapManager.removeMessageCopy.mock.calls.map(c => c[2]);
    expect(strippedFolders).not.toContain('Watch');
    expect(imapManager.moveMessage).not.toHaveBeenCalled(); // never reached the archive step
  });
});

// A GTD folder can hold a message's only copy: mail the user filed there by moving it. Done must
// not delete it; it archives that copy instead.
describe('POST /api/gtd/done — a GTD folder holding the only copy', () => {
  it('archives the acted copy instead of deleting it', async () => {
    stubQueries({ inbox: null, copies: ['Watch'] });
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 10, 'Watch', 'Archive');
  });

  it('still strips its other GTD copies, keeping only the acted one', async () => {
    stubQueries({ inbox: null, copies: ['Watch', 'Delegated'] });
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Delegated']);
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 10, 'Watch', 'Archive');
  });

  it('does not count a copy in Trash, which gets emptied', async () => {
    stubQueries({ inbox: null, copies: ['Watch', 'Trash'] });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 10, 'Watch', 'Archive');
  });

  it('strips as before when another live copy keeps the message', async () => {
    stubQueries({ inbox: null, copies: ['Watch', 'Receipts'] });
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Watch']);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the only copies are ones it would strip and none is the acted copy', async () => {
    stubQueries({ row: { ...msg, folder: 'Trash' }, inbox: null, copies: ['Trash', 'Todo'] });
    const res = await done({ id: MSG_ID, states: ['todo'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ onlyCopy: true });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  // The kept copy is the durable one now; without \Seen the next sync of Archive reads it back
  // as unread.
  it('marks an unread kept copy \\Seen before archiving it', async () => {
    stubQueries({ row: { ...msg, is_read: false }, inbox: null, copies: ['Watch'] });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.setFlag).toHaveBeenCalledWith(expect.anything(), 10, 'Watch', '\\Seen', true);
    expect(imapManager.setFlag.mock.invocationCallOrder[0]).toBeLessThan(imapManager.moveMessage.mock.invocationCallOrder[0]);
  });

  it('still marks the message read when it keeps and archives the acted copy', async () => {
    stubQueries({ row: { ...msg, is_read: false }, inbox: null, copies: ['Watch'] });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(fanOutReadToSiblings).toHaveBeenCalledWith(ACCT_ID, '<m@x>', true);
    expect(fanOutReadToSiblings.mock.invocationCallOrder[0]).toBeLessThan(imapManager.moveMessage.mock.invocationCallOrder[0]);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('says the thread remains when an INBOX copy appears after the only-copy check', async () => {
    stubQueries({ inbox: null, copies: ['Watch'] });
    const stubbed = query.getMockImplementation();
    query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: [inboxCopy] };
      return stubbed(sql, params);
    });
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, threadRemains: true });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 77, 'INBOX', 'Archive');
  });

  it('sends no flag for a kept copy that is already read', async () => {
    stubQueries({ inbox: null, copies: ['Watch'] });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });

  it('still archives when the flag push fails', async () => {
    stubQueries({ row: { ...msg, is_read: false }, inbox: null, copies: ['Watch'] });
    imapManager.setFlag.mockRejectedValue(new Error('STORE failed'));
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ archived: true });
  });

  // A row can outlive its message for a while after another client moves it.
  it('archives instead of stripping when the server does not confirm the other copy', async () => {
    stubQueries({ inbox: null, copies: ['Watch', 'Receipts'] });
    imapManager.hasMessageCopy.mockImplementation(async (_account, _uid, folder) => folder === 'Watch');
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), 10, 'Receipts', '<m@x>');
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 10, 'Watch', 'Archive');
  });

  it('treats a failed confirmation as no copy', async () => {
    stubQueries({ inbox: null, copies: ['Watch', 'Receipts'] });
    imapManager.hasMessageCopy.mockImplementation(async (_account, _uid, folder) => {
      if (folder === 'Watch') return true;
      throw new Error('connection refused');
    });
    imapManager.moveMessage.mockResolvedValue(91);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 10, 'Watch', 'Archive');
  });

  // Gmail: removing a GTD label leaves the message in All Mail, which MailFlow does not sync.
  it('strips as before on Gmail, where the message stays in All Mail', async () => {
    stubQueries({ inbox: null, copies: ['Watch'] });
    imapManager.isLabelStore.mockReturnValue(true);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Watch']);
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(imapManager.hasMessageCopy).not.toHaveBeenCalled();
  });

  it('says the thread remains when the kept copy has no archive folder to go to', async () => {
    stubQueries({ inbox: null, copies: ['Watch'] });
    resolveArchiveFolder.mockResolvedValue(null);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: false, noArchiveFolder: true, threadRemains: true });
  });

  it('says the thread remains when archiving the kept copy fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      stubQueries({ inbox: null, copies: ['Watch'] });
      imapManager.moveMessage.mockRejectedValue(new Error('IMAP move failed'));
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true, threadRemains: true });
      expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  // Done archives the acted message read, so an unread kept copy stays when the read fan-out fails.
  it('leaves an unread kept copy in place when the message cannot be marked read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      stubQueries({ row: { ...msg, is_read: false }, inbox: null, copies: ['Watch'] });
      const stubbed = query.getMockImplementation();
      query.mockImplementation(async (sql, params) => {
        if (sql.startsWith('UPDATE messages SET is_read')) throw new Error('db down');
        return stubbed(sql, params);
      });
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true, threadRemains: true });
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  // The request's own load can be stale by the time of the archive, so the kept copy is read again.
  it('keeps the only copy in place when it reads unread at archive time and the message cannot be marked read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      stubQueries({ inbox: null, copies: ['Watch'] });
      const stubbed = query.getMockImplementation();
      let loads = 0;
      query.mockImplementation(async (sql, params) => {
        if (sql.startsWith('UPDATE messages SET is_read')) throw new Error('db down');
        if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts') && loads++ > 0) {
          return { rows: [{ ...msg, is_read: false }] };
        }
        return stubbed(sql, params);
      });
      imapManager.moveMessage.mockResolvedValue(91);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true, threadRemains: true });
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('still archives a kept copy that is already read when the message cannot be marked read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      stubQueries({ inbox: null, copies: ['Watch'] });
      const stubbed = query.getMockImplementation();
      query.mockImplementation(async (sql, params) => {
        if (sql.startsWith('UPDATE messages SET is_read')) throw new Error('db down');
        return stubbed(sql, params);
      });
      imapManager.moveMessage.mockResolvedValue(91);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true });
      expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 10, 'Watch', 'Archive');
    } finally {
      warn.mockRestore();
    }
  });

  // The cache can still list an INBOX copy another client has moved away; only the server counts.
  it('deletes nothing when the cached INBOX copy is not on the server and nothing else keeps the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      stubQueries({ copies: ['Watch'] });
      imapManager.hasMessageCopy.mockImplementation(async (_acct, _uid, folder) => folder !== 'INBOX');
      imapManager.moveMessage.mockResolvedValue(91);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(res.status).toBe(200);
      expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'INBOX', '<m@x>');
      expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('strips as before once the server confirms the INBOX copy', async () => {
    stubQueries({ copies: ['Watch'] });
    imapManager.moveMessage.mockResolvedValue(91);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, removed: ['Watch'], archived: true, threadRemains: false });
    expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'INBOX', '<m@x>');
    expect(imapManager.removeMessageCopy.mock.calls.map(c => c[2])).toEqual(['Watch']);
  });

  it('keeps the copy where it is when the account has no archive folder', async () => {
    stubQueries({ inbox: null, copies: ['Watch'] });
    resolveArchiveFolder.mockResolvedValue(null);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ archived: false, noArchiveFolder: true });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });
});

// A thread sits in a GTD section while any of its messages has a copy in that state's folder, so
// done must strip every message's copy there, not only the acted one's. Each row is one copy.
describe('POST /api/gtd/done — strips every copy in the thread', () => {
  const A = '<a@x>';
  const B = '<b@x>';
  const C = '<c@x>';
  const row = (uid, folder, messageId, extra = {}) => ({
    id: `row-${uid}`, account_id: ACCT_ID, uid, folder, message_id: messageId, thread_key: 'T', is_read: true, ...extra,
  });

  // `exact` is what removeExactLabelCopy's uid + Message-ID lookup finds; it defaults to `rows`.
  // A removed or archived copy leaves its folder in the cache, so later lookups no longer find it.
  function stubThread(rows, acted, { exact = rows } = {}) {
    const gone = new Set();
    const movedIds = new Set();
    const live = list => list.filter(r => !gone.has(`${r.folder}:${r.uid}`) && !movedIds.has(r.id));
    imapManager.removeMessageCopy.mockImplementation(async (_acct, uid, folder) => { gone.add(`${folder}:${uid}`); });
    query.mockImplementation(async (sql, params = []) => {
      if (sql.startsWith('SELECT uid FROM messages') && params.length === 4) {
        return { rows: live(exact).filter(r => r.folder === params[1] && r.uid === params[2] && r.message_id === params[3]).map(r => ({ uid: r.uid })) };
      }
      if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) {
        if (!rows.includes(acted)) return { rows: [acted] };
        return { rows: live(rows).filter(r => r.id === params[0]).map(r => ({ ...r })) };
      }
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('SELECT DISTINCT folder FROM messages')) {
        return { rows: [...new Set(live(rows).filter(r => r.message_id === params[1]).map(r => r.folder))].map(folder => ({ folder })) };
      }
      if (sql.startsWith('SELECT thread_key, uid, folder, message_id')) {
        // Only the selected columns, so a field the query leaves out is missing here too.
        const columns = sql.match(/^SELECT (.*?)\s+FROM/s)[1].split(',').map(c => c.trim());
        return { rows: rows.filter(r => params[1].includes(r.thread_key)).map(r => Object.fromEntries(columns.map(c => [c, r[c]]))) };
      }
      if (sql.startsWith('SELECT id, uid, is_read FROM messages')) {
        return { rows: live(rows).filter(r => r.folder === params[1] && r.message_id === params[2]).map(r => ({ ...r })) };
      }
      if (sql.startsWith('UPDATE messages SET is_read')) {
        const changed = live(rows).filter(r => r.message_id === params[2] && r.is_read !== params[0]);
        changed.forEach(r => { r.is_read = params[0]; });
        return { rows: changed.map(r => ({ folder: r.folder })) };
      }
      if (sql.startsWith('SELECT uid FROM messages')) {
        return { rows: live(rows).filter(r => r.folder === params[1] && r.message_id === params[2]).map(r => ({ uid: r.uid })) };
      }
      if (sql.startsWith('DELETE FROM messages')) {
        movedIds.add(params[0]);
        return { rowCount: 1, rows: rows.filter(r => r.id === params[0]).map(r => ({ is_read: r.is_read })) };
      }
      if (sql.startsWith('UPDATE messages SET folder')) {
        const movedId = params[params.length - 2];
        movedIds.add(movedId);
        return { rowCount: 1, rows: rows.filter(r => r.id === movedId).map(r => ({ is_read: r.is_read })) };
      }
      return { rows: [] };
    });
  }

  // The read fan-out's UPDATE fails for one message, through the real markThreadRead.
  const rejectFanOutFor = (messageId) => {
    const stubbed = query.getMockImplementation();
    query.mockImplementation(async (sql, params = []) => {
      if (sql.startsWith('UPDATE messages SET is_read') && params[2] === messageId) throw new Error('db down');
      return stubbed(sql, params);
    });
  };

  const removedCopies = () => imapManager.removeMessageCopy.mock.calls.map(c => [c[1], c[2]]);

  it('removes the Watch copy of every message in the thread, the acted copy last', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, removed: ['Watch'], archived: true });
    expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
    expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), 15, 'Receipts', A);
  });

  it('archives instead of deleting another message whose only copy is in the GTD folder', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(removedCopies()).toEqual([[6, 'Watch']]);
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 5, 'Watch', 'Archive');
  });

  // The inbox checkmark acts on one message: in the flat list its thread-mates are rows of their own.
  it('strips only the acted message\'s GTD folders when done from the inbox', async () => {
    const acted = row(77, 'INBOX', B, { id: MSG_ID });
    stubThread([row(5, 'Delegated', A), row(15, 'Receipts', A), row(6, 'Watch', B), acted], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID });
    expect(res.status).toBe(200);
    expect(removedCopies()).toEqual([[6, 'Watch']]);
  });

  it('leaves an unread thread-mate in the Inbox when the checkmark acts on one message', async () => {
    const acted = row(20, 'INBOX', B, { id: MSG_ID });
    stubThread([row(10, 'INBOX', A, { is_read: false }), acted], acted);
    imapManager.moveMessage.mockResolvedValue(99);
    const res = await done({ id: MSG_ID });
    expect(res.status).toBe(200);
    expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([20]);
    expect(imapManager.setFlag).not.toHaveBeenCalledWith(expect.anything(), 10, 'INBOX', '\\Seen', true);
  });

  it('keeps a thread-mate\'s Reference copy when the checkmark acts on another message', async () => {
    const acted = row(20, 'INBOX', B, { id: MSG_ID });
    stubThread([row(30, 'Archive', A), row(31, 'Reference', A), acted], acted);
    imapManager.moveMessage.mockResolvedValue(99);
    const res = await done({ id: MSG_ID });
    expect(res.status).toBe(200);
    expect(removedCopies()).toEqual([]);
  });

  // Another client moved the message from Watch to Delegated; the cache still has the Watch row, the section head.
  it('does not expunge the only real copy when the kept GTD row is gone from the server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([acted, row(9, 'Delegated', B)], acted);
      imapManager.hasMessageCopy.mockImplementation(async (_account, uid, folder) => !(folder === 'Watch' && Number(uid) === 6));
      imapManager.moveMessage.mockResolvedValue(null);
      const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
      expect(res.status).toBe(409);
      expect(removedCopies()).toEqual([]);
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // A failed check is not proof that no other copy exists, so the copy is neither deleted nor
  // archived beside a copy that may still be there.
  it('leaves another message whose surviving copy cannot be confirmed, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
      imapManager.hasMessageCopy.mockImplementation(async (_acct, uid) => {
        if (uid === 15) throw new Error('connection refused');
        return true;
      });
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(res.status).toBe(200);
      expect(removedCopies()).toEqual([[6, 'Watch']]);
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
      expect(warn.mock.calls.flat().join(' ')).toMatch(/Receipts/);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves another message\'s copy alone when the copy itself cannot be verified', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
      imapManager.hasMessageCopy.mockImplementation(async (_acct, uid) => {
        if (uid === 5) throw new Error('connection refused');
        return true;
      });
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(res.status).toBe(200);
      expect(removedCopies()).toEqual([[6, 'Watch']]);
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/Watch/);
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('removes another message\'s copy on Gmail, where the message stays in All Mail', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.isLabelStore.mockReturnValue(true);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
  });
  it('says the thread remains when another message\'s cached copy is not on the server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
      imapManager.hasMessageCopy.mockImplementation(async (_acct, uid) => uid !== 5);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false, threadRemains: true });
      expect(removedCopies()).toEqual([[6, 'Watch']]);
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
    } finally {
      warn.mockRestore();
    }
  });

  it('says the thread remains when another message\'s only copy has no archive folder to go to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), acted, row(77, 'INBOX', B)], acted);
      resolveArchiveFolder.mockResolvedValue(null);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
      expect(removedCopies()).toEqual([[6, 'Watch']]);
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('counts a failed archive of another message toward threadRemains, not archiveFailed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), acted, row(77, 'INBOX', B)], acted);
      imapManager.moveMessage.mockImplementation(async (_acct, uid) => {
        if (uid === 5) throw new Error('IMAP move failed');
        return 88;
      });
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false, threadRemains: true });
      expect(removedCopies()).toEqual([[6, 'Watch']]);
    } finally {
      error.mockRestore();
    }
  });

  it('leaves another message\'s headerless copy in place and says the thread remains', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', null), acted, row(77, 'INBOX', B)], acted);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
      expect(removedCopies()).toEqual([[6, 'Watch']]);
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not remove a Gmail label copy whose uid no longer carries the message\'s Message-ID', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    const rows = [row(5, 'Watch', A), acted, row(77, 'INBOX', B)];
    stubThread(rows, acted, { exact: rows.filter(r => r.uid !== 5) });
    imapManager.isLabelStore.mockReturnValue(true);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
    expect(removedCopies()).toEqual([[6, 'Watch']]);
  });

  it('reports no threadRemains when every copy in the thread is cleared', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, threadRemains: false });
  });

  // An unread reply the user has not opened stays unread, also once archived.
  it('archives another message\'s unread only copy without marking it read', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A, { is_read: false }), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, threadRemains: false });
    expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 5, 'Watch', 'Archive');
    expect(fanOutReadToSiblings.mock.calls.filter(c => c[1] === A)).toEqual([]);
    expect(imapManager.setFlag.mock.calls.filter(c => c[1] === 5)).toEqual([]);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCT_ID, 'Watch', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCT_ID, 'Archive', 1, 1);
  });

  it('deletes another message\'s copy without marking the message read', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A, { is_read: false }), row(15, 'Receipts', A, { is_read: false }), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
    expect(fanOutReadToSiblings.mock.calls.filter(c => c[1] === A)).toEqual([]);
    expect(imapManager.setFlag.mock.calls.filter(c => c[1] === 15)).toEqual([]);
  });

  it('removes another message\'s Gmail label copy without marking the message read', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A, { is_read: false }), acted, row(77, 'INBOX', B)], acted);
    imapManager.isLabelStore.mockReturnValue(true);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(removedCopies()).toContainEqual([5, 'Watch']);
    expect(fanOutReadToSiblings.mock.calls.filter(c => c[1] === A)).toEqual([]);
  });

  it('marks the acted message read before stripping its copies, with no \\Seen for the stripped copy', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID, is_read: false });
    stubThread([acted, row(77, 'INBOX', B, { is_read: false })], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    const fanOutB = fanOutReadToSiblings.mock.calls.findIndex(c => c[1] === B);
    const seenB = imapManager.setFlag.mock.calls.findIndex(c => c[1] === 77);
    expect(imapManager.setFlag.mock.calls[seenB]).toEqual([expect.anything(), 77, 'INBOX', '\\Seen', true]);
    expect(imapManager.setFlag.mock.calls.filter(c => c[2] === 'Watch')).toEqual([]);
    const stripOrder = imapManager.removeMessageCopy.mock.invocationCallOrder[0];
    expect(removedCopies()).toEqual([[6, 'Watch']]);
    for (const order of [fanOutReadToSiblings.mock.invocationCallOrder[fanOutB], imapManager.setFlag.mock.invocationCallOrder[seenB]]) {
      expect(order).toBeLessThan(stripOrder);
    }
  });

  // Done archives the conversation, so another message's INBOX copy leaves the Inbox too.
  it('archives the INBOX copy of every message in the thread', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), row(55, 'INBOX', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    const moves = imapManager.moveMessage.mock.calls.map(c => [c[1], c[2], c[3]]);
    expect(moves).toEqual(expect.arrayContaining([[77, 'INBOX', 'Archive'], [55, 'INBOX', 'Archive']]));
    expect(moves).toHaveLength(2);
    expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
  });

  // Without UIDPLUS a moved row keeps its old uid in Archive, where it can name another message.
  describe('on a server without UIDPLUS', () => {
    beforeEach(() => { imapManager.supportsUidPlus.mockResolvedValue(false); });

    it('moves only the acted message\'s own copy and leaves the other messages\' copies that need a move', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const acted = row(6, 'Watch', B, { id: MSG_ID });
        stubThread([row(5, 'Watch', A), row(55, 'INBOX', C), acted, row(77, 'INBOX', B)], acted);
        imapManager.moveMessage.mockResolvedValue(null);
        const res = await done({ id: MSG_ID, states: ['watch'] });
        expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: true, threadRemains: true });
        expect(imapManager.moveMessage.mock.calls.map(c => [c[1], c[2]])).toEqual([[77, 'INBOX']]);
        expect(removedCopies()).toEqual([[6, 'Watch']]);
      } finally {
        warn.mockRestore();
      }
    });

    it('still deletes another message\'s GTD copy that another copy keeps, before any move', async () => {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
      imapManager.moveMessage.mockResolvedValue(null);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, threadRemains: false });
      expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
      expect(imapManager.removeMessageCopy.mock.invocationCallOrder[0]).toBeLessThan(imapManager.moveMessage.mock.invocationCallOrder[0]);
    });

    it('archives a kept only copy of the acted message', async () => {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([acted, row(5, 'Watch', A), row(15, 'Receipts', A)], acted);
      imapManager.moveMessage.mockResolvedValue(null);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, threadRemains: false });
      expect(imapManager.moveMessage.mock.calls.map(c => [c[1], c[2]])).toEqual([[6, 'Watch']]);
    });

    it('does not move the acted message\'s extra INBOX row', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const acted = row(6, 'Watch', B, { id: MSG_ID });
        stubThread([acted, row(77, 'INBOX', B), row(78, 'INBOX', B)], acted);
        imapManager.moveMessage.mockResolvedValue(null);
        const res = await done({ id: MSG_ID, states: ['watch'] });
        expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: true });
        expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
      } finally {
        warn.mockRestore();
      }
    });

    it('treats a failed capability check like a server without UIDPLUS', async () => {
      // supportsUidPlus answers false when its own check fails; the route never sees a throw.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const acted = row(6, 'Watch', B, { id: MSG_ID });
        stubThread([row(5, 'Watch', A), acted, row(77, 'INBOX', B)], acted);
        imapManager.moveMessage.mockResolvedValue(88);
        const res = await done({ id: MSG_ID, states: ['watch'] });
        expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
        expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // A server can claim UIDPLUS and still answer a move without the new uid.
  it('stops moving other messages\' copies once a move comes back without its new uid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), row(8, 'Watch', C), row(55, 'INBOX', C), acted, row(77, 'INBOX', B)], acted);
      imapManager.hasMessageCopy.mockImplementation(async (_acct, uid, folder) => !(folder === 'INBOX' && Number(uid) === 55));
      imapManager.moveMessage.mockResolvedValue(null);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
      expect(imapManager.moveMessage.mock.calls.map(c => [c[1], c[2]])).toEqual([[5, 'Watch'], [77, 'INBOX']]);
      expect(removedCopies()).toEqual([[6, 'Watch']]);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps archiving the whole conversation on a UIDPLUS server whose moves name the new uid', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), row(8, 'Watch', C), row(55, 'INBOX', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([8, 77, 55]);
    expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
  });

  it('asks nothing about UIDPLUS for the inbox checkmark', async () => {
    const acted = row(77, 'INBOX', B, { id: MSG_ID });
    stubThread([row(55, 'INBOX', A), acted], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID });
    expect(imapManager.supportsUidPlus).not.toHaveBeenCalled();
  });

  it('archives only the acted message\'s INBOX copy when done from the inbox', async () => {
    const acted = row(77, 'INBOX', B, { id: MSG_ID });
    stubThread([row(55, 'INBOX', A), row(6, 'Watch', B), acted], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    expect(imapManager.moveMessage.mock.calls.map(c => [c[1], c[2], c[3]])).toEqual([[77, 'INBOX', 'Archive']]);
  });

  it('archives an unread thread-mate\'s INBOX copy without \\Seen, keeping it unread', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(55, 'INBOX', A, { is_read: false }), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77, 55]);
    expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), 55, 'INBOX', A);
    expect(fanOutReadToSiblings.mock.calls.filter(c => c[1] === A)).toEqual([]);
    expect(imapManager.setFlag.mock.calls.filter(c => c[1] === 55)).toEqual([]);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCT_ID, 'INBOX', -1, -1);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCT_ID, 'Archive', 1, 1);
  });

  it('still marks the acted message read when an unread thread-mate is archived unread', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID, is_read: false });
    stubThread([row(55, 'INBOX', A, { is_read: false }), acted, row(77, 'INBOX', B, { is_read: false })], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(fanOutReadToSiblings).toHaveBeenCalledWith(ACCT_ID, B, true);
    expect(imapManager.setFlag).toHaveBeenCalledWith(expect.anything(), 77, 'INBOX', '\\Seen', true);
    expect(imapManager.setFlag.mock.calls.filter(c => c[1] === 55)).toEqual([]);
    expect(adjustFolderCounts).toHaveBeenCalledWith(ACCT_ID, 'INBOX', -1, 0);
  });

  it('reports archiveFailed when another message\'s INBOX copy fails to archive, still archiving the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(55, 'INBOX', A), acted, row(77, 'INBOX', B)], acted);
      imapManager.moveMessage.mockImplementation(async (_acct, uid) => {
        if (uid === 55) throw new Error('IMAP move failed');
        return 88;
      });
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: true });
      expect(imapManager.moveMessage).toHaveBeenCalledWith(expect.anything(), 77, 'INBOX', 'Archive');
      expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(expect.anything(), 55, 'INBOX');
    } finally {
      error.mockRestore();
    }
  });

  it('leaves another message\'s headerless INBOX copy in place and reports it as still in the Inbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(55, 'INBOX', null), acted, row(77, 'INBOX', B)], acted);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: true });
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves every INBOX copy in place when the account has no archive folder', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(55, 'INBOX', A), acted, row(77, 'INBOX', B)], acted);
    resolveArchiveFolder.mockResolvedValue(null);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: false, noArchiveFolder: true, archiveFailed: false });
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  it('keeps the acted message\'s only copy in place when its read fan-out fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID, is_read: false });
      stubThread([acted], acted);
      rejectFanOutFor(B);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true, threadRemains: true });
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
      expect(removedCopies()).toEqual([]);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  // One message can sit in INBOX twice under the same Message-ID; markThreadRead resolves only one.
  it('archives every INBOX row of the acted message, marking the extra one \\Seen first', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(77, 'INBOX', B), row(78, 'INBOX', B, { is_read: false })], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    const moves = imapManager.moveMessage.mock.calls.map(c => [c[1], c[2]]);
    expect(moves).toEqual(expect.arrayContaining([[77, 'INBOX'], [78, 'INBOX']]));
    expect(moves).toHaveLength(2);
    const seen = imapManager.setFlag.mock.calls.findIndex(c => c[1] === 78);
    expect(imapManager.setFlag.mock.calls[seen]).toEqual([expect.anything(), 78, 'INBOX', '\\Seen', true]);
    const move = imapManager.moveMessage.mock.calls.findIndex(c => c[1] === 78);
    expect(imapManager.setFlag.mock.invocationCallOrder[seen]).toBeLessThan(imapManager.moveMessage.mock.invocationCallOrder[move]);
  });

  it('archives every INBOX row of another message in the thread', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), row(55, 'INBOX', A), row(56, 'INBOX', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    const moves = imapManager.moveMessage.mock.calls.map(c => c[1]);
    expect(moves).toEqual(expect.arrayContaining([55, 56, 77]));
    expect(moves).toHaveLength(3);
    expect(imapManager.setFlag.mock.calls.filter(c => c[1] === 55 || c[1] === 56)).toEqual([]);
  });

  it('reports archived when only another message\'s INBOX copy was archived', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(16, 'Receipts', B), row(55, 'INBOX', A)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([55]);
  });

  // The copy went between the thread query and the strip, so nothing is left behind.
  it('does not report the thread as remaining when another message\'s Gmail copy disappears mid-done', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    const rows = [row(5, 'Watch', A), acted, row(77, 'INBOX', B)];
    stubThread(rows, acted, { exact: rows.filter(r => r.uid !== 5) });
    const stubbed = query.getMockImplementation();
    query.mockImplementation(async (sql, params = []) => {
      if (sql.startsWith('SELECT DISTINCT folder FROM messages') && params[1] === A) return { rows: [] };
      return stubbed(sql, params);
    });
    imapManager.isLabelStore.mockReturnValue(true);
    let checks = 0;
    imapManager.hasMessageCopy.mockImplementation(async (_acct, uid) => uid !== 5 || checks++ === 0);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, threadRemains: false });
    expect(removedCopies()).toEqual([[6, 'Watch']]);
  });

  it('still reports the thread as remaining when the copy it could not remove is still there', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      const rows = [row(5, 'Watch', A), acted, row(77, 'INBOX', B)];
      stubThread(rows, acted, { exact: rows.filter(r => r.uid !== 5) });
      const stubbed = query.getMockImplementation();
      query.mockImplementation(async (sql, params = []) => {
        if (sql.startsWith('SELECT DISTINCT folder FROM messages') && params[1] === A) return { rows: [] };
        return stubbed(sql, params);
      });
      imapManager.isLabelStore.mockReturnValue(true);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
    } finally {
      warn.mockRestore();
    }
  });

  it('confirms another message\'s Gmail label copy on the server before removing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), acted, row(77, 'INBOX', B)], acted);
      imapManager.isLabelStore.mockReturnValue(true);
      imapManager.hasMessageCopy.mockImplementation(async (_acct, uid) => uid !== 5);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
      expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), 5, 'Watch', A);
      expect(removedCopies()).toEqual([[6, 'Watch']]);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves another message\'s copy whose removal throws and finishes the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
      // Other removals still reach the stub, so only the failed copy can keep the thread.
      const track = imapManager.removeMessageCopy.getMockImplementation();
      imapManager.removeMessageCopy.mockImplementation(async (acct, uid, folder) => {
        if (uid === 5) throw new Error('IMAP delete failed');
        return track(acct, uid, folder);
      });
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, removed: ['Watch'], archived: true, threadRemains: true });
      expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77]);
    } finally {
      error.mockRestore();
    }
  });

  it('sends no \\Seen to a duplicate INBOX row that is already read', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(77, 'INBOX', B), row(78, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77, 78]);
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });

  // markThreadRead reports the copies whose \Seen it confirmed; none of them is written again.
  it('sends no second \\Seen to a duplicate INBOX row markThreadRead already wrote', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(77, 'INBOX', B), row(78, 'INBOX', B, { is_read: false })], acted);
    markThreadRead.mockImplementation(async (engine, account, message, options) => {
      const result = await actualLabels.markThreadRead(engine, account, message, options);
      return { ...result, pushedIds: [...(result.pushedIds || []), 'row-78'] };
    });
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77, 78]);
    expect(imapManager.setFlag.mock.calls.filter(c => c[1] === 78)).toEqual([]);
  });

  // Done archives the acted message read, so a row may go only once the message is marked read.
  it('keeps every INBOX row of the acted message when its read fan-out fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([acted, row(77, 'INBOX', B, { is_read: false }), row(78, 'INBOX', B, { is_read: false })], acted);
      rejectFanOutFor(B);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true });
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
      expect(removedCopies()).toEqual([[6, 'Watch']]);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  // Only the \Seen push failed; the DB marked the message read, so its rows may go.
  it('still archives every INBOX row of the acted message when only its \\Seen push fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([acted, row(77, 'INBOX', B, { is_read: false }), row(78, 'INBOX', B, { is_read: false })], acted);
      imapManager.setFlag.mockImplementation(async (_acct, uid) => {
        if (uid === 77) throw new Error('STORE failed');
      });
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77, 78]);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a duplicate INBOX row the server does not confirm', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([acted, row(77, 'INBOX', B), row(78, 'INBOX', B), row(55, 'INBOX', A), row(56, 'INBOX', A)], acted);
      imapManager.hasMessageCopy.mockImplementation(async (_acct, uid) => {
        if (uid === 56) throw new Error('connection refused');
        return uid !== 78;
      });
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: true });
      expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), 78, 'INBOX', B);
      expect(imapManager.hasMessageCopy).toHaveBeenCalledWith(expect.anything(), 56, 'INBOX', A);
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77, 55]);
    } finally {
      warn.mockRestore();
    }
  });

  it('still archives the INBOX copy when marking the acted message read degrades', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([row(55, 'INBOX', A), acted, row(77, 'INBOX', B)], acted);
      markThreadRead.mockImplementation(async (engine, account, message) => {
        if (message.message_id !== B) return actualLabels.markThreadRead(engine, account, message);
        return { inboxCopy: { id: 'row-77', uid: 77, is_read: true }, error: new Error('STORE failed') };
      });
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
      expect(imapManager.moveMessage.mock.calls.map(c => c[1])).toEqual([77, 55]);
    } finally {
      warn.mockRestore();
    }
  });

  // Some senders reuse a Message-ID for different mail, so a second row under it may be another
  // email whose only copy is here. It stays, and the thread is reported as remaining.
  it('leaves a second row with the acted Message-ID in its own GTD folder', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(7, 'Watch', B), row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, removed: ['Watch'], threadRemains: true });
    expect(removedCopies()).toEqual([[6, 'Watch']]);
  });

  it('removes one copy of the acted message in another GTD folder and leaves a second row', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(8, 'Delegated', B), row(9, 'Delegated', B), row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
    expect(await res.json()).toMatchObject({ ok: true, threadRemains: true });
    expect(removedCopies()).toEqual([[8, 'Delegated'], [6, 'Watch']]);
  });

  it('says the thread remains when a duplicate of the acted message cannot be removed', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    const rows = [acted, row(7, 'Watch', B), row(77, 'INBOX', B)];
    stubThread(rows, acted, { exact: rows.filter(r => r.uid !== 7) });
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, threadRemains: true });
    expect(removedCopies()).toEqual([[6, 'Watch']]);
  });

  it('reports no threadRemains once the kept only copy is archived', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, threadRemains: false });
    expect(removedCopies()).toEqual([]);
  });

  // The kept copy is the only one outside the stripped folders, so the duplicate beside it stays.
  it('says the thread remains when a duplicate stays beside the archived kept copy', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(7, 'Watch', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: true, threadRemains: true });
    expect(imapManager.moveMessage.mock.calls.map(c => [c[1], c[2]])).toEqual([[6, 'Watch']]);
    expect(removedCopies()).toEqual([]);
  });

  // Message rows read by id: the acted message's load, then one per copy about to be archived.
  const byIdReads = () => query.mock.calls
    .filter(([sql]) => sql.includes('FROM messages m') && sql.includes('JOIN email_accounts'))
    .map(([, params]) => params[0]);

  // A deleted copy needs no proof that the marking landed; only an archive does.
  it('reads back only the copy it archives, not another message\'s deleted copy', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([row(5, 'Watch', A), row(15, 'Receipts', A), acted, row(77, 'INBOX', B)], acted);
    imapManager.moveMessage.mockResolvedValue(88);
    await done({ id: MSG_ID, states: ['watch'] });
    expect(removedCopies()).toEqual([[5, 'Watch'], [6, 'Watch']]);
    expect(byIdReads()).toEqual([MSG_ID, 'row-77']);
  });

  // The thread's rows can read as read while a same-Message-ID copy filed under another thread does not.
  it('does not archive an INBOX copy that is still unread, whatever the thread\'s rows say', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const acted = row(6, 'Watch', B, { id: MSG_ID });
      stubThread([acted, row(77, 'INBOX', B, { thread_key: 'OTHER', is_read: false })], acted);
      rejectFanOutFor(B);
      imapManager.moveMessage.mockResolvedValue(88);
      const res = await done({ id: MSG_ID, states: ['watch'] });
      expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true });
      expect(imapManager.moveMessage).not.toHaveBeenCalled();
      expect(removedCopies()).toEqual([[6, 'Watch']]);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('reads no copy back when nothing of the acted message is archived', async () => {
    const acted = row(6, 'Watch', B, { id: MSG_ID });
    stubThread([acted, row(16, 'Receipts', B)], acted);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({ ok: true, archived: false });
    expect(byIdReads()).toEqual([MSG_ID]);
  });
});
