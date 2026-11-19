import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({
  imapManager: {
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
    bulkMoveMessages: vi.fn(async (_acct, uids) => ({ uidMap: new Map(), succeeded: uids, failed: [] })),
    broadcast: vi.fn(),
    pluginFacade: {},
    syncFolderOnDemand: vi.fn(async () => {}),
  },
}));
import express from 'express';
import { query } from './db.js';
import { listMessages } from './messageService.js';
import mailRoutes from '../routes/mail.js';

// #576: the threaded Inbox badge counts the whole thread, Sent replies included, so it matches
// what the thread route loads. Uses only connection-local temporary tables in an explicitly
// supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('threaded Inbox message_count PostgreSQL', () => {
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
        special_use text, no_select boolean NOT NULL DEFAULT false,
        total_count integer DEFAULT 0, unread_count integer DEFAULT 0);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, delivery_addresses jsonb, spam_verdict text,
        spam_user_override text, spam_score_ml real, flags jsonb, unsubscribed_at timestamptz);
      CREATE TEMP TABLE contacts (id uuid, user_id text, primary_email text, photo_data text);
      CREATE TEMP TABLE sent_inbox_dismissed (account_id uuid, thread_key text, dismissed_at timestamptz DEFAULT now(), PRIMARY KEY (account_id, thread_key))`);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use(express.json());
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, folders, email_accounts, contacts, sent_inbox_dismissed');
    await database.query(
      "INSERT INTO email_accounts VALUES ($1,'owner',true,true,'Work','me@example.com','#123456',NULL)",
      [account],
    );
  });

  const insert = (folder, messageId, threadKey, date, subject, flags = null) => database.query(
    `INSERT INTO messages(id,account_id,folder,message_id,thread_id,thread_key,date,subject,flags)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)`,
    [id(), account, folder, messageId, threadKey, date, subject, flags && JSON.stringify(flags)],
  );
  const folder = (path, { name = path, specialUse = null, delimiter = '/' } = {}) => database.query(
    'INSERT INTO folders(account_id,path,name,delimiter,special_use) VALUES ($1,$2,$3,$4,$5)',
    [account, path, name, delimiter, specialUse],
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

  it('keeps the oldest display sender and the latest physical reply sender', async () => {
    await insert('INBOX', '<old@example.test>', '<thread@example.test>', '2026-10-01T10:00Z', 'Question');
    await insert('INBOX', '<latest@example.test>', '<thread@example.test>', '2026-10-01T11:00Z', 'Re: Question');
    await database.query(`UPDATE messages SET
      from_email = CASE WHEN message_id = '<old@example.test>' THEN 'owner@example.test' ELSE 'sender@example.test' END,
      from_name = CASE WHEN message_id = '<old@example.test>' THEN 'Oldest' ELSE 'Latest' END,
      reply_to = '[{"email":"reply@example.test"}]'::jsonb`);
    const row = (await inboxRows(account))['<thread@example.test>'];
    expect(row.from_email).toBe('owner@example.test');
    expect(row.from_name).toBe('Oldest');
    expect(row.reply_from_email).toBe('sender@example.test');
    expect(row.reply_from_name).toBe('Latest');
    expect(row.subject).toBe('Question');
    expect(row.reply_subject).toBe('Re: Question');
    expect(row.message_id).toBe('<latest@example.test>');
    expect(row.reply_to).toEqual([{ email: 'reply@example.test' }]);
  });

  // A count of 2 makes the row a conversation, and deleting a conversation expunges its drafts:
  // a saved reply must not turn a lone message into one.
  it('does not count a saved reply draft, by its \\Draft flag', async () => {
    await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
    await insert('Drafts', '<d@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question', ['\\Draft', '\\Seen']);
    expect((await inboxRows(account))['<a@ext>'].message_count).toBe(1);
    expect((await inboxRows(undefined))['<a@ext>'].message_count).toBe(1);
  });

  it('does not count an unflagged draft in the special-use, stock-named or mapped Drafts folder', async () => {
    await folder('[Gmail]/Entwürfe', { name: 'Entwürfe', specialUse: '\\Drafts' });
    await folder('Drafts');
    await folder('Brouillons');
    await database.query(`UPDATE email_accounts SET folder_mappings = '{"drafts":"Brouillons"}'`);
    await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
    await insert('[Gmail]/Entwürfe', '<d1@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');
    await insert('Drafts', '<d2@me>', '<a@ext>', '2026-10-01T11:01Z', 'Re: Question');
    await insert('Brouillons', '<d3@me>', '<a@ext>', '2026-10-01T11:02Z', 'Re: Question');
    expect((await inboxRows(account))['<a@ext>'].message_count).toBe(1);
  });

  it('still counts a message in a user folder that merely has "drafts" in its name', async () => {
    await folder('Clients/Drafts', { name: 'Drafts' });
    await folder('Blog drafts');
    await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
    await insert('Clients/Drafts', '<b@ext>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');
    await insert('Blog drafts', '<c@ext>', '<a@ext>', '2026-10-01T12:00Z', 'Re: Question');
    expect((await inboxRows(account))['<a@ext>'].message_count).toBe(3);
  });

  it('counts the Sent reply but not the draft beside it', async () => {
    await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
    await insert('Sent', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question', ['\\Seen']);
    await insert('Drafts', '<d@me>', '<a@ext>', '2026-10-01T12:00Z', 'Re: Question', ['\\Draft']);
    expect((await inboxRows(account))['<a@ext>'].message_count).toBe(2);
  });

  // The thread route marks drafts, so deleting or moving the conversation can spare them.
  it('marks drafts in the thread route, by flag and by folder', async () => {
    await folder('Brouillons');
    await database.query(`UPDATE email_accounts SET folder_mappings = '{"drafts":"Brouillons"}'`);
    await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
    await insert('Sent', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question', ['\\Seen']);
    await insert('Drafts', '<d1@me>', '<a@ext>', '2026-10-01T12:00Z', 'Re: Question', ['\\Draft']);
    await insert('Brouillons', '<d2@me>', '<a@ext>', '2026-10-01T13:00Z', 'Re: Question');
    const response = await fetch(`${base}/api/mail/thread?id=${encodeURIComponent('<a@ext>')}`);
    expect(response.status).toBe(200);
    const { messages } = await response.json();
    expect(messages.map(m => [m.folder, m.is_draft])).toEqual([
      ['INBOX', false], ['Sent', false], ['Drafts', true], ['Brouillons', true],
    ]);
  });

  it('does not count deleted messages', async () => {
    await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
    await insert('Sent', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');
    await database.query("UPDATE messages SET is_deleted = true WHERE message_id = '<b@me>'");

    expect((await inboxRows(account))['<a@ext>'].message_count).toBe(1);
  });

  describe('includeSent=true in Inbox', () => {
    const inboxWithSentRows = async (accountId, includeSent = true) => {
      const result = await listMessages({ userId: 'owner', accountId, folder: 'INBOX', threaded: true, includeSent });
      return Object.fromEntries(result.messages.map(row => [row.thread_id, row]));
    };

    it('includes Sent follow-ups on Inbox threads and Sent-initiated threads with recipient metadata', async () => {
      await folder('INBOX');
      await folder('Sent', { specialUse: '\\Sent' });
      await insert('INBOX', '<a@ext>', '<a@ext>', '2026-10-01T10:00Z', 'Question');
      await insert('Sent', '<b@me>', '<a@ext>', '2026-10-01T11:00Z', 'Re: Question');
      await insert('Sent', '<s1@me>', '<s1@me>', '2026-10-01T12:00Z', 'Proposal');
      await database.query(
        `UPDATE messages SET uid = 11, from_email = 'alice@ext.test', from_name = 'Alice', to_addresses = '[{"email":"me@example.com"}]'::jsonb WHERE message_id = '<a@ext>';
         UPDATE messages SET uid = 12, from_email = 'me@example.com', from_name = 'Me', snippet = 'my reply', in_reply_to = '<a@ext>' WHERE message_id = '<b@me>';
         UPDATE messages SET uid = 13, from_email = 'me@example.com', from_name = 'Me', to_addresses = '[{"name":"Bob","email":"bob@ext.test"}]'::jsonb, snippet = 'initial outreach' WHERE message_id = '<s1@me>';`
      );

      const rows = await inboxWithSentRows(account, true);
      expect(rows['<a@ext>'].thread_folder).toBe('INBOX');
      expect(rows['<a@ext>'].reply_from_name).toBe('Me');
      expect(rows['<a@ext>'].snippet).toBe('my reply');
      expect(rows['<a@ext>'].message_count).toBe(2);

      expect(rows['<s1@me>']).toBeDefined();
      expect(rows['<s1@me>'].thread_folder).toBe('Sent');
      expect(rows['<s1@me>'].thread_to_addresses).toEqual([{ name: 'Bob', email: 'bob@ext.test' }]);

      // Follow-up from Sent advances date & count before any external reply arrives
      await insert('Sent', '<s2@me>', '<s1@me>', '2026-10-01T13:00Z', 'Re: Proposal');
      await database.query(
        `UPDATE messages SET uid = 14, in_reply_to = '<s1@me>', snippet = 'pinging you' WHERE message_id = '<s2@me>'`
      );
      const afterFollowUp = await inboxWithSentRows(account, true);
      expect(afterFollowUp['<s1@me>'].message_count).toBe(2);
      expect(afterFollowUp['<s1@me>'].snippet).toBe('pinging you');

      // Disabled toggle keeps Sent-only thread out of Inbox
      const withoutSent = await inboxWithSentRows(account, false);
      expect(withoutSent['<s1@me>']).toBeUndefined();
    });

    it('never resurrects archived/trashed threads, orphan Sent replies, or Gmail All-Mail archived threads until a new INBOX reply lands', async () => {
      await folder('INBOX');
      await folder('Sent', { specialUse: '\\Sent' });
      await folder('[Gmail]/All Mail', { name: 'All Mail', specialUse: '\\All' });

      // 1. Orphan Sent reply (Inbox copy gone externally, Sent reply has in_reply_to)
      await insert('Sent', '<orphan@me>', '<gone@ext>', '2026-10-01T08:00Z', 'Re: Gone');
      await database.query(`UPDATE messages SET in_reply_to = '<gone@ext>' WHERE message_id = '<orphan@me>'`);

      // 2. Sent-initiated thread whose external reply was moved to Trash
      await insert('Sent', '<trashed@me>', '<trashed@me>', '2026-10-01T09:00Z', 'Trashed thread');
      await insert('Trash', '<tr@ext>', '<trashed@me>', '2026-10-01T10:00Z', 'Re: Trashed thread');

      // 3. Sent-initiated thread whose INBOX reply gets archived via Gmail All Mail
      await insert('Sent', '<gm@me>', '<gm@me>', '2026-10-01T11:00Z', 'Proposal');
      await insert('INBOX', '<gm-inb@ext>', '<gm@me>', '2026-10-01T12:00Z', 'Re: Proposal');
      const { rows: [inbRow] } = await database.query(`SELECT id FROM messages WHERE message_id = '<gm-inb@ext>'`);
      await database.query(`UPDATE messages SET uid = 77, in_reply_to = '<gm@me>' WHERE id = $1`, [inbRow.id]);

      const res = await fetch(`${base}/api/mail/messages/bulk-archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [inbRow.id] }),
      });
      expect(res.status).toBe(200);

      const rows = await inboxWithSentRows(undefined, true);
      expect(rows['<gone@ext>']).toBeUndefined();
      expect(rows['<trashed@me>']).toBeUndefined();
      expect(rows['<gm@me>']).toBeUndefined();

      // A new external reply landing in INBOX brings the thread back cleanly
      await insert('INBOX', '<gm-r2@ext>', '<gm@me>', '2026-10-01T14:00Z', 'Re: Proposal');
      const revived = await inboxWithSentRows(undefined, true);
      expect(revived['<gm@me>']).toBeDefined();
      expect(revived['<gm@me>'].message_count).toBe(2);
    });
  });
});
