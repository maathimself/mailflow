import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); },
}));

import routes from './search.js';
import { query } from '../services/db.js';

// Real Postgres execution of the threaded search CTE against a connection-local temp schema.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('threaded search PostgreSQL', () => {
  let database;
  let server;
  let base;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (
        id text, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text,
        imap_host text, folder_mappings jsonb DEFAULT '{}'::jsonb
      );
      CREATE TEMP TABLE folders (
        account_id text, path text, special_use text, name text,
        delimiter text DEFAULT '/', no_select boolean DEFAULT false
      );
      CREATE TEMP TABLE contacts (
        id text, user_id text, primary_email text, photo_data bytea
      );
      CREATE TEMP TABLE messages (
        id text, account_id text DEFAULT 'main', folder text DEFAULT 'INBOX',
        uid bigint, message_id text, provider_msgid text, subject text, from_name text, from_email text,
        to_addresses jsonb DEFAULT '[]'::jsonb, cc_addresses jsonb DEFAULT '[]'::jsonb,
        reply_to jsonb DEFAULT '[]'::jsonb, delivery_addresses jsonb DEFAULT '[]'::jsonb,
        thread_id text, thread_key text GENERATED ALWAYS AS (COALESCE(thread_id, id::text)) STORED,
        in_reply_to text, thread_references text,
        date timestamptz, snippet text, is_read boolean DEFAULT true,
        is_starred boolean DEFAULT false, has_attachments boolean DEFAULT false,
        is_deleted boolean DEFAULT false, flags jsonb DEFAULT '[]'::jsonb,
        search_vector tsvector, body_text text
      );
      CREATE TEMP TABLE message_search (
        message_id text PRIMARY KEY,
        body_text text NOT NULL
      );

      INSERT INTO email_accounts (id, user_id, enabled, include_in_unified_inbox, name, email_address)
      VALUES ('main', 'owner', true, true, 'Primary', 'owner@example.test');

      INSERT INTO folders (account_id, path, special_use, name) VALUES
        ('main', 'INBOX', NULL, 'INBOX'),
        ('main', 'Sent', '\\Sent', 'Sent'),
        ('main', 'Drafts', '\\Drafts', 'Drafts'),
        ('main', 'Trash', '\\Trash', 'Trash');

      -- Thread 1: root in INBOX + reply in Sent (plus an unsent Draft that must NOT inflate count)
      INSERT INTO messages (id, account_id, folder, uid, message_id, thread_id, subject, from_name, from_email, date, snippet, is_read, body_text)
      VALUES
        ('m1', 'main', 'INBOX', 1, '<t1-1@ex>', '<t1@ex>', 'Contract Review', 'Alice', 'alice@example.test', '2026-06-01T10:00:00Z', 'Contract attached', true, 'Please review the contract'),
        ('m2', 'main', 'Sent',  2, '<t1-2@ex>', '<t1@ex>', 'Re: Contract Review', 'Me', 'owner@example.test', '2026-06-02T10:00:00Z', 'Signed contract', false, 'Returning the contract'),
        ('m3', 'main', 'Drafts', 3, '<t1-d@ex>', '<t1@ex>', 'Re: Contract Review', 'Me', 'owner@example.test', '2026-06-03T10:00:00Z', 'Draft note', true, 'Unsent contract draft');

      -- Thread 2: same Message-ID in both INBOX and Archive, plus newer Trash copy excluded in all-folder search
      INSERT INTO messages (id, account_id, folder, uid, message_id, thread_id, subject, from_name, from_email, date, snippet, is_read, body_text)
      VALUES
        ('m4-inb',  'main', 'INBOX',   4, '<t2-1@ex>', '<t2@ex>', 'Older Contract', 'Bob', 'bob@example.test', '2026-05-01T10:00:00Z', 'Old contract', false, 'contract details'),
        ('m4-arch', 'main', 'Archive', 5, '<t2-1@ex>', '<t2@ex>', 'Older Contract', 'Bob', 'bob@example.test', '2026-05-01T10:00:00Z', 'Old contract', false, 'contract details');

      -- Thread 3: draft-only thread still appears when searched in Drafts (or matching unique word)
      INSERT INTO messages (id, account_id, folder, uid, message_id, thread_id, subject, from_name, from_email, date, snippet, is_read, body_text)
      VALUES
        ('m5-draft', 'main', 'Drafts', 6, '<t3-d@ex>', '<t3@ex>', 'Solo Draft', 'Me', 'owner@example.test', '2026-06-04T10:00:00Z', 'Draft proposal', true, 'solo draft proposal');
    `);

    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use(routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });

  it('groups matching threads, prefers INBOX on dedupe, and excludes drafts from message_count', async () => {
    const res = await fetch(`${base}/?q=contract&threaded=true`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threaded).toBe(true);
    expect(data.messages.map(m => m.thread_id)).toEqual(['<t1@ex>', '<t2@ex>']);

    const t1 = data.messages[0];
    expect(t1.id).toBe('m2');
    expect(t1.subject).toBe('Contract Review');
    expect(t1.from_name).toBe('Alice');
    expect(t1.reply_from_name).toBe('Me');
    expect(t1.message_count).toBe(2);
    expect(t1.unread_count).toBe(1);
    expect(t1.thread_folder).toBe('INBOX');

    const t2 = data.messages[1];
    expect(t2.id).toBe('m4-inb');
    expect(t2.folder).toBe('INBOX');
    expect(t2.message_count).toBe(1);
    expect(t2.unread_count).toBe(1);
  });

  it('still returns ungrouped flat rows when threaded=true is absent', async () => {
    const res = await fetch(`${base}/?q=contract`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threaded).toBeUndefined();
    expect(data.messages.length).toBeGreaterThanOrEqual(4);
  });

  it('retains a draft-only thread when it matches search criteria', async () => {
    const res = await fetch(`${base}/?q=proposal&threaded=true`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages.map(m => m.id)).toEqual(['m5-draft']);
    expect(data.messages[0].message_count).toBe(1);
  });
});
