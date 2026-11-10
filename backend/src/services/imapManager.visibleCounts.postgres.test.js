import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
import { query } from './db.js';
import { ImapManager, createKeyedSemaphore } from './imapManager.js';

import { pluginRegistry } from '../plugins/registry.js';

// Synthetic, connection-local tables only; no default database connection.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('integrity deletion visible counts', () => {
  afterEach(() => vi.restoreAllMocks());
  it('integrity deletion preserves the count of visible rows when a soft-deleted UID survives', async () => {
    const db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    try {
      await db.query(`CREATE TEMP TABLE folders(account_id text, path text, uid_validity text, total_count integer, unread_count integer,
        status_synced_uid_next bigint, status_synced_uid_validity text, status_synced_modseq text, status_synced_at timestamptz);
        CREATE TEMP TABLE messages(account_id text, folder text, uid bigint, thread_key text, synced_at timestamptz, is_read boolean, is_deleted boolean);
        CREATE TEMP TABLE unfetchable_uids(account_id text, folder text, uid bigint, attempts integer, last_attempt_at timestamptz, uid_validity text);
        INSERT INTO folders(account_id,path,uid_validity,total_count,unread_count) VALUES('review-a','Sent','8',1,0);
        INSERT INTO messages VALUES('review-a','Sent',1,'gone',null,true,true),
          ('review-a','Sent',2,'live',null,true,false),('review-a','Sent',3,'soft-deleted',null,false,true);`);
      query.mockReset().mockImplementation((sql, params) => db.query(sql, params));
      const client = { mailbox: { exists: 2, uidValidity: 8n }, noop: async () => true,
        getMailboxLock: async () => ({ release() {} }), search: async () => [2,3],
        fetch: async function* () { for (const uid of [2,3]) yield { uid, flags: new Set(uid === 3 ? ['\\Deleted'] : ['\\Seen']) }; } };
      const mgr = Object.assign(Object.create(ImapManager.prototype), {
        broadcast: vi.fn(),
        _withCountClient: async (_account, fn) => fn(client), syncMessages: vi.fn().mockResolvedValue({}),
        _applyFlagUpdates: vi.fn().mockResolvedValue(0), _isMoveUidGuarded: () => false,
        backfillMessages: vi.fn(), _bgConnSem: createKeyedSemaphore(2),
      });
      const hook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
      await mgr._refreshObservedFolder({ id: 'review-a', user_id: 'fixture-u', imap_host: 'imap.example.test' }, 'Sent',
        { uidValidity: 8n, uidNext: 4, highestModseq: 22n });
      expect(hook).toHaveBeenCalledWith('messageRowsDeleted', expect.objectContaining({ folder: 'Sent', threadKeys: ['gone'] }));
      const { rows: [counts] } = await db.query('SELECT total_count, unread_count FROM folders');
      expect(counts).toEqual({ total_count: 1, unread_count: 0 });
    } finally { await db.end(); }
  });
});
