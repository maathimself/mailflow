import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), parseMailboxList: () => [{ email: 'bcc@example.test' }] }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));

import { ImapManager } from './imapManager.js';
import { query } from './db.js';
import { parseMessage } from './messageParser.js';

// An explicit test database is required. All tables are connection-local temporary
// tables, so this suite neither uses nor modifies existing application tables.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('draft ingestion SQL identity boundaries', () => {
  let database;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE folders (account_id text, path text, uid_validity bigint);
      CREATE TEMP TABLE messages (
        id text DEFAULT 'draft-row', account_id text, uid bigint, folder text,
        message_id text, subject text, from_name text, from_email text,
        to_addresses jsonb, cc_addresses jsonb, bcc_addresses jsonb,
        in_reply_to text, thread_references text, thread_id text,
        date timestamptz, flags jsonb, has_attachments boolean, attachments jsonb,
        is_read boolean, is_deleted boolean DEFAULT false, body_html text, body_text text,
        UNIQUE(account_id, uid, folder)
      )`);
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders');
    query.mockReset().mockImplementation((sql, values) => database.query(sql, values));
  });

  const cases = [
    { name: 'same identity and generation retain a canonical root and cached body', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '9', current: 9n, oldRoot: '<retained@example.test>', root: '<retained@example.test>', keep: true },
    { name: 'same identity upgrades a self-rooted provisional thread', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '9', current: 9n, oldRoot: '<draft@example.test>', root: '<computed@example.test>', keep: true },
    { name: 'replacement Message-ID recomputes the root and clears the body', oldId: '<old@example.test>', newId: '<draft@example.test>', stored: '9', current: 9n, root: '<computed@example.test>' },
    { name: 'missing new Message-ID clears the old root and body', oldId: '<old@example.test>', newId: null, stored: '9', current: 9n, root: null },
    { name: 'missing stored identity cannot retain a cached body or root', oldId: null, newId: '<draft@example.test>', stored: '9', current: 9n, root: '<computed@example.test>' },
    { name: 'matching empty identities cannot retain a cached body or root', oldId: '', newId: '', stored: '9', current: 9n, root: null },
    { name: 'changed mailbox generation recomputes the root and clears the body', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '8', current: 9n, root: '<computed@example.test>' },
    { name: 'unknown stored generation cannot retain the body or root', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: null, current: 9n, root: '<computed@example.test>' },
    { name: 'unknown live generation cannot retain the body or root', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: '9', current: undefined, root: '<computed@example.test>' },
    { name: 'missing folder generation cannot retain the body or root', oldId: '<draft@example.test>', newId: '<draft@example.test>', stored: undefined, current: 9n, root: '<computed@example.test>' },
  ];
  it.each(cases)('$name', async ({ oldId, newId, stored, current, oldRoot = '<old-root@example.test>', root, keep }) => {
    if (stored !== undefined) await database.query('INSERT INTO folders VALUES ($1,$2,$3)', ['account-a', 'Drafts', stored]);
    await database.query(`INSERT INTO messages(account_id, uid, folder, message_id, thread_id, body_html, body_text)
      VALUES ('account-a',1,'Drafts',$1,$2,'<p>Cached</p>','Cached'),
        ('account-a',2,'Sent','<known@example.test>','<computed@example.test>',null,null)`, [oldId, oldRoot]);
    parseMessage.mockResolvedValueOnce({ messageId: newId, fromEmail: 'me@example.test', subject: 'Fresh subject',
      to: [], cc: [], inReplyTo: '<known@example.test>', references: '<known@example.test>',
      parsedHeaders: { bcc: 'bcc@example.test' }, flags: [], hasAttachments: false });
    const manager = Object.create(ImapManager.prototype);
    const metadata = await manager._ingestDraftUidWithClient({ id: 'account-a', email_address: 'me@example.test' }, 'Drafts', 1,
      { mailbox: { uidValidity: current } }, { headers: Buffer.from('headers'), bodyStructure: { type: 'text/plain' } });
    const persisted = (await database.query("SELECT * FROM messages WHERE folder='Drafts'")).rows[0];
    expect(metadata.thread_id).toBe(root);
    expect(persisted.thread_id).toBe(root);
    expect(persisted.body_html).toBe(keep ? '<p>Cached</p>' : null);
    expect(persisted.body_text).toBe(keep ? 'Cached' : null);
    expect(persisted.message_id).toBe(newId);
    expect(persisted.subject).toBe('Fresh subject');
    expect(persisted.bcc_addresses).toEqual([{ email: 'bcc@example.test' }]);
    expect((await database.query('SELECT uid_validity FROM folders')).rows[0]?.uid_validity).toBe(stored);
  });
});
