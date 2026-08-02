import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    prefetchFolderBodies: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/gtdSections.js', () => ({
  emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import mailRoutes from './mail.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIMED_ID = '11111111-1111-4111-8111-111111111111';
const UNCLAIMED_ID = '22222222-2222-4222-8222-222222222222';

function row(id, folder) {
  return {
    id,
    account_id: ACCOUNT_ID,
    uid: id === CLAIMED_ID ? 41 : 42,
    folder,
    subject: id === CLAIMED_ID ? 'Claimed draft' : 'Visible message',
    delegation: null,
  };
}

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/api/mail', mailRoutes);
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  imapManager.prefetchFolderBodies.mockClear();
});

function installListQuery({ folder, folderSpecialUse }) {
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('SELECT id, include_in_unified_inbox')) {
      return {
        rows: [{
          id: ACCOUNT_ID,
          include_in_unified_inbox: true,
          folder_mappings: { drafts: 'Drafts' },
        }],
      };
    }
    if (sql.includes('FROM folders WHERE account_id')) {
      return {
        rows: [{ total_count: 2, unread_count: 0, special_use: folderSpecialUse }],
      };
    }
    if (sql.includes('COUNT(*)::int AS total')) {
      return { rows: [{ total: sql.includes('compose_sessions') ? 1 : 2 }] };
    }
    if (sql.includes('FROM messages m')) {
      return {
        rows: sql.includes('compose_sessions')
          ? [row(UNCLAIMED_ID, folder)]
          : [row(CLAIMED_ID, folder), row(UNCLAIMED_ID, folder)],
      };
    }
    throw new Error(`Unexpected query: ${sql} ${JSON.stringify(params)}`);
  });
}

describe('GET /api/mail/messages compose source claims', () => {
  it('filters the owner\'s claimed source tuple from a Drafts-folder response', async () => {
    installListQuery({ folder: 'Drafts', folderSpecialUse: '\\Drafts' });

    const res = await fetch(
      `${base}/api/mail/messages?accountId=${ACCOUNT_ID}&folder=Drafts&limit=25&offset=5`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      messages: [{ id: UNCLAIMED_ID, uid: 42, folder: 'Drafts' }],
      total: 1,
    });
    const claimedQueries = query.mock.calls.filter(([sql]) => sql.includes('compose_sessions'));
    expect(claimedQueries).toHaveLength(2);
    for (const [sql, params] of claimedQueries) {
      expect(sql).toContain('cs.user_id = $3');
      expect(sql).toContain('cs.source_draft_account_id = m.account_id');
      expect(sql).toContain('cs.source_draft_folder = m.folder');
      expect(sql).toContain('cs.source_draft_uid = m.uid');
      expect(params.slice(0, 3)).toEqual([ACCOUNT_ID, 'Drafts', 'user-1']);
    }
  });

  it('does not add compose-claim filtering to a non-Drafts mail response', async () => {
    installListQuery({ folder: 'INBOX', folderSpecialUse: '\\Inbox' });

    const res = await fetch(
      `${base}/api/mail/messages?accountId=${ACCOUNT_ID}&folder=INBOX`,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).messages).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => sql.includes('compose_sessions'))).toBe(false);
  });
});
