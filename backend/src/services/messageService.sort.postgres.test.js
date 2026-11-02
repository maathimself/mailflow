import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { prefetchFolderBodies: async () => {} } }));
import express from 'express';
import { query } from './db.js';
import { listMessages } from './messageService.js';
import mailRoutes from '../routes/mail.js';

// #528 list orders and #196 starred on top. Uses only connection-local temporary tables in an
// explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('list sort PostgreSQL', () => {
  let database, server, base;
  const account = '22222222-2222-4222-8222-222222222222';
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
        spam_user_override text, spam_score_ml real, flags jsonb, unsubscribed_at timestamptz,
        normalized_subject text GENERATED ALWAYS AS (
          lower(trim(regexp_replace(coalesce(subject, ''), '^(re|fw|fwd)[[:space:]]*:[[:space:]]*', '', 'i')))
        ) STORED);
      CREATE TEMP TABLE contacts (id uuid, user_id text, primary_email text, photo_data text)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts, contacts');
    await database.query(
      "INSERT INTO email_accounts VALUES ($1,'owner',true,true,'Work','me@example.com','#123456',NULL)",
      [account],
    );
    await database.query("INSERT INTO folders(account_id,path,name,total_count) VALUES ($1,'INBOX','INBOX',100)", [account]);
  });

  const insert = ({ subject, fromName = null, fromEmail = 'x@example.com', date, starred = false, thread = null, folder = 'INBOX' }) =>
    database.query(
      `INSERT INTO messages(id,account_id,folder,message_id,thread_id,thread_key,date,subject,from_name,from_email,is_starred)
       VALUES ($1,$2,$3,$4,$5,$5,$6::timestamptz,$7,$8,$9,$10)`,
      [id(), account, folder, `<${nextId}@t>`, thread ?? `<t${nextId}@t>`, date, subject, fromName, fromEmail, starred],
    );
  const subjects = async (opts) => (await listMessages({ userId: 'owner', accountId: account, folder: 'INBOX', ...opts }))
    .messages.map(m => m.subject);

  const seedFlat = async () => {
    await insert({ subject: 'Re: banana', fromName: 'Carol', date: '2026-10-03T10:00Z' });
    await insert({ subject: 'apple', fromName: null, fromEmail: 'bob@example.com', date: '2026-10-01T10:00Z' });
    await insert({ subject: 'Cherry', fromName: 'alice', date: '2026-10-02T10:00Z' });
  };

  it('keeps newest first when no order is given', async () => {
    await seedFlat();
    expect(await subjects({})).toEqual(['Re: banana', 'Cherry', 'apple']);
  });

  it('sorts by date oldest first', async () => {
    await seedFlat();
    expect(await subjects({ sort: 'date', dir: 'asc' })).toEqual(['apple', 'Cherry', 'Re: banana']);
  });

  it('sorts by sender name, or the address without one, ignoring case', async () => {
    await seedFlat();
    expect(await subjects({ sort: 'from', dir: 'asc' })).toEqual(['Cherry', 'apple', 'Re: banana']);
    expect(await subjects({ sort: 'from', dir: 'desc' })).toEqual(['Re: banana', 'apple', 'Cherry']);
  });

  it('sorts by subject without its Re: prefix, ignoring case', async () => {
    await seedFlat();
    expect(await subjects({ sort: 'subject', dir: 'asc' })).toEqual(['apple', 'Re: banana', 'Cherry']);
    expect(await subjects({ sort: 'subject', dir: 'desc' })).toEqual(['Cherry', 'Re: banana', 'apple']);
  });

  it('puts mail with no sender or subject last in either direction', async () => {
    await seedFlat();
    await insert({ subject: '', fromName: '', fromEmail: '', date: '2026-10-09T10:00Z' });
    for (const dir of ['asc', 'desc']) {
      expect((await subjects({ sort: 'from', dir })).at(-1)).toBe('');
      expect((await subjects({ sort: 'subject', dir })).at(-1)).toBe('');
    }
  });

  it('pages equal sort keys without repeating or skipping a message', async () => {
    for (let i = 0; i < 7; i++) await insert({ subject: `s${i}`, fromName: 'Same', date: '2026-10-01T10:00Z' });
    const seen = [];
    for (let offset = 0; offset < 7; offset += 2) {
      seen.push(...await subjects({ sort: 'from', dir: 'asc', limit: 2, offset }));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('puts starred mail on top, each part in the chosen order', async () => {
    await seedFlat();
    await insert({ subject: 'zebra', fromName: 'Zed', date: '2026-09-01T10:00Z', starred: true });
    await insert({ subject: 'yak', fromName: 'Yan', date: '2026-10-04T10:00Z', starred: true });
    expect(await subjects({ starredFirst: 'true' })).toEqual(['yak', 'zebra', 'Re: banana', 'Cherry', 'apple']);
    expect(await subjects({ starredFirst: 'true', sort: 'subject', dir: 'asc' }))
      .toEqual(['yak', 'zebra', 'apple', 'Re: banana', 'Cherry']);
  });

  describe('conversations', () => {
    const seedThreads = async () => {
      // Thread A: opened by Zoe ("Budget"), latest reply from Adam.
      await insert({ subject: 'Budget', fromName: 'Zoe', date: '2026-10-01T10:00Z', thread: 'A' });
      await insert({ subject: 'Re: Budget', fromName: 'Adam', date: '2026-10-05T10:00Z', thread: 'A' });
      // Thread B: one message from Mia, "agenda".
      await insert({ subject: 'agenda', fromName: 'Mia', date: '2026-10-03T10:00Z', thread: 'B' });
      // Thread C: one message from Bea, "Zoning".
      await insert({ subject: 'Zoning', fromName: 'Bea', date: '2026-10-02T10:00Z', thread: 'C' });
    };
    const threads = async (opts) => (await listMessages({ userId: 'owner', accountId: account, folder: 'INBOX', threaded: 'true', ...opts }))
      .messages.map(m => m.thread_id);

    it('keeps the latest activity first by default', async () => {
      await seedThreads();
      expect(await threads({})).toEqual(['A', 'B', 'C']);
      expect(await threads({ sort: 'date', dir: 'asc' })).toEqual(['C', 'B', 'A']);
    });

    it('sorts by the sender and subject the row shows: the opener\'s', async () => {
      await seedThreads();
      expect(await threads({ sort: 'from', dir: 'asc' })).toEqual(['C', 'B', 'A']);
      expect(await threads({ sort: 'subject', dir: 'asc' })).toEqual(['B', 'A', 'C']);
      expect(await threads({ sort: 'subject', dir: 'desc' })).toEqual(['C', 'A', 'B']);
    });

    it('pages in the same order', async () => {
      await seedThreads();
      const first = await threads({ sort: 'subject', dir: 'asc', limit: 2, offset: 0 });
      const second = await threads({ sort: 'subject', dir: 'asc', limit: 2, offset: 2 });
      expect([...first, ...second]).toEqual(['B', 'A', 'C']);
    });

    it('puts a conversation holding a starred message on top', async () => {
      await seedThreads();
      await database.query("UPDATE messages SET is_starred = true WHERE subject = 'Zoning'");
      expect(await threads({ starredFirst: 'true' })).toEqual(['C', 'A', 'B']);
    });
  });

  it('refuses an unknown sort or direction', async () => {
    await seedFlat();
    expect((await fetch(`${base}/api/mail/messages?accountId=${account}&sort=size`)).status).toBe(400);
    expect((await fetch(`${base}/api/mail/messages?accountId=${account}&sort=from&dir=up`)).status).toBe(400);
    const ok = await fetch(`${base}/api/mail/messages?accountId=${account}&sort=subject&dir=asc`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).messages.map(m => m.subject)).toEqual(['apple', 'Re: banana', 'Cherry']);
  });
});
