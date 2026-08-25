import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST + DELETE /api/gtd/classify end-to-end — the apply-label (COPY) and remove-label
// contracts the pure classifyTarget test can't reach: ownership scoping, the already-in-folder
// short-circuit, the message-copy resolution (acted row vs. Message-ID sibling), and IMAP-failure
// status mapping. db + imapManager are stubbed; getGtdConfig is mocked to a fixed enabled config
// (so no gtd_enabled query / config cache to manage); requireAuth is a passthrough injecting a
// session. Mirrors gtd.done.test.js's express harness.
vi.mock('../../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('./gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});

import express from 'express';
import { query } from '../../services/db.js';
import { setMailEngine } from '../mailEngine.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from './gtdConfig.js';
import gtdRoutes from './routes.js';

// The label/broadcast capabilities the routes use are bound (via plugin-api) to the platform's
// mail engine. Inject a mock engine instead of the real imapManager; the same object is asserted
// on below (its copyMessage/removeMessageCopy/broadcast are what the label capabilities call).
const imapManager = {
  ensureFolder: vi.fn(),
  copyMessage: vi.fn(),
  removeMessageCopy: vi.fn(),
  broadcast: vi.fn(),
};
setMailEngine(imapManager);

const MSG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// state 'todo' → folder 'Todo' under the defaults. An INBOX-resident message is the common
// case: its folder differs from the label folder, so classify COPIES into 'Todo' and unclassify
// resolves the label copy through the shared RFC Message-ID.
const inboxMsg = {
  id: MSG_ID,
  account_id: ACCT_ID,
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@x>',
  thread_key: 'thread-1',
  is_read: false,
  read_revision: 2,
  star_revision: 0,
  folder_uid_validity: 123,
  folder_observation_generation: 4,
};
const labelCopy = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  account_id: ACCT_ID,
  uid: 42,
  folder: 'Todo',
  read_revision: 2,
  star_revision: 0,
  folder_uid_validity: 456,
  folder_observation_generation: 8,
};
const exactCopy = { ...labelCopy, uid: 77 };
const account = { id: ACCT_ID, user_id: 'u1', folder_mappings: {} };

// Route every query classify issues: the ownership-scoped message load, the account fetch
// (POST copy path), and resolveCopyUid's sibling lookup (DELETE). Each is individually swappable
// so a test can drive the not-owned (msg:null) / no-sibling (sibling:null) branches.
function stubQueries({ msg = inboxMsg, acct = account, sibling = null, exact = exactCopy } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: msg ? [msg] : [] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: acct ? [acct] : [] };
    if (sql.includes('m.uid = $3') && sql.includes('m.message_id = $4')) {
      return { rows: exact ? [exact] : [] };
    }
    if (sql.includes('WHERE m.account_id = $1 AND m.folder = $2 AND m.message_id = $3')) {
      return { rows: sibling ? [sibling] : [] };
    }
    return { rows: [] };
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  return app;
}

