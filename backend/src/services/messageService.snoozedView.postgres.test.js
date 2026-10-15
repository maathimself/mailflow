import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { listMessages } from './messageService.js';

// The all-accounts Snoozed view lists the folder named Snoozed and, where the server put Snoozed
// under a namespace prefix, each message whose own snooze record names the folder it is in. The
// count is built in SQL that listMessages turns into 0 if it fails, so it is checked here against
// PostgreSQL. Uses only connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('all-accounts Snoozed view PostgreSQL', () => {
  let database;
  const plain = '33333333-3333-4333-8333-333333333333';
  const prefixed = '44444444-4444-4444-8444-444444444444';
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text,
        folder_mappings jsonb);
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, delimiter text,
        special_use text, total_count integer DEFAULT 0, unread_count integer DEFAULT 0);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, delivery_addresses jsonb, spam_verdict text,
        spam_user_override text, spam_score_ml real, flags jsonb, unsubscribed_at timestamptz);
      CREATE TEMP TABLE contacts (id uuid, user_id text, primary_email text, photo_data text);
      CREATE TEMP TABLE snoozed_messages (account_id uuid, message_id_header text,
        original_folder text, snoozed_folder text, snooze_until timestamptz)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => {
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts, contacts, snoozed_messages');
    // The view takes in every enabled account, the one left out of All Inboxes too.
    await database.query(
      `INSERT INTO email_accounts VALUES
        ($1,'owner',true,true,'Plain','plain@example.com','#111111',NULL),
        ($2,'owner',true,false,'Prefixed','prefixed@example.com','#222222',NULL)`,
      [plain, prefixed],
    );
    // Snoozed is a folder of that name on one server and INBOX.Snoozed on the other. The plain
    // account also has an INBOX.Snoozed of its own, which is where none of its snoozes went.
    await folder(plain, 'Snoozed', 2, 1);
    await folder(prefixed, 'INBOX.Snoozed', 3, 2);
    await folder(plain, 'INBOX.Snoozed', 1, 1);
    await message(plain, 'Snoozed', '<p1@x>', false);
    await message(plain, 'Snoozed', '<p2@x>', true);
    await message(prefixed, 'INBOX.Snoozed', '<s1@x>', false);
    await message(prefixed, 'INBOX.Snoozed', '<s2@x>', true);
    await message(prefixed, 'INBOX.Snoozed', '<filed@x>', false);
    await message(plain, 'INBOX.Snoozed', '<other@x>', false);
    await snooze(plain, '<p1@x>', 'Snoozed', '2026-10-20T08:00Z');
    await snooze(plain, '<p2@x>', 'Snoozed', '2026-10-22T08:00Z');
    await snooze(prefixed, '<s1@x>', 'INBOX.Snoozed', '2026-10-15T08:00Z');
    await snooze(prefixed, '<s2@x>', 'INBOX.Snoozed', '2026-10-21T08:00Z');
  });

  const folder = (account, path, total, unread) => database.query(
    'INSERT INTO folders(account_id,path,name,delimiter,total_count,unread_count) VALUES ($1,$2,$2,$3,$4,$5)',
    [account, path, path.includes('.') ? '.' : '/', total, unread],
  );
  const message = (account, path, messageId, isRead) => database.query(
    `INSERT INTO messages(id,account_id,folder,message_id,thread_id,thread_key,date,subject,is_read)
     VALUES ($1,$2,$3,$4,$4,$4,'2026-10-10T10:00Z',$4,$5)`,
    [id(), account, path, messageId, isRead],
  );
  const snooze = (account, messageId, path, until) => database.query(
    `INSERT INTO snoozed_messages(account_id,message_id_header,original_folder,snoozed_folder,snooze_until)
     VALUES ($1,$2,'INBOX',$3,$4)`,
    [account, messageId, path, until],
  );

  it('lists snoozed mail in both kinds of folder, soonest back first, and counts it', async () => {
    const { messages, total } = await listMessages({ userId: 'owner', folder: 'Snoozed' });

    expect(messages.map(m => [m.message_id, m.snoozed_folder])).toEqual([
      ['<s1@x>', 'INBOX.Snoozed'],
      ['<p1@x>', 'Snoozed'],
      ['<s2@x>', 'INBOX.Snoozed'],
      ['<p2@x>', 'Snoozed'],
    ]);
    // The folder named Snoozed by its count (2), the INBOX.Snoozed mail by its snoozed rows (2),
    // not by that folder's count, which takes in mail filed there by hand.
    expect(total).toBe(4);
  });

  it('counts only unread snoozed mail when the view is unread only', async () => {
    const { messages, total } = await listMessages({ userId: 'owner', folder: 'Snoozed', unreadOnly: 'true' });

    expect(messages.map(m => m.message_id)).toEqual(['<s1@x>', '<p1@x>']);
    expect(total).toBe(2);
  });
});
