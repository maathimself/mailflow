import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST /api/gtd/done end-to-end for the archive step's two race/failure contracts (a
// concurrent /done racing the same INBOX row, and an archive move that throws) —
// behaviour the pure resolveDoneFolders tests can't reach. db + imapManager are
// stubbed; mailUtils' side-effecting helpers (archive resolution, count adjust, read fan-out)
// are mocked so the archive DB write's rowCount is the only thing under test. getGtdConfig is
// mocked to a fixed enabled config; requireAuth is a passthrough injecting a session.
vi.mock('../../services/db.js', () => {
  const query = vi.fn();
  return { query, withTransaction: vi.fn(callback => callback({ query })) };
});
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
  };
});
vi.mock('./gtdConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getGtdConfig: vi.fn() };
});
vi.mock('../../services/gtdDoneOperations.js', () => ({
  createOrLoadGtdDoneOperation: vi.fn(),
  claimGtdDoneOperation: vi.fn(),
  renewGtdDoneOperation: vi.fn(),
  advanceGtdDoneOperation: vi.fn(),
  releaseGtdDoneOperation: vi.fn(),
}));

import express from 'express';
import { query } from '../../services/db.js';
import { setMailEngine } from '../mailEngine.js';
import { resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings } from '../../utils/mailUtils.js';
import { getGtdConfig, DEFAULT_GTD_FOLDERS } from './gtdConfig.js';
import {
  createOrLoadGtdDoneOperation,
  claimGtdDoneOperation,
  renewGtdDoneOperation,
  advanceGtdDoneOperation,
  releaseGtdDoneOperation,
} from '../../services/gtdDoneOperations.js';

// The done route's mail actions (label strip, mark-read, archive, broadcast) go through the bound
// plugin-api capabilities; inject a mock engine, asserted on directly below.
const imapManager = {
  moveMessage: vi.fn(),
  moveMessageWithReceipt: vi.fn(),
  findUidByRecoveryKeyword: vi.fn(),
  clearMoveRecoveryKeyword: vi.fn(),
  setDesiredFlag: vi.fn(),
  setFlag: vi.fn(),
  messageExists: vi.fn(),
  reconcileMissingMessageCopy: vi.fn(),
  removeMessageCopy: vi.fn(),
  _enqueueFlagPush: vi.fn(),
  _resolveFlagPush: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
  broadcast: vi.fn(),
};
setMailEngine(imapManager);
import gtdRoutes from './routes.js';

const MSG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// The rail acts on the Watch-folder copy; a distinct INBOX sibling is what the archive step
// moves. is_read true on both keeps the mark-read path off the IMAP setFlag mock.
const msg = { id: MSG_ID, account_id: ACCT_ID, thread_key: 'thread-1', uid: 10, folder: 'Watch', message_id: '<m@x>', is_read: true, is_deleted: false, metadata_complete: true, folder_uid_validity: 321, folder_observation_generation: 6, folder_topology_identity: 'watch-incarnation', read_revision: 2, star_revision: 0 };
const account = { id: ACCT_ID, user_id: 'u1', folder_mappings: {} };
const inboxCopy = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', account_id: ACCT_ID, thread_key: 'thread-1', uid: 77, folder: 'INBOX', message_id: '<m@x>', is_read: true, is_deleted: false, metadata_complete: true, folder_uid_validity: 123, folder_observation_generation: 4, folder_topology_identity: 'inbox-incarnation', read_revision: 3, star_revision: 0 };
let archiveRowsByUid = new Map();
let currentSnapshot = [];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gtd', gtdRoutes);
  return app;
}

