import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST /api/gtd/done end-to-end for the archive step's two race/failure contracts (a
// concurrent /done racing the same INBOX row, and an archive move that throws) —
// behaviour the pure resolveDoneFolders tests can't reach. db + imapManager are
// stubbed; mailUtils' side-effecting helpers (archive resolution, count adjust, read fan-out)
// are mocked so the archive DB write's rowCount is the only thing under test. getGtdConfig is
// mocked to a fixed enabled config; requireAuth is a passthrough injecting a session.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    moveMessage: vi.fn(),
    setFlag: vi.fn(),
    removeMessageCopy: vi.fn(),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    broadcast: vi.fn(),
  },
}));
vi.mock('../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveArchiveFolder: vi.fn(),
    isAllMailFolder: vi.fn(),
    adjustFolderCounts: vi.fn(),
    fanOutReadToSiblings: vi.fn(),
  };
});
vi.mock('../services/gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});

import express from 'express';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings } from '../utils/mailUtils.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from '../services/gtdConfig.js';
import gtdRoutes from './gtd.js';

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
function stubQueries({ inbox = inboxCopy, archiveWrite = { rowCount: 1 } } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: [msg] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
    if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: inbox ? [inbox] : [] };
    if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
    if (sql.startsWith('DELETE FROM messages') || sql.startsWith('UPDATE messages SET folder')) return archiveWrite;
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
  query.mockReset();
  Object.values(imapManager).forEach(fn => fn.mockReset());
  [resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings, getGtdConfig].forEach(fn => fn.mockReset());
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  resolveArchiveFolder.mockResolvedValue('Archive');
  isAllMailFolder.mockResolvedValue(false);
  fanOutReadToSiblings.mockResolvedValue(undefined);
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

  it('releases both move guards when the non-UIDPLUS archive write throws', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: [msg] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: [inboxCopy] };
      if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
      if (sql.startsWith('UPDATE messages SET folder')) throw new Error('archive write failed');
      return { rows: [] };
    });
    imapManager.moveMessage.mockResolvedValue(null);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: false, archiveFailed: true });
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCT_ID, 'Archive', inboxCopy.uid);
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCT_ID, 'INBOX', inboxCopy.uid);
  });

  it('full success: archived=true, archiveFailed=false, noArchiveFolder=false', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false, noArchiveFolder: false });
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
