import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
import express from 'express';
import { query } from '../services/db.js';
import { resolveAllTrashPaths } from '../utils/mailUtils.js';
import mailRoutes from './mail.js';

// The thread route marks in_trash each copy held where bulk-delete expunges as Trash, so deleting a
// conversation from another folder can leave the copies deleted earlier alone. The mark has to agree
// with resolveAllTrashPaths, which bulk-delete decides by, for every copy. Uses only
// connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('thread route in_trash PostgreSQL', () => {
  let database, server, base;
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id text, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text,
        folder_mappings jsonb NOT NULL DEFAULT '{}');
      CREATE TEMP TABLE folders (account_id uuid, path text NOT NULL, name text NOT NULL,
        delimiter text, special_use text, no_select boolean NOT NULL DEFAULT false,
        UNIQUE (account_id, path));
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false,
        subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
        reply_to jsonb, snippet text, is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text,
        list_unsubscribe_post text, delivery_addresses jsonb, flags jsonb, unsubscribed_at timestamptz)`);
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
    await database.query('TRUNCATE messages, folders, email_accounts');
  });

  // An account with these folders, `name` the last segment as syncFolders stores it, and a copy of
  // the one conversation in each folder that can hold mail.
  const account = async (label, folders, mappings = {}) => {
    const accountId = id();
    await database.query(
      `INSERT INTO email_accounts(id,user_id,enabled,include_in_unified_inbox,name,email_address,color,folder_mappings)
       VALUES ($1,'owner',true,true,$2,$3,'#123456',$4)`,
      [accountId, label, `${label}@example.com`, JSON.stringify(mappings)],
    );
    for (const { path, delimiter = '/', specialUse = null, noSelect = false } of folders) {
      await database.query(
        'INSERT INTO folders(account_id,path,name,delimiter,special_use,no_select) VALUES ($1,$2,$3,$4,$5,$6)',
        [accountId, path, path.split(delimiter).pop(), delimiter, specialUse, noSelect],
      );
      if (noSelect) continue;
      await database.query(
        `INSERT INTO messages(id,account_id,folder,uid,message_id,thread_id,thread_key,date,subject)
         VALUES ($1,$2,$3,$4,$5,'<root@ext>','<root@ext>','2026-10-01T10:00Z','Question')`,
        [id(), accountId, path, nextId, `<${label}/${path}@ext>`],
      );
    }
    return [accountId, label];
  };

  it('marks exactly the copies bulk-delete would expunge as Trash', async () => {
    const labels = Object.fromEntries([
      // Every folder under INBOX, as on Courier, and none of these flagged, so the names decide.
      await account('courier', [
        { path: 'INBOX', delimiter: '.' }, { path: 'INBOX.Trash', delimiter: '.' },
        { path: 'INBOX.Deleted', delimiter: '.' }, { path: 'INBOX.Clients.Trash', delimiter: '.' },
      ]),
      // A localized Trash the server flags, a second Trash beside it, and the user's own folders.
      await account('localized', [
        { path: 'INBOX' }, { path: 'Papierkorb', specialUse: '\\Trash' }, { path: 'Deleted' },
        { path: 'Clients/Trash' }, { path: 'Blog trash' },
      ]),
      await account('gmail', [
        { path: 'INBOX' }, { path: '[Gmail]', noSelect: true },
        { path: '[Gmail]/Trash', specialUse: '\\Trash' }, { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
      ]),
      // A usable trash mapping replaces the rules; one at a folder that cannot be selected, or that
      // no longer exists, falls back to them.
      await account('mapped', [
        { path: 'INBOX' }, { path: 'Corbeille' }, { path: 'Trash', specialUse: '\\Trash' },
      ], { trash: 'Corbeille' }),
      await account('noselect', [
        { path: 'INBOX' }, { path: '[Gmail]', noSelect: true }, { path: '[Gmail]/Trash', specialUse: '\\Trash' },
      ], { trash: '[Gmail]' }),
      // Its own Corbeille and Papierkorb are plain folders: another account's mapping, or another
      // account's flag on a folder of the same name, must not mark them.
      await account('missing', [
        { path: 'INBOX' }, { path: 'Trash' }, { path: 'Corbeille' }, { path: 'Papierkorb' },
      ], { trash: 'Old Trash' }),
    ]);

    const response = await fetch(`${base}/api/mail/thread?id=${encodeURIComponent('<root@ext>')}`);
    expect(response.status).toBe(200);
    const { messages } = await response.json();
    expect(Object.fromEntries(messages.map(m => [`${labels[m.account_id]} ${m.folder}`, m.in_trash]))).toEqual({
      'courier INBOX': false, 'courier INBOX.Trash': true, 'courier INBOX.Deleted': true, 'courier INBOX.Clients.Trash': false,
      'localized INBOX': false, 'localized Papierkorb': true, 'localized Deleted': true,
      'localized Clients/Trash': false, 'localized Blog trash': false,
      'gmail INBOX': false, 'gmail [Gmail]/Trash': true, 'gmail [Gmail]/Sent Mail': false,
      'mapped INBOX': false, 'mapped Corbeille': true, 'mapped Trash': false,
      'noselect INBOX': false, 'noselect [Gmail]/Trash': true,
      'missing INBOX': false, 'missing Trash': true, 'missing Corbeille': false, 'missing Papierkorb': false,
    });

    for (const message of messages) {
      const { rows: [{ folder_mappings: mappings }] } = await database.query(
        'SELECT folder_mappings FROM email_accounts WHERE id = $1', [message.account_id],
      );
      const expunged = (await resolveAllTrashPaths(message.account_id, mappings)).has(message.folder);
      expect(message.in_trash, `${labels[message.account_id]} ${message.folder}`).toBe(expunged);
    }
  });
});