// Route every query /done issues; archiveWrite is the swappable rowCount of the INBOX row's
// archive UPDATE/DELETE — the authority for whether this call or a concurrent /done won the race.
function stubQueries({
  acted = msg,
  threadRows,
  archiveWrite = { rowCount: 1 },
  readRows = [],
  readError = null,
  ownedAccount = account,
  inboxRowPresent = true,
} = {}) {
  const snapshot = (threadRows || [acted, ...(inboxCopy ? [inboxCopy] : [])]).map(row => ({
    is_deleted: false,
    metadata_complete: true,
    folder_uid_validity: row.folder === 'INBOX' ? 123 : (row.folder_uid_validity ?? 321),
    folder_observation_generation: row.folder === 'INBOX' ? 4 : (row.folder_observation_generation ?? 6),
    folder_topology_identity: row.folder === 'INBOX'
      ? 'inbox-incarnation'
      : (row.folder_topology_identity ?? `${row.folder}-incarnation`),
    read_revision: row.read_revision ?? 0,
    star_revision: row.star_revision ?? 0,
    ...row,
  }));
  currentSnapshot = snapshot;
  archiveRowsByUid = new Map(snapshot
    .filter(row => row.folder === 'INBOX')
    .map(row => [Number(row.uid), {
      is_deleted: false, metadata_complete: true, folder_uid_validity: 123, ...row,
    }]));
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: acted ? [acted] : [] };
    if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: ownedAccount ? [ownedAccount] : [] };
    if (sql.includes('f.uid_validity AS folder_uid_validity')) return { rows: snapshot };
    if (sql.includes('SELECT path, uid_validity')) {
      return { rows: [
        { path: 'Archive', uid_validity: 456, observation_generation: 8 },
        { path: 'INBOX', uid_validity: 123, observation_generation: 4 },
      ] };
    }
    if (sql.includes('UPDATE messages') && sql.includes('jsonb_to_recordset')) {
      if (readError) throw readError;
      return { rows: readRows };
    }
    // Legacy route seam, retained while the new thread-snapshot tests drive replacement.
    if (sql.startsWith('SELECT id, uid, is_read FROM messages')) return { rows: snapshot.filter(r => r.folder === 'INBOX').slice(0, 1) };
    if (sql.startsWith('SELECT uid FROM messages')) return { rows: [{ uid: 10 }] };
    if (sql.startsWith('DELETE FROM messages') || sql.startsWith('UPDATE messages SET folder')) return archiveWrite;
    if (sql.startsWith('SELECT id FROM messages WHERE id')) {
      return { rows: inboxRowPresent ? [{ id: inboxCopy.id }] : [] };
    }
    if (sql.startsWith('SELECT 1 FROM messages')) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  });
}

