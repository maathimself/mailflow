import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { listMessages } from './messageService.js';

// #611: with a category tab open, the flat list's total counts that category's mail, not the
// folder's, so paging and "Load more" end where the rows do. Uses only connection-local
// temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('flat list total under a category filter PostgreSQL', () => {
  let database;
  const account = '33333333-3333-4333-8333-333333333333';
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
      CREATE TEMP TABLE contacts (id uuid, user_id text, primary_email text, photo_data text)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });

  // 100 Inbox messages, 3 of them in Promotions (1 unread); the folder's own counts say 100 and 10.
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts, contacts');
    await database.query(
      "INSERT INTO email_accounts VALUES ($1,'owner',true,true,'Work','me@example.com','#123456',NULL)",
      [account],
    );
    await database.query(
      "INSERT INTO folders(account_id,path,name,delimiter,total_count,unread_count) VALUES ($1,'INBOX','INBOX','/',100,10)",
      [account],
    );
    for (let i = 0; i < 100; i += 1) {
      const key = `<m${i}@ext>`;
      await database.query(
        `INSERT INTO messages(id,account_id,folder,uid,message_id,thread_id,thread_key,date,subject,is_read,category)
         VALUES ($1,$2,'INBOX',$3,$4,$4,$4,$5,$6,$7,$8)`,
        [id(), account, i + 1, key, new Date(Date.UTC(2026, 9, 1, 0, i)), `Message ${i}`, i >= 10, i < 3 ? 'promotions' : null],
      );
    }
    await database.query("UPDATE messages SET is_read = true WHERE category = 'promotions' AND uid <> 1");
  });

  for (const scope of ['account', 'unified']) {
    const accountId = scope === 'account' ? account : undefined;
    const list = (opts) => listMessages({ userId: 'owner', accountId, folder: 'INBOX', limit: 50, ...opts });

    it(`counts the category's rows, not the folder's (${scope} Inbox)`, async () => {
      const page = await list({ category: 'promotions' });
      expect(page.messages).toHaveLength(3);
      expect(page.total).toBe(3);
      const unread = await list({ category: 'promotions', unreadOnly: 'true' });
      expect(unread.messages).toHaveLength(1);
      expect(unread.total).toBe(1);
    });

    it(`keeps the folder's counts without a category (${scope} Inbox)`, async () => {
      expect((await list({})).total).toBe(100);
      expect((await list({ unreadOnly: 'true' })).total).toBe(10);
    });

    it(`threaded totals are unchanged (${scope} Inbox)`, async () => {
      expect((await list({ category: 'promotions', threaded: 'true' })).total).toBe(3);
    });
  }
});
