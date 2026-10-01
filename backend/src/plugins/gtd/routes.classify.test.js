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
import { runGtdTransitions, invalidateOwnerAddressesCache } from './gtdTransitions.js';

// The label/broadcast capabilities the routes use are bound (via plugin-api) to the platform's
// mail engine. Inject a mock engine instead of the real imapManager; the same object is asserted
// on below (its copyMessage/removeMessageCopy/broadcast are what the label capabilities call).
const imapManager = {
  ensureFolder: vi.fn(),
  copyMessage: vi.fn(),
  hasMessageCopy: vi.fn(),
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
};
const account = { id: ACCT_ID, user_id: 'u1', folder_mappings: {} };

// Route every query classify issues: the ownership-scoped message load, the account fetch
// (POST copy path), and resolveCopyUid's sibling lookup (DELETE). Each is individually swappable
// so a test can drive the not-owned (msg:null) / no-sibling (sibling:null) branches.
function stubQueries({ msg = inboxMsg, acct = account, sibling = null, siblings = {}, folders = [], threadCopies = [], exact = { uid: 77 } } = {}) {
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: msg ? [msg] : [] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: acct ? [acct] : [] };
    if (sql.includes('thread_key = ANY($2::text[])')) return { rows: threadCopies };
    if (sql.startsWith('SELECT DISTINCT folder FROM messages')) return { rows: folders.map(folder => ({ folder })) };
    if (sql.includes('thread_key = $4') || sql.includes('message_id = $4')) return { rows: exact ? [exact] : [] };
    if (sql.startsWith('SELECT uid FROM messages')) return { rows: siblings[params?.[1]] ? [{ uid: siblings[params[1]] }] : sibling ? [sibling] : [] };
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
  imapManager.hasMessageCopy.mockResolvedValue(true);
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
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 10, 'INBOX', 'Todo');
  });

  it('succeeds without advertising an unsafe inverse for non-UIDPLUS', async () => {
    imapManager.copyMessage.mockResolvedValueOnce(null);
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(await res.json()).toEqual({
      ok: true, folder: 'Todo', applied: true, undoToken: null,
    });
  });

  it('keeps the filed-only invoice after a non-UIDPLUS switch and deferred transitions', async () => {
    const sent = { ...inboxMsg, uid: 90, folder: 'Sent', message_id: '<reply@example.test>', from_email: 'owner@example.test', date: '2026-07-02' };
    const invoice = { ...inboxMsg, id: 'invoice', uid: 98, folder: 'Reference', message_id: '<invoice@example.test>', from_email: 'vendor@example.test', date: '2026-07-01' };
    const live = new Map([['Sent:90', sent], ['Reference:98', invoice]]);
    const deferred = [];
    const mgr = {
      ...imapManager,
      hasMessageCopy: async (_account, uid, folder, messageId) => live.get(`${folder}:${uid}`)?.message_id === messageId,
    };
    invalidateOwnerAddressesCache(ACCT_ID);
    query.mockImplementation(async sql => {
      if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: [sent] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('account_aliases')) return { rows: [{ addr: 'owner@example.test' }] };
      if (sql.includes('thread_key = ANY($2::text[])')) return { rows: [...live.values()] };
      return { rows: [] };
    });
    let nextUid = 100;
    imapManager.copyMessage.mockImplementation(async (_accountId, uid, from, to) => {
      const source = live.get(`${from}:${uid}`);
      expect(source).toBeDefined();
      const newUid = nextUid++;
      live.set(`${to}:${newUid}`, { ...source, id: `copy-${newUid}`, uid: newUid, folder: to });
      deferred.push(() => runGtdTransitions(mgr, account, ['thread-1']));
      return null;
    });
    imapManager.removeMessageCopy.mockImplementation(async (_accountId, uid, folder) => {
      live.delete(`${folder}:${uid}`);
    });

    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect((await res.json()).undoToken).toBeNull();
    expect(deferred).toHaveLength(2);
    expect(live.has('Reference:98')).toBe(false);
    for (const transition of deferred) await transition();
    await runGtdTransitions(mgr, account, ['thread-1']); // the next periodic tick

    expect([...live.values()].filter(row => row.folder === 'Todo').map(row => row.message_id)).toEqual(['<invoice@example.test>']);
    expect(live.has('Sent:90')).toBe(true);
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 100, 'Todo');
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

  it('switches Todo to Watch while preserving ordinary labels', async () => {
    stubQueries({ folders: ['INBOX', 'Todo', 'Receipts'], siblings: { Todo: 42 } });
    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder: 'Watch', applied: true, undoToken: null, switched: true, sourceRemoved: false });
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 10, 'INBOX', 'Watch');
    expect(imapManager.removeMessageCopy).toHaveBeenCalledExactlyOnceWith(ACCT_ID, 42, 'Todo');
    expect(imapManager.copyMessage.mock.invocationCallOrder[0]).toBeLessThan(imapManager.removeMessageCopy.mock.invocationCallOrder[0]);
  });

  it('preserves an older invoice whose only copy lives in Reference before switching the conversation', async () => {
    const live = new Map([['INBOX:10', '<m@x>'], ['Reference:98', '<invoice@example.test>']]);
    stubQueries({ threadCopies: [
      { ...inboxMsg },
      { id: 'older', account_id: ACCT_ID, uid: 98, folder: 'Reference', message_id: '<invoice@example.test>' },
    ] });
    let nextUid = 100;
    imapManager.copyMessage.mockImplementation(async (_accountId, uid, from, to) => {
      const identity = live.get(`${from}:${uid}`);
      if (!identity) throw new Error('source gone');
      const newUid = nextUid++;
      live.set(`${to}:${newUid}`, identity);
      return newUid;
    });
    imapManager.removeMessageCopy.mockImplementation(async (_accountId, uid, folder) => {
      const identity = live.get(`${folder}:${uid}`);
      expect([...live].some(([key, value]) => key.startsWith('Todo:') && value === identity)).toBe(true);
      live.delete(`${folder}:${uid}`);
    });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect([...live.values()]).toContain('<invoice@example.test>');
    expect([...live.keys()].some(key => key.startsWith('Reference:'))).toBe(false);
    expect(live.get('INBOX:10')).toBe('<m@x>');
  });

  it('preserves live old copies when earlier non-UIDPLUS COPY acknowledgements copied no stale UID', async () => {
    const live = new Map([['Reference:98', '<m@x>']]);
    stubQueries({ threadCopies: [
      { ...inboxMsg },
      { uid: 42, folder: 'Todo', message_id: '<m@x>' },
      { uid: 98, folder: 'Reference', message_id: '<m@x>' },
    ] });
    let nextUid = 100;
    imapManager.copyMessage.mockImplementation(async (_account, uid, from, to) => {
      const identity = live.get(`${from}:${uid}`);
      if (identity) live.set(`${to}:${nextUid++}`, identity);
      return null; // IMAP may acknowledge COPY of a vanished UID without UIDPLUS.
    });
    imapManager.removeMessageCopy.mockImplementation(async (_account, uid, folder) => {
      live.delete(`${folder}:${uid}`);
    });
    const res = await classify({ messageId: MSG_ID, state: 'watch' });
    expect(res.status).toBe(200);
    expect([...live.values()]).toContain('<m@x>');
    expect([...live.keys()].every(key => key.startsWith('Watch:'))).toBe(true);
  });

  it.each(['source', 'destination'])('preserves a member when the %s cache identity differs from live mail', async (stale) => {
    const live = new Map([
      ['INBOX:10', stale === 'destination' ? '<other-selected@example.test>' : '<m@x>'],
      ['Reference:98', stale === 'source' ? '<invoice@example.test>' : '<m@x>'],
    ]);
    stubQueries({ threadCopies: [inboxMsg, { uid: 98, folder: 'Reference', message_id: '<m@x>' }] });
    let nextUid = 100;
    imapManager.copyMessage.mockImplementation(async (_accountId, uid, from, to) => {
      const actual = live.get(`${from}:${uid}`);
      expect(actual).toBeDefined();
      const newUid = nextUid++;
      live.set(`${to}:${newUid}`, actual);
      return newUid;
    });
    imapManager.hasMessageCopy.mockImplementation(async (_account, uid, folder, messageId) => live.get(`${folder}:${uid}`) === messageId);
    imapManager.removeMessageCopy.mockImplementation(async (_accountId, uid, folder) => {
      live.delete(`${folder}:${uid}`);
    });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(live.get('Todo:101')).toBe(stale === 'source' ? '<invoice@example.test>' : '<m@x>');
    expect(live.has('Reference:98')).toBe(false);
  });

  it('copies every physical source when live identity verification is unavailable', async () => {
    stubQueries({ threadCopies: [inboxMsg, { uid: 98, folder: 'Reference', message_id: '<m@x>' }] });
    imapManager.hasMessageCopy.mockRejectedValue(new Error('verification unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await classify({ messageId: MSG_ID, state: 'todo' });
      expect(res.status).toBe(200);
      expect(imapManager.copyMessage.mock.calls.map(call => call.slice(1))).toEqual([
        [10, 'INBOX', 'Todo'], [98, 'Reference', 'Todo'],
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  it('does not reuse an RFC identity for a headerless member with the same physical key', async () => {
    const msg = { ...inboxMsg, message_id: 'Reference:98' };
    const live = new Map([['INBOX:10', 'selected-email'], ['Reference:98', 'headerless-invoice']]);
    stubQueries({ msg, threadCopies: [
      msg,
      { uid: 98, folder: 'Reference', message_id: null },
    ] });
    let nextUid = 100;
    imapManager.copyMessage.mockImplementation(async (_accountId, uid, from, to) => {
      const content = live.get(`${from}:${uid}`);
      expect(content).toBeDefined();
      const newUid = nextUid++;
      live.set(`${to}:${newUid}`, content);
      return newUid;
    });
    imapManager.removeMessageCopy.mockImplementation(async (_accountId, uid, folder) => {
      live.delete(`${folder}:${uid}`);
    });
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect([...live.values()]).toContain('headerless-invoice');
    expect(live.get('Todo:101')).toBe('headerless-invoice');
    expect(live.has('Reference:98')).toBe(false);
  });

  it('copies every distinct old member before deleting any, even without UIDPLUS or Message-ID', async () => {
    stubQueries({ threadCopies: [
      { uid: 98, folder: 'Reference', message_id: '<invoice@example.test>' },
      { uid: 99, folder: 'Someday', message_id: null },
    ] });
    imapManager.copyMessage.mockResolvedValue(null);
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(200);
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 98, 'Reference', 'Todo');
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 99, 'Someday', 'Todo');
    expect(imapManager.copyMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(imapManager.removeMessageCopy.mock.invocationCallOrder[0]);
  });

  it('does not expunge old members when a preservation COPY fails', async () => {
    stubQueries({ threadCopies: [{ uid: 98, folder: 'Reference', message_id: '<invoice@example.test>' }] });
    imapManager.copyMessage.mockResolvedValueOnce(77).mockRejectedValueOnce(new Error('preservation failed'));
    const res = await classify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('makes a fresh preservation copy when the target is only known from cache', async () => {
    stubQueries({ folders: ['Watch', 'Todo'], siblings: { Watch: 41, Todo: 42 } });
    const res = await classify({ messageId: MSG_ID, state: 'watch' });
    expect(res.status).toBe(200);
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 10, 'INBOX', 'Watch');
    expect(imapManager.copyMessage.mock.invocationCallOrder[0]).toBeLessThan(imapManager.removeMessageCopy.mock.invocationCallOrder[0]);
  });

  it('removes a prior GTD state carried by another message in the same thread', async () => {
    stubQueries({ threadCopies: [
      { account_id: ACCT_ID, uid: 10, folder: 'INBOX' },
      { account_id: ACCT_ID, uid: 98, folder: 'Reference' },
      { account_id: ACCT_ID, uid: 99, folder: 'Receipts' },
    ] });
    const res = await classify({ messageId: MSG_ID, state: 'someday' });

    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy).toHaveBeenCalledExactlyOnceWith(ACCT_ID, 98, 'Reference');
  });

  it('preserves an older GTD state even when the requested state is cached', async () => {
    stubQueries({ folders: ['Watch', 'Todo'], siblings: { Watch: 41, Todo: 42 } });
    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(200);
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 10, 'INBOX', 'Watch');
    expect(imapManager.removeMessageCopy).toHaveBeenCalledExactlyOnceWith(ACCT_ID, 42, 'Todo');
  });

  it('keeps the old state when applying the new state fails', async () => {
    stubQueries({ folders: ['Todo'], siblings: { Todo: 42 } });
    imapManager.copyMessage.mockRejectedValue(new Error('IMAP COPY failed'));
    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(500);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('switches from a selected GTD folder copy even without a Message-ID', async () => {
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo', message_id: null } });
    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(200);
    expect(imapManager.copyMessage).toHaveBeenCalledWith(ACCT_ID, 10, 'Todo', 'Watch');
    expect(imapManager.removeMessageCopy).toHaveBeenCalledExactlyOnceWith(ACCT_ID, 10, 'Todo');
  });

  it('keeps the new copy if removal fails after expunging an older GTD label', async () => {
    stubQueries({ folders: ['Todo'], siblings: { Todo: 42 } });
    imapManager.removeMessageCopy.mockRejectedValueOnce(new Error('cannot remove old copy'));
    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(500);
    expect(imapManager.removeMessageCopy).toHaveBeenNthCalledWith(1, ACCT_ID, 42, 'Todo');
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(ACCT_ID, 77, 'Watch');
  });

  it('retains a non-UIDPLUS target copy after old-state removal fails', async () => {
    stubQueries({ folders: ['Todo'], siblings: { Todo: 42 } });
    const originalQuery = query.getMockImplementation();
    let watchLookups = 0;
    query.mockImplementation((sql, params) => {
      if (sql.startsWith('SELECT uid FROM messages') && params?.[1] === 'Watch') {
        watchLookups += 1;
        return { rows: [{ uid: 88 }] };
      }
      return originalQuery(sql, params);
    });
    imapManager.copyMessage.mockResolvedValueOnce(null);
    imapManager.removeMessageCopy.mockRejectedValueOnce(new Error('cannot remove Todo'));

    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(500);
    expect(watchLookups).toBe(0);
    expect(imapManager.removeMessageCopy).toHaveBeenNthCalledWith(1, ACCT_ID, 42, 'Todo');
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(ACCT_ID, 88, 'Watch');
  });

  it('reports the removal error without trying rollback before destination sync', async () => {
    stubQueries({ folders: ['Todo'], siblings: { Todo: 42 } });
    imapManager.copyMessage.mockResolvedValueOnce(null);
    imapManager.removeMessageCopy.mockRejectedValueOnce(new Error('cannot remove Todo'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await classify({ messageId: MSG_ID, state: 'watch' });

      expect(res.status).toBe(500);
      expect(imapManager.removeMessageCopy).toHaveBeenCalledTimes(1);
      expect(error.mock.calls.some(([message]) => String(message).includes('GTD classify failed'))).toBe(true);
      expect(error.mock.calls.some(([message]) => String(message).includes('rollback'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it('removes the selected old-state row last so a failed switch remains retryable', async () => {
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo' }, threadCopies: [
      { uid: 10, folder: 'Todo' },
      { uid: 98, folder: 'Reference' },
    ] });
    imapManager.removeMessageCopy.mockRejectedValueOnce(new Error('cannot remove Reference'));
    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(500);
    expect(imapManager.removeMessageCopy).toHaveBeenNthCalledWith(1, ACCT_ID, 98, 'Reference');
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(ACCT_ID, 10, 'Todo');
  });

  it('retains a fresh target UID when the source has no Message-ID', async () => {
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo', message_id: null } });
    imapManager.removeMessageCopy.mockRejectedValueOnce(new Error('cannot remove Todo'));
    const res = await classify({ messageId: MSG_ID, state: 'watch' });

    expect(res.status).toBe(500);
    expect(imapManager.removeMessageCopy).toHaveBeenNthCalledWith(1, ACCT_ID, 10, 'Todo');
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(ACCT_ID, 77, 'Watch');
  });

  it('retains every new member after an earlier removal succeeds and a later one throws', async () => {
    const live = new Map([['Todo:10', '<m@x>'], ['Reference:98', '<invoice@example.test>']]);
    stubQueries({ msg: { ...inboxMsg, folder: 'Todo' }, threadCopies: [
      { ...inboxMsg, folder: 'Todo' },
      { uid: 98, folder: 'Reference', message_id: '<invoice@example.test>' },
    ] });
    let nextUid = 100;
    imapManager.copyMessage.mockImplementation(async (_acct, uid, from, to) => {
      live.set(`${to}:${nextUid}`, live.get(`${from}:${uid}`));
      return nextUid++;
    });
    imapManager.removeMessageCopy.mockImplementation(async (_acct, uid, folder) => {
      live.delete(`${folder}:${uid}`);
      if (uid === 10) throw new Error('connection dropped after EXPUNGE');
    });
    const res = await classify({ messageId: MSG_ID, state: 'watch' });
    expect(res.status).toBe(500);
    expect([...live.values()]).toContain('<m@x>');
    expect([...live.values()]).toContain('<invoice@example.test>');
    expect([...live.keys()].every(key => key.startsWith('Watch:'))).toBe(true);
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
    stubQueries({ sibling: { uid: 42 } });
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
    stubQueries({ sibling: { uid: 42 } });
    imapManager.removeMessageCopy.mockRejectedValue(new Error('IMAP delete failed'));
    const res = await unclassify({ messageId: MSG_ID, state: 'todo' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed to remove gtd label/i);
  });
});

describe('POST /api/gtd/classify/undo — remove only the request-owned copy', () => {
  const token = { messageId: MSG_ID, state: 'todo', folder: 'Todo', uid: 77 };

  it('removes the exact copy identified by the classify response', async () => {
    const res = await undoClassify(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true, folder: 'Todo' });
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 77, 'Todo');
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