const done = (body) => fetch(`${base}/api/gtd/done`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'done-test-key' }, body: JSON.stringify(body),
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
  archiveRowsByUid = new Map([[Number(inboxCopy.uid), inboxCopy]]);
  Object.values(imapManager).forEach(fn => fn.mockReset());
  [resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings, getGtdConfig].forEach(fn => fn.mockReset());
  getGtdConfig.mockResolvedValue({ enabled: true, folders: DEFAULT_GTD_FOLDERS });
  resolveArchiveFolder.mockResolvedValue('Archive');
  isAllMailFolder.mockResolvedValue(false);
  fanOutReadToSiblings.mockResolvedValue(undefined);
  imapManager.removeMessageCopy.mockResolvedValue(1);
  createOrLoadGtdDoneOperation.mockReset().mockImplementation(async ({
    userId, actedMessageId, intent, deriveTargetFolders,
  }) => {
    const acted = currentSnapshot.find(row => row.id === actedMessageId);
    if (!acted || acted.is_deleted || acted.metadata_complete === false) {
      throw Object.assign(new Error('Message not found'), { status: 404, retryable: false });
    }
    const config = await getGtdConfig(ACCT_ID);
    const target = deriveTargetFolders({
      enabled: config.enabled, folders: config.folders, states: intent,
      existing: currentSnapshot.map(row => row.folder),
    });
    if (target.error) throw Object.assign(new Error(target.error), { status: target.status });
    const sorted = [...currentSnapshot].sort((a, b) => String(a.folder).localeCompare(String(b.folder)) || a.uid - b.uid || String(a.id).localeCompare(String(b.id)));
    const inbox = sorted.filter(row => row.folder === 'INBOX');
    const labels = sorted.filter(row => target.folders.includes(row.folder));
    const inboxAnchor = inbox.find(row => row.id === actedMessageId) || inbox[0];
    const labelAnchor = labels.find(row => row.id === actedMessageId) || labels[0];
    const last = (rows, anchor) => [...rows.filter(row => row.id !== anchor?.id), ...rows.filter(row => row.id === anchor?.id)];
    return {
      key: `test:${userId}:${actedMessageId}`, accountId: ACCT_ID, phase: 'seen', itemIndex: 0,
      plan: {
        rows: sorted, inboxRows: last(inbox, inboxAnchor), labelRows: last(labels, labelAnchor),
        inboxAnchorId: inboxAnchor?.id || null, labelAnchorId: labelAnchor?.id || null,
        targetFolders: target.folders, archiveFolder: await resolveArchiveFolder(),
        archiveAllMail: false,
        archiveObservation: {
          folder: 'Archive', uidValidity: '456', generation: '8',
          topologyIdentity: 'archive-incarnation', isPresent: true,
        },
      },
    };
  });
  claimGtdDoneOperation.mockReset().mockImplementation(async op => ({ ...op, claimOwner: 'owner-1' }));
  renewGtdDoneOperation.mockReset().mockImplementation(async op => op);
  advanceGtdDoneOperation.mockReset().mockImplementation(async (op, phase, itemIndex, outcome, plan) => ({
    ...op,
    phase,
    itemIndex,
    plan: plan || op.plan,
    outcomes: [...(op.outcomes || []), ...(outcome ? [outcome] : [])],
  }));
  releaseGtdDoneOperation.mockReset().mockResolvedValue(undefined);
  imapManager.setDesiredFlag.mockImplementation(async (_account, _id, _flag, _value, options) => ({
    changed: false,
    acceptance: { delivery: { revision: Number(options.snapshot.readRevision) + 1 } },
    delivery: { state: 'confirmed' },
  }));
  imapManager.moveMessageWithReceipt.mockImplementation(async (...args) => {
    const uid = await imapManager.moveMessage(...args);
    const receipt = {
      folder: args[3], uid, uidValidity: '456', marker: '$MailFlowOp-test',
      sourceToken: {
        folder: args[2], uid: args[1], uidValidity: '123', generation: '4',
      },
      destinationToken: { folder: args[3], uidValidity: '456', generation: '8' },
    };
    const operation = {
      kind: 'move', accountId: ACCT_ID, marker: receipt.marker,
      source: receipt.sourceToken, destination: receipt.destinationToken,
    };
    const tx = {
      query: async (sql, params) => {
        if (/SELECT path, uid_validity, observation_generation, is_present/.test(sql)) {
          return { rows: [
            { path: 'Archive', uid_validity: 456, observation_generation: 8, is_present: true },
            { path: 'INBOX', uid_validity: 123, observation_generation: 4, is_present: true },
          ] };
        }
        if (/SELECT m\.\*/.test(sql)) {
          const source = archiveRowsByUid.get(Number(args[1]));
          return { rows: source ? [source] : [] };
        }
        if (/^UPDATE messages/.test(sql)) {
          const write = await query('UPDATE messages SET folder = $1', params);
          return write.rowCount > 0
            ? { rowCount: write.rowCount, rows: [{
                ...archiveRowsByUid.get(Number(args[1])), folder: args[3], uid,
              }] }
            : write;
        }
        if (/SELECT id, account_id, folder, uid/.test(sql)) return { rows: [] };
        return query(sql, params);
      },
    };
    await args[4]?.materialize?.(receipt, operation, tx);
    return receipt;
  });
  imapManager.findUidByRecoveryKeyword.mockResolvedValue(88);
  imapManager.clearMoveRecoveryKeyword.mockResolvedValue(true);
});

