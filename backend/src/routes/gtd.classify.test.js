import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST + DELETE /api/gtd/classify end-to-end — the apply-label (COPY) and remove-label
// contracts the pure classifyTarget test can't reach: ownership scoping, the already-in-folder
// short-circuit, the message-copy resolution (acted row vs. Message-ID sibling), and IMAP-failure
// status mapping. db + imapManager are stubbed; getGtdConfig is mocked to a fixed enabled config
// (so no gtd_enabled query / config cache to manage); requireAuth is a passthrough injecting a
// session. Mirrors gtd.done.test.js's express harness.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    ensureFolder: vi.fn(),
    copyMessage: vi.fn(),
    removeMessageCopy: vi.fn(),
    broadcast: vi.fn(),
  },
}));
vi.mock('../services/gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});

import express from 'express';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from '../services/gtdConfig.js';
import gtdRoutes from './gtd.js';

const MSG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// state 'todo' → folder 'Todo' under the defaults. An INBOX-resident message is the common
// case: its folder differs from the label folder, so classify COPIES into 'Todo' and unclassify
// resolves the label copy through the shared RFC Message-ID.
const inboxMsg = { id: MSG_ID, account_id: ACCT_ID, uid: 10, folder: 'INBOX', message_id: '<m@x>', is_read: false };
const account = { id: ACCT_ID, user_id: 'u1', folder_mappings: {} };

// Route every query classify issues: the ownership-scoped message load, the account fetch
// (POST copy path), and resolveCopyUid's sibling lookup (DELETE). Each is individually swappable
// so a test can drive the not-owned (msg:null) / no-sibling (sibling:null) branches.
function stubQueries({ msg = inboxMsg, acct = account, sibling = { uid: 42 } } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: msg ? [msg] : [] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: acct ? [acct] : [] };
    if (sql.startsWith('SELECT uid FROM messages')) return { rows: sibling ? [sibling] : [] };
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
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const unclassify = (body) => fetch(`${base}/api/gtd/classify`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
  it('copies an INBOX message into the state folder and echoes { ok, folder }', async () => {
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder: 'Todo' });
    // Callers own folder existence, so classify ensures then copies — the message stays in INBOX.
    expect(imapManager.ensureFolder).toHaveBeenCalledWith(account, 'Todo');
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 10, 'INBOX', 'Todo');
  });

  it('short-circuits when the message already lives in the state folder (no IMAP work)', async () => {
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo' } });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder: 'Todo' });
    expect(imapManager.ensureFolder).not.toHaveBeenCalled();
    expect(imapManager.copyMessage).not.toHaveBeenCalled();
  });

  it("404s a message the caller doesn't own (the email_accounts join returns nothing)", async () => {
    stubQueries({ msg: null });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
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
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    // resolveCopyUid found the state-folder copy (uid 42) via the shared Message-ID join.
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 42, 'Todo');
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
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 10, 'Todo');
  });

  it("404s a message the caller doesn't own", async () => {
    stubQueries({ msg: null });
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(404);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('maps an IMAP delete failure to 500', async () => {
    imapManager.removeMessageCopy.mockRejectedValue(new Error('IMAP delete failed'));
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed to remove gtd label/i);
  });
});
