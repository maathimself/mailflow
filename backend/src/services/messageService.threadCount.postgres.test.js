import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { listMessages } from './messageService.js';

// #576: the threaded Inbox badge counts the whole thread, Sent replies included, so it matches
// what the thread route loads. Uses only connection-local temporary tables in an explicitly
// supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('threaded Inbox message_count PostgreSQL', () => {
  let database;
  const account = '22222222-2222-4222-8222-222222222222';
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text);
      CREATE TEMP TABLE folders (account_id uuid, path text, total_count integer DEFAULT 0,
        unread_count integer DEFAULT 0);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, delivery_addresses jsonb, spam_verdict text,
        spam_user_override text, spam_score_ml real);
      CREATE TEMP TABLE contacts (id uuid, user_id text, primary_email text, photo_data text)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => {
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts, contacts');
    await database.query(
      "INSERT INTO email_accounts VALUES ($1,'owner',true,true,'Work','me@example.com','#123456')",
      [account],
    );
  });

  const insert = (folder, messageId, threadKey, date, subject) => database.query(
    `INSERT INTO messages(id,account_id,folder,message_id,thread_id,thread_key,date,subject)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`,
    [id(), account, folder, messageId, threadKey, date, subject],
  );

  const inboxRows = async (accountId) => {
    const result = await listMessages({ userId: 'owner', accountId, folder: 'INBOX', threaded: true });
    return Object.fromEntries(result.messages.map(row => [row.thread_id, row]));
  };

  for (const scope of ['account', 'unified']) {
    const accountId = scope === 'account' ? account : undefined;

    it(`counts your Sent reply in a received thread (${scope} Inbox)`, async () => {
      await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
      await insert('Sent', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');

      const row = (await inboxRows(accountId))['<a@ext>'];
      expect(row.message_count).toBe(2);
      // The listed row is still the Inbox message; only the count widens.
      expect(row.folder).toBe('INBOX');
      expect(row.subject).toBe('Question');
    });

    it(`counts a conversation started from MailFlow after the first reply (${scope} Inbox)`, async () => {
      await insert('Sent', '<s@me>', '<s@me>', '2026-10-01T09:00Z', 'Proposal');
      await insert('INBOX', '<r1@ext>', '<s@me>', '2026-10-01T12:00Z', 'Re: Proposal');

      expect((await inboxRows(accountId))['<s@me>'].message_count).toBe(2);
    });

    it(`counts one email once when it sits in several folders (${scope} Inbox)`, async () => {
      await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
      await insert('Archive', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
      await insert('Sent', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');
      await insert('Sent Items', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');

      expect((await inboxRows(accountId))['<a@ext>'].message_count).toBe(2);
    });

    it(`leaves a lone received message at 1 and lists no Sent-only thread (${scope} Inbox)`, async () => {
      await insert('INBOX', '<solo@ext>', '<solo@ext>', '2026-10-01T10:00Z', 'Hello');
      await insert('Sent', '<out@me>', '<out@me>', '2026-10-01T11:00Z', 'Unanswered');

      const rows = await inboxRows(accountId);
      expect(rows['<solo@ext>'].message_count).toBe(1);
      expect(rows['<out@me>']).toBeUndefined();
    });
  }

  it('does not count deleted messages', async () => {
    await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
    await insert('Sent', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');
    await database.query("UPDATE messages SET is_deleted = true WHERE message_id = '<b@me>'");

    expect((await inboxRows(account))['<a@ext>'].message_count).toBe(1);
  });
});