describe('POST /api/gtd/done — id validation', () => {
  it('rejects a malformed (non-UUID) id with 400 before any lookup', async () => {
    const res = await done({ id: 'not-a-uuid', states: ['watch'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid message id/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a soft-deleted anchor before loading or mutating its live thread', async () => {
    stubQueries({ acted: { ...msg, is_deleted: true } });

    const res = await done({ id: MSG_ID, states: ['watch'] });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/message not found/i);
    expect(getGtdConfig).not.toHaveBeenCalled();
    expect(imapManager.setFlag).not.toHaveBeenCalled();
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  it('rejects an incomplete-metadata anchor before loading or mutating its live thread', async () => {
    stubQueries({ acted: { ...msg, metadata_complete: false } });

    const res = await done({ id: MSG_ID, states: ['watch'] });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/message not found/i);
    expect(getGtdConfig).not.toHaveBeenCalled();
    expect(imapManager.setFlag).not.toHaveBeenCalled();
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/done — archive count-adjust race', () => {
  it('returns durable completion even when the terminal broadcast fails', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88);
    imapManager.broadcast.mockImplementationOnce(() => { throw new Error('socket down'); });

    const res = await done({ id: MSG_ID, states: ['watch'] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, phase: 'completed', inboxCleared: true });
    expect(imapManager.broadcast).toHaveBeenCalledTimes(1);
  });

  it('archives + adjusts both counts when the INBOX-scoped write applied (rowCount 1)', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88); // UIDPLUS newUid
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false });
    expect(adjustFolderCounts).toHaveBeenCalledTimes(2);
    // The terminal refresh so the rail converges post-done.
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: ACCT_ID }, 'u1');
    expect(imapManager.moveMessageWithReceipt).toHaveBeenCalledWith(
      account, inboxCopy.uid, 'INBOX', 'Archive',
      expect.objectContaining({
        operationTokens: [
          {
            folder: 'INBOX',
            uidValidity: String(inboxCopy.folder_uid_validity),
            generation: String(inboxCopy.folder_observation_generation),
            topologyIdentity: inboxCopy.folder_topology_identity,
            isPresent: true,
          },
          {
            folder: 'Archive', uidValidity: '456', generation: '8',
            topologyIdentity: 'archive-incarnation', isPresent: true,
          },
        ],
        snapshot: expect.objectContaining({
          id: inboxCopy.id, uid: inboxCopy.uid, folder: 'INBOX',
          uidValidity: String(inboxCopy.folder_uid_validity),
          folderGeneration: String(inboxCopy.folder_observation_generation),
        }),
      }),
    );
    expect(resolveArchiveFolder).toHaveBeenCalledTimes(1);
  });

  it('no count drift, archived=false when a concurrent /done already moved the INBOX row (rowCount 0)', async () => {
    stubQueries({ archiveWrite: { rowCount: 0 }, inboxRowPresent: false });
    imapManager.moveMessage.mockResolvedValue(null); // silent server-side no-op
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ phase: 'archive', inboxCleared: false, uncertain: true });
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('terminates the lifecycle when the frozen Archive epoch is superseded', async () => {
    stubQueries();
    imapManager.moveMessage.mockRejectedValue(Object.assign(
      new Error('Archive UIDVALIDITY changed'),
      { code: 'FOLDER_OBSERVATION_UIDVALIDITY_CHANGED', retryable: true },
    ));

    const res = await done({ id: MSG_ID, states: ['watch'] });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      phase: 'archive', inboxCleared: false, retryable: false, uncertain: true,
      code: 'FOLDER_OBSERVATION_UIDVALIDITY_CHANGED',
    });
    expect(resolveArchiveFolder).toHaveBeenCalledTimes(1);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted source', 'FOLDER_OBSERVATION_UNSAFE'],
    ['deleted destination', 'FOLDER_OBSERVATION_SUPERSEDED'],
    ['missing native MOVE', 'PROVIDER_NATIVE_MOVE_UNSUPPORTED'],
    ['unsupported recovery keyword', 'PROVIDER_RECOVERY_MARKER_UNSUPPORTED'],
  ])('returns terminal lifecycle truth for %s', async (_case, code) => {
    stubQueries();
    imapManager.moveMessage.mockRejectedValue(Object.assign(
      new Error(_case), { code, retryable: true },
    ));

    const res = await done({ id: MSG_ID, states: ['watch'] });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code, phase: 'archive', inboxCleared: false, retryable: false,
    });
  });

  it('keeps a transient provider transport failure retryable', async () => {
    stubQueries();
    imapManager.moveMessage.mockRejectedValue(Object.assign(
      new Error('socket timeout'), { code: 'ETIMEDOUT', retryable: true },
    ));

    const res = await done({ id: MSG_ID, states: ['watch'] });

    expect(await res.json()).toMatchObject({
      code: 'ETIMEDOUT', phase: 'archive', inboxCleared: false, retryable: true,
    });
  });
});