const classify = (body) => fetch(`${base}/api/gtd/classify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'classify-1' },
  body: JSON.stringify(body),
});
const unclassify = (body) => fetch(`${base}/api/gtd/classify`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const undoClassify = (body) => fetch(`${base}/api/gtd/classify/undo`, {
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
  getGtdConfig.mockReset();
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  imapManager.copyMessage.mockResolvedValue(77);
  stubQueries();
});

describe('POST /api/gtd/classify — request validation', () => {
  it('rejects a missing messageId/state with 400 before any lookup', async () => {
    const res = await classify({ state: 'todo' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/messageId and state are required/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID messageId with 400 before any lookup', async () => {
    const res = await classify({ messageId: 'not-a-uuid', state: 'todo' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid message id/i);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/classify — apply a GTD label (COPY)', () => {
  it('copies an INBOX message and returns an exact undo token for UIDPLUS', async () => {
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      folder: 'Todo',
      applied: true,
      undoToken: { messageId: MSG_ID, state: 'todo', folder: 'Todo', uid: 77 },
    });
    // Callers own folder existence, so classify ensures then copies — the message stays in INBOX.
    expect(imapManager.ensureFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(imapManager.copyMessage).toHaveBeenCalledWith(
      ACCT_ID, 10, 'INBOX', 'Todo',
      {
        operationKey: 'gtd-classify:u1:classify-1',
        snapshot: {
          id: MSG_ID,
          accountId: ACCT_ID,
          uid: 10,
          folder: 'INBOX',
          uidValidity: '123',
          folderGeneration: '4',
          readRevision: 2,
          starRevision: 0,
        },
      },
    );
  });

  it('succeeds without advertising an unsafe inverse for non-UIDPLUS', async () => {
    imapManager.copyMessage.mockResolvedValueOnce(null);
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: true, undoToken: null,
    });
  });

  it('succeeds without advertising an unverifiable inverse when Message-ID is absent', async () => {
    stubQueries({ msg: { ...inboxMsg, message_id: null } });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: true, undoToken: null,
    });
  });

  it('short-circuits when the message already lives in the state folder (no IMAP work)', async () => {
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo' } });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: false, undoToken: null,
    });
    expect(imapManager.ensureFolder).not.toHaveBeenCalled();
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it('short-circuits when a sibling already carries the state label', async () => {
    stubQueries({ sibling: { uid: 42 } });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: false, undoToken: null,
    });
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it("404s a message the caller doesn't own (the email_accounts join returns nothing)", async () => {
    stubQueries({ msg: null });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
    expect(query.mock.calls[0][0]).toMatch(/m\.is_deleted = false/);
    expect(query.mock.calls[0][0]).toMatch(/m\.metadata_complete = true/);
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it('maps an IMAP copy failure to 500', async () => {
    imapManager.copyMessage.mockRejectedValue(new Error('IMAP COPY failed'));
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed to apply gtd label/i);
  });
});

describe('DELETE /api/gtd/classify — remove a GTD label', () => {
  it('removes the sibling copy in the state folder and returns removed:true', async () => {
    stubQueries({ sibling: labelCopy });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    // resolveCopyUid found the state-folder copy (uid 42) via the shared Message-ID join.
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 42, 'Todo', {
      expectedId: labelCopy.id,
      expectedUidValidity: labelCopy.folder_uid_validity,
      snapshot: {
        id: labelCopy.id,
        accountId: ACCT_ID,
        uid: 42,
        folder: 'Todo',
        uidValidity: '456',
        folderGeneration: '8',
        readRevision: 2,
        starRevision: 0,
      },
    });
  });

  it('returns removed:false when no copy exists in the state folder (nothing to delete)', async () => {
    stubQueries({ sibling: null });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('400s a missing Message-ID ONLY when the acted row is in a different folder than the state folder', async () => {
    stubQueries({ msg: { ...inboxMsg, message_id: null } }); // INBOX ≠ Todo and no Message-ID → sibling unresolvable
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no Message-ID/i);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does NOT require a Message-ID when the acted row already lives in the state folder', async () => {
    // The acted-row case resolves its own uid directly, so a null Message-ID must not 400 here.
    // Pins the recently-narrowed guard (folder !== stateFolder) against a regression back to an
    // unconditional Message-ID requirement.
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo', message_id: null } });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 10, 'Todo', {
      expectedId: MSG_ID,
      expectedUidValidity: inboxMsg.folder_uid_validity,
      snapshot: {
        id: MSG_ID,
        accountId: ACCT_ID,
        uid: 10,
        folder: 'Todo',
        uidValidity: '123',
        folderGeneration: '4',
        readRevision: 2,
        starRevision: 0,
      },
    });
  });

  it("404s a message the caller doesn't own", async () => {
    stubQueries({ msg: null });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(404);
    expect(query.mock.calls[0][0]).toMatch(/m\.is_deleted = false/);
    expect(query.mock.calls[0][0]).toMatch(/m\.metadata_complete = true/);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('maps an IMAP delete failure to 500', async () => {
    stubQueries({ sibling: labelCopy });
    imapManager.removeMessageCopy.mockRejectedValue(new Error('IMAP delete failed'));
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed to remove gtd label/i);
  });
});

describe('POST /api/gtd/classify/undo — remove only the request-owned copy', () => {
  const token = { messageId: MSG_ID, state: 'todo', folder: 'Todo', uid: 77 };

  it('removes the exact copy identified by the classify response', async () => {
    imapManager.removeMessageCopy.mockResolvedValueOnce(1);
    const res = await undoClassify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 77, 'Todo', {
      expectedId: labelCopy.id,
      expectedUidValidity: labelCopy.folder_uid_validity,
      notify: true,
      snapshot: {
        id: labelCopy.id,
        accountId: ACCT_ID,
        uid: 77,
        folder: 'Todo',
        uidValidity: '456',
        folderGeneration: '8',
        readRevision: 2,
        starRevision: 0,
      },
    });
  });

  it('is replay-safe when the exact copy no longer exists', async () => {
    stubQueries({ exact: null });
    const res = await undoClassify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, '77', null])('rejects malformed uid %j before lookup', async (uid) => {
    const res = await undoClassify({ ...token, uid });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a token after the state folder configuration changes', async () => {
    getGtdConfig.mockResolvedValueOnce({
      enabled: true,
      folders: { ...DEFAULT_GTD_FOLDERS, todo: 'Next Actions' },
    });
    const res = await undoClassify(token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/folder changed/i);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('does not remove a UID that belongs to another message', async () => {
    stubQueries({ exact: null });
    const res = await undoClassify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });
});
