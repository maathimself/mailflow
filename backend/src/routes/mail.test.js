import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'u1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    bulkMoveMessages: vi.fn(),
    bulkPermanentDelete: vi.fn(),
    syncFolderOnDemand: vi.fn(),
    moveMessage: vi.fn(),
    moveMessageGetNewUid: vi.fn(),
    setFlag: vi.fn(),
    broadcast: vi.fn(),
  },
}));
vi.mock('../utils/mailUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adjustFolderCounts: vi.fn(),
    resolveTrashFolder: vi.fn(),
    resolveAllTrashPaths: vi.fn(),
    resolveAllDraftsPaths: vi.fn(),
    resolveArchiveFolder: vi.fn(),
    isAllMailFolder: vi.fn(),
    resolveSpamFolder: vi.fn(),
    resolveAllSpamPaths: vi.fn(),
  };
});
vi.mock('../services/gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));

import express from 'express';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import {
  adjustFolderCounts,
  isAllMailFolder,
  resolveAllDraftsPaths,
  resolveAllSpamPaths,
  resolveAllTrashPaths,
  resolveArchiveFolder,
  resolveSpamFolder,
  resolveTrashFolder,
} from '../utils/mailUtils.js';
import mailRoutes from './mail.js';

const MSG_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const account = { id: ACCOUNT_ID, user_id: 'u1', folder_mappings: {} };
const message = {
  id: MSG_ID,
  account_id: ACCOUNT_ID,
  uid: 10,
  folder: 'INBOX',
  message_id: '<m@example.test>',
  is_read: false,
  folder_mappings: {},
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

const post = (path, body) => fetch(`${base}/api/mail${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const del = (path) => fetch(`${base}/api/mail${path}`, { method: 'DELETE' });

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = buildApp().listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  Object.values(imapManager).forEach(fn => fn.mockReset());
  [
    adjustFolderCounts,
    isAllMailFolder,
    resolveAllDraftsPaths,
    resolveAllSpamPaths,
    resolveAllTrashPaths,
    resolveArchiveFolder,
    resolveSpamFolder,
    resolveTrashFolder,
  ].forEach(fn => fn.mockReset());
  imapManager.syncFolderOnDemand.mockResolvedValue(undefined);
});

describe('mail mutation route characterization', () => {
  it('bulk-move preserves the guarded UIDPLUS move and response contract', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) return { rows: [message] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('WITH deleted AS')) return { rows: [] };
      return { rows: [] };
    });
    imapManager.bulkMoveMessages.mockResolvedValue({
      uidMap: new Map([[10, 110]]),
      succeeded: [10],
      failed: [],
    });

    const res = await post('/messages/bulk-move', { ids: [MSG_ID], folder: 'Archive' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, moved: [MSG_ID] });
    expect(imapManager._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledWith(account, [10], 'INBOX', 'Archive');
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
    const cte = query.mock.calls.find(([sql]) => sql.includes('WITH deleted AS'));
    expect(cte[1]).toEqual([[MSG_ID], [MSG_ID], [110], 'Archive']);
  });

  it('bulk-archive preserves the guarded archive move and receipt', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('WITH deleted AS')) return { rows: [] };
      return { rows: [] };
    });
    resolveArchiveFolder.mockResolvedValue('Archive');
    isAllMailFolder.mockResolvedValue(false);
    imapManager.bulkMoveMessages.mockResolvedValue({
      uidMap: new Map([[10, 110]]),
      succeeded: [10],
      failed: [],
    });

    const res = await post('/messages/bulk-archive', { ids: [MSG_ID] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, archived: [MSG_ID], noArchiveFolder: [] });
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledWith(account, [10], 'INBOX', 'Archive');
    expect(imapManager._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
  });

  it('bulk-delete preserves the move-to-trash path and deleted-id receipt', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('WITH deleted AS')) return { rows: [] };
      return { rows: [] };
    });
    resolveTrashFolder.mockResolvedValue('Trash');
    resolveAllTrashPaths.mockResolvedValue(new Set(['Trash']));
    resolveAllDraftsPaths.mockResolvedValue(new Set(['Drafts']));
    imapManager.bulkMoveMessages.mockResolvedValue({
      uidMap: new Map([[10, 210]]),
      succeeded: [10],
      failed: [],
    });

    const res = await post('/messages/bulk-delete', { ids: [MSG_ID] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: [MSG_ID] });
    expect(imapManager.bulkPermanentDelete).not.toHaveBeenCalled();
    expect(imapManager.bulkMoveMessages).toHaveBeenCalledWith(account, [10], 'INBOX', 'Trash');
    expect(imapManager._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
  });

  it('/spam resolves the spam folder and preserves the move receipt', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.account_id, a.folder_mappings')) {
        return { rows: [{ account_id: ACCOUNT_ID, folder_mappings: {} }] };
      }
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [message] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    resolveSpamFolder.mockResolvedValue('Junk');
    imapManager.moveMessage.mockResolvedValue(310);

    const res = await post(`/messages/${MSG_ID}/spam`, {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder: 'Junk', newUid: 310 });
    expect(imapManager.moveMessage).toHaveBeenCalledWith(account, 10, 'INBOX', 'Junk');
    expect(imapManager._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
    expect(imapManager._unguardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 10);
  });

  it('/ham requires a spam-like source and preserves the inbox move receipt', async () => {
    const spamMessage = { ...message, folder: 'Junk' };
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.account_id, m.folder, a.folder_mappings')) {
        return { rows: [{ account_id: ACCOUNT_ID, folder: 'Junk', folder_mappings: { inbox: 'INBOX' } }] };
      }
      if (sql.includes('SELECT m.*, a.user_id, a.folder_mappings')) return { rows: [spamMessage] };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [{ ...account, folder_mappings: { inbox: 'INBOX' } }] };
      return { rows: [] };
    });
    resolveAllSpamPaths.mockResolvedValue(new Set(['Junk']));
    imapManager.moveMessage.mockResolvedValue(410);

    const res = await post(`/messages/${MSG_ID}/ham`, {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder: 'INBOX', newUid: 410 });
    expect(imapManager.moveMessage).toHaveBeenCalledWith(
      { ...account, folder_mappings: { inbox: 'INBOX' } },
      10,
      'Junk',
      'INBOX',
    );
  });
});

describe('DELETE /api/mail/messages/:id/snooze', () => {
  it('returns 404 when the message is not owned', async () => {
    query.mockResolvedValue({ rows: [] });

    const res = await del(`/messages/${MSG_ID}/snooze`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Message not found' });
    expect(imapManager.moveMessageGetNewUid).not.toHaveBeenCalled();
  });

  it('returns 400 when the message is not currently snoozed', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) {
        return { rows: [{ ...message, folder: 'Snoozed', thread_id: null }] };
      }
      if (sql.includes('FROM snoozed_messages sm')) return { rows: [] };
      return { rows: [] };
    });

    const res = await del(`/messages/${MSG_ID}/snooze`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Message is not currently snoozed' });
  });

  it('restores the whole snoozed reply chain and reports its count', async () => {
    const root = { ...message, folder: 'Snoozed', thread_id: 'thread', is_read: true };
    const reply = {
      ...root,
      id: '22222222-2222-4222-8222-222222222222',
      uid: 11,
      message_id: '<reply@example.test>',
      in_reply_to: root.message_id,
      thread_references: root.message_id,
      is_read: false,
    };
    const snoozedRows = [
      {
        snooze_id: 's1',
        user_id: 'u1',
        account_id: ACCOUNT_ID,
        message_id_header: root.message_id,
        original_folder: 'INBOX',
        snoozed_folder: 'Snoozed',
        uid: 10,
        is_read: true,
      },
      {
        snooze_id: 's2',
        user_id: 'u1',
        account_id: ACCOUNT_ID,
        message_id_header: reply.message_id,
        original_folder: 'INBOX',
        snoozed_folder: 'Snoozed',
        uid: 11,
        is_read: false,
      },
    ];
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT m.*, a.user_id FROM messages')) return { rows: [root] };
      if (sql.includes('WHERE account_id = $1 AND thread_id = $2')) return { rows: [root, reply] };
      if (sql.includes('FROM snoozed_messages sm')) return { rows: snoozedRows };
      if (sql.includes('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });
    imapManager.moveMessageGetNewUid
      .mockResolvedValueOnce(110)
      .mockResolvedValueOnce(111);

    const res = await del(`/messages/${MSG_ID}/snooze`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restored: 2, folder: 'INBOX' });
    expect(imapManager.moveMessageGetNewUid).toHaveBeenCalledTimes(2);
    expect(imapManager.setFlag).not.toHaveBeenCalled();
  });
});