describe('POST /api/gtd/done — thread-wide snapshot contract', () => {
  it('removes every requested-label copy and archives every INBOX member even when the head is another message/state', async () => {
    const todoA = { id: '11111111-1111-4111-8111-111111111111', account_id: ACCT_ID, thread_key: 'thread-1', uid: 21, folder: 'Todo', message_id: '<old@x>', is_read: true };
    const todoB = { id: '22222222-2222-4222-8222-222222222222', account_id: ACCT_ID, thread_key: 'thread-1', uid: 22, folder: 'Todo', message_id: '<new@x>', is_read: true };
    const inboxB = { id: '33333333-3333-4333-8333-333333333333', account_id: ACCT_ID, thread_key: 'thread-1', uid: 78, folder: 'INBOX', message_id: '<new@x>', is_read: true };
    stubQueries({ threadRows: [msg, todoA, todoB, inboxCopy, inboxB] });
    imapManager.moveMessage.mockResolvedValueOnce(87).mockResolvedValueOnce(88);

    const res = await done({ id: MSG_ID, states: ['todo'] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 21, 'Todo', expect.objectContaining({
      expectedId: todoA.id,
      notify: false,
    }));
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, 22, 'Todo', expect.objectContaining({
      expectedId: todoB.id,
      notify: false,
    }));
    expect(imapManager.moveMessage.mock.calls.map(call => call[1])).toEqual([78, 77]);
    expect(body).toMatchObject({
      removed: ['Todo'],
      labelTargetCount: 2,
      removedCount: 2,
      archiveTargetCount: 2,
      archivedCount: 2,
      archiveAlreadyGoneCount: 0,
      archiveFailedCount: 0,
      archiveUnconfirmedCount: 0,
      archiveSkippedNoFolderCount: 0,
      archived: true,
      inboxCleared: true,
    });
  });

  it('allows a null Message-ID because the authorized thread key is the mutation identity', async () => {
    const noHeader = { ...msg, message_id: null };
    stubQueries({ acted: noHeader, threadRows: [noHeader, inboxCopy] });
    imapManager.moveMessage.mockResolvedValue(88);

    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, inboxCleared: true });
  });

  it('stops at the first nonconclusive Seen push and reports only the observed failure', async () => {
    const unreadTodo = { ...msg, is_read: false };
    const unreadInbox = { ...inboxCopy, is_read: false };
    stubQueries({ threadRows: [unreadTodo, unreadInbox], readRows: [unreadTodo, unreadInbox] });
    imapManager.setDesiredFlag
      .mockRejectedValueOnce(Object.assign(new Error('flag failed'), { uncertain: true }))
      .mockImplementationOnce(async (_account, _id, _flag, _value, options) => ({
        changed: true,
        acceptance: { delivery: { revision: Number(options.snapshot.readRevision) + 1 } },
        delivery: { state: 'confirmed' },
      }));
    imapManager.moveMessage.mockResolvedValue(88);

    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(503);
    expect(imapManager.setDesiredFlag).toHaveBeenCalledTimes(1);
    expect(imapManager.setDesiredFlag.mock.calls[0][1]).toBe(unreadInbox.id);
    expect(imapManager.setDesiredFlag.mock.calls[0][4]?.snapshot?.folder).toBe(unreadInbox.folder);
    expect(imapManager.setDesiredFlag.mock.calls.some(call => call[1] === unreadTodo.id)).toBe(false);
    expect(await res.json()).toMatchObject({ seenFailedCount: 1 });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(imapManager.broadcast).toHaveBeenCalledTimes(1);
  });

  it('all-states removes every concrete row in deduped configured folders', async () => {
    const sharedA = { id: '11111111-1111-4111-8111-111111111111', account_id: ACCT_ID, thread_key: 'thread-1', uid: 21, folder: 'Shared', message_id: '<a@x>', is_read: true };
    const sharedB = { id: '22222222-2222-4222-8222-222222222222', account_id: ACCT_ID, thread_key: 'thread-1', uid: 22, folder: 'Shared', message_id: '<b@x>', is_read: true };
    getGtdConfig.mockResolvedValueOnce({
      enabled: true,
      folders: { ...DEFAULT_GTD_FOLDERS, todo: 'Shared', watch: 'Shared' },
    });
    stubQueries({ threadRows: [msg, sharedA, sharedB, inboxCopy] });
    imapManager.moveMessage.mockResolvedValue(88);

    const res = await done({ id: MSG_ID, states: 'all' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(imapManager.removeMessageCopy).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({ labelTargetCount: 2, removedCount: 2, removed: ['Shared'] });
  });

  it('derives omitted Inbox Done intent from every actual frozen GTD label', async () => {
    const delegated = {
      ...msg,
      id: '11111111-1111-4111-8111-111111111111',
      uid: 21,
      folder: 'Delegated',
    };
    const someday = {
      ...msg,
      id: '22222222-2222-4222-8222-222222222222',
      uid: 22,
      folder: 'Someday',
    };
    stubQueries({ acted: inboxCopy, threadRows: [inboxCopy, delegated, someday] });
    imapManager.moveMessage.mockResolvedValue(88);

    const res = await done({ id: inboxCopy.id });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ removed: ['Someday', 'Delegated'], removedCount: 2 });
    expect(imapManager.removeMessageCopy.mock.calls.map(call => call[2])).toEqual(['Someday', 'Delegated']);
  });

  it('stops on the first archive failure without touching later archive or label rows', async () => {
    const inboxB = { id: '33333333-3333-4333-8333-333333333333', account_id: ACCT_ID, thread_key: 'thread-1', uid: 78, folder: 'INBOX', message_id: '<new@x>', is_read: true };
    stubQueries({ threadRows: [msg, inboxCopy, inboxB] });
    imapManager.moveMessage
      .mockRejectedValueOnce(new Error('first move failed'))
      .mockResolvedValueOnce(88);

    const res = await done({ id: MSG_ID, states: ['watch'] });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(imapManager.moveMessage).toHaveBeenCalledTimes(1);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(
      ACCT_ID, msg.uid, msg.folder, expect.anything()
    );
    expect(body).toMatchObject({ phase: 'archive', inboxCleared: false, uncertain: true });
  });

  it('returns durable completed and pending counts after a partial archive throws', async () => {
    const inboxB = {
      ...inboxCopy,
      id: '33333333-3333-4333-8333-333333333333',
      uid: 78,
      message_id: '<new@x>',
    };
    stubQueries({ threadRows: [msg, inboxCopy, inboxB] });
    imapManager.moveMessage
      .mockResolvedValueOnce(88)
      .mockRejectedValueOnce(new Error('second move failed'));

    const res = await done({ id: MSG_ID, states: ['watch'] });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      phase: 'archive',
      inboxCleared: false,
      archiveTargetCount: 2,
      archivedCount: 1,
      archiveAlreadyGoneCount: 0,
      archiveFailedCount: 0,
      archiveUnconfirmedCount: 0,
      archivePendingCount: 1,
      labelTargetCount: 1,
      removedCount: 0,
      labelAlreadyGoneCount: 0,
      labelUnconfirmedCount: 0,
      labelPendingCount: 1,
    });
    expect(imapManager.moveMessage).toHaveBeenCalledTimes(2);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
  });

  it('returns durable completed and pending counts after a partial label removal throws', async () => {
    const delegated = {
      ...msg,
      id: '11111111-1111-4111-8111-111111111111',
      uid: 21,
      folder: 'Delegated',
    };
    stubQueries({ threadRows: [msg, delegated, inboxCopy] });
    imapManager.moveMessage.mockResolvedValue(88);
    imapManager.removeMessageCopy
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('anchor label removal failed'));

    const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      phase: 'labels',
      inboxCleared: true,
      archiveTargetCount: 1,
      archivedCount: 1,
      archiveAlreadyGoneCount: 0,
      archiveFailedCount: 0,
      archiveUnconfirmedCount: 0,
      archivePendingCount: 0,
      labelTargetCount: 2,
      removedCount: 1,
      labelAlreadyGoneCount: 0,
      labelUnconfirmedCount: 0,
      labelPendingCount: 1,
    });
    expect(imapManager.removeMessageCopy).toHaveBeenCalledTimes(2);
  });

  it('partitions an explicit unconfirmed label outcome separately from pending targets', async () => {
    const delegated = {
      ...msg,
      id: '11111111-1111-4111-8111-111111111111',
      uid: 21,
      folder: 'Delegated',
    };
    stubQueries({ threadRows: [msg, delegated, inboxCopy] });
    imapManager.moveMessage.mockResolvedValue(88);
    imapManager.removeMessageCopy
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(undefined);

    const res = await done({ id: MSG_ID, states: ['watch', 'delegated'] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      phase: 'labels',
      inboxCleared: true,
      labelTargetCount: 2,
      removedCount: 1,
      labelAlreadyGoneCount: 0,
      labelUnconfirmedCount: 1,
      labelPendingCount: 0,
    });
  });

  it('partitions every target as skipped when no Archive folder is configured', async () => {
    const inboxB = { ...inboxCopy, id: '33333333-3333-4333-8333-333333333333', uid: 78 };
    stubQueries({ threadRows: [msg, inboxCopy, inboxB] });
    resolveArchiveFolder.mockResolvedValue(null);

    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(await res.json()).toMatchObject({
      archiveTargetCount: 2,
      archiveSkippedNoFolderCount: 1,
      noArchiveFolder: true,
      archived: false,
      inboxCleared: false,
    });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(
      ACCT_ID, msg.uid, msg.folder, expect.anything()
    );
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
  });

  it('fails before destructive work when durable desired-read acceptance fails', async () => {
    stubQueries();
    imapManager.setDesiredFlag.mockRejectedValue(new Error('db down'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(503);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.moveMessage).not.toHaveBeenCalled();
    expect(imapManager.broadcast).toHaveBeenCalledWith(
      { type: 'gtd_sections_updated', accountId: ACCT_ID }, 'u1',
    );
  });

  it('rejects an account that disappeared after the owned row load', async () => {
    stubQueries({ ownedAccount: null });
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(404);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.broadcast).not.toHaveBeenCalled();
  });
});

describe('POST /api/gtd/done — strip-ok + archive-fail', () => {
  it('does not infer archive success from source disappearance after a DB failure', async () => {
    let archiveWriteFailed = false;
    let inboxPresent = true;
    let archivePresent = false;
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: [msg] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('f.uid_validity AS folder_uid_validity')) {
        return { rows: inboxPresent ? [msg, inboxCopy] : [msg, ...(archivePresent ? [{ ...inboxCopy, folder: 'Archive', uid: 88 }] : [])] };
      }
      if (sql.includes('UPDATE messages') && sql.includes('id = ANY')) return { rows: [] };
      if (sql.includes('SELECT path, uid_validity')) return { rows: [
        { path: 'Archive', uid_validity: 456, observation_generation: 8 },
        { path: 'INBOX', uid_validity: 123, observation_generation: 4 },
      ] };
      if (sql.startsWith('UPDATE messages SET folder')) {
        if (!archiveWriteFailed) {
          archiveWriteFailed = true;
          throw new Error('archive write failed');
        }
        return { rowCount: 0 };
      }
      if (sql.startsWith('SELECT id FROM messages WHERE id')) {
        return { rows: inboxPresent ? [{ id: inboxCopy.id }] : [] };
      }
      return { rows: [] };
    });
    imapManager.moveMessage
      .mockResolvedValueOnce(88)
      .mockRejectedValueOnce(new Error('no matching message'));
    imapManager.setFlag
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no matching message'));
    imapManager.messageExists.mockResolvedValueOnce(false);
    imapManager.reconcileMissingMessageCopy.mockImplementationOnce(async () => {
      inboxPresent = false;
      archivePresent = true;
      return { reconciled: true, changed: 1 };
    });

    const first = await done({ id: MSG_ID, states: ['watch'] });
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ phase: 'archive', inboxCleared: false });

    const second = await done({ id: MSG_ID, states: ['watch'] });
    expect(second.status).toBe(500);
    expect(await second.json()).toMatchObject({ inboxCleared: false, phase: 'archive' });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalledWith(
      ACCT_ID, msg.uid, msg.folder, expect.anything(),
    );
  });

  it('returns a partial result and retains the acted GTD row when the archive step throws', async () => {
    stubQueries();
    imapManager.moveMessage.mockRejectedValue(new Error('IMAP move failed'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ phase: 'archive', inboxCleared: false });
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(adjustFolderCounts).not.toHaveBeenCalled();
  });

  it('retains the recovery marker and releases the source guard when the archive write throws', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM messages m') && sql.includes('JOIN email_accounts')) return { rows: [msg] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('f.uid_validity AS folder_uid_validity')) return { rows: [msg, inboxCopy] };
      if (sql.includes('UPDATE messages') && sql.includes('id = ANY')) return { rows: [] };
      if (sql.includes('SELECT path, uid_validity')) return { rows: [
        { path: 'Archive', uid_validity: 456, observation_generation: 8 },
        { path: 'INBOX', uid_validity: 123, observation_generation: 4 },
      ] };
      if (sql.startsWith('UPDATE messages SET folder')) throw new Error('archive write failed');
      return { rows: [] };
    });
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ phase: 'archive', inboxCleared: false });
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCT_ID, 'INBOX', inboxCopy.uid);
    expect(imapManager.clearMoveRecoveryKeyword).not.toHaveBeenCalled();
  });

  it('full success: archived=true, archiveFailed=false, noArchiveFolder=false', async () => {
    stubQueries({ archiveWrite: { rowCount: 1 } });
    imapManager.moveMessage.mockResolvedValue(88);
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: true, archiveFailed: false, noArchiveFolder: false });
    expect(imapManager.moveMessage.mock.invocationCallOrder[0])
      .toBeLessThan(imapManager.removeMessageCopy.mock.invocationCallOrder[0]);
    // The terminal refresh so the rail converges post-done.
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'gtd_sections_updated', accountId: ACCT_ID }, 'u1');
  });

  it('final acted-label failure still 500s after archive while preserving the retry row', async () => {
    stubQueries();
    imapManager.moveMessage.mockResolvedValue(88);
    imapManager.removeMessageCopy.mockRejectedValue(new Error('IMAP delete failed'));
    const res = await done({ id: MSG_ID, states: ['watch'] });
    expect(res.status).toBe(500);
    expect(imapManager.moveMessage).toHaveBeenCalledOnce();
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(ACCT_ID, msg.uid, msg.folder, expect.objectContaining({
      expectedId: MSG_ID,
      notify: false,
    }));
  });

  it('strips the acted folder LAST, so an earlier strip failure leaves the acted row retryable', async () => {
    const delegated = {
      id: '44444444-4444-4444-8444-444444444444',
      account_id: ACCT_ID,
      thread_key: 'thread-1',
      uid: 44,
      folder: 'Delegated',
      message_id: '<other@x>',
      is_read: true,
    };
    stubQueries({ threadRows: [delegated, msg, inboxCopy] });
    imapManager.moveMessage.mockResolvedValue(88);
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
    expect(imapManager.moveMessage).toHaveBeenCalledOnce(); // archive completed before label stripping
    expect(imapManager.broadcast).toHaveBeenCalledTimes(1);
  });
});
