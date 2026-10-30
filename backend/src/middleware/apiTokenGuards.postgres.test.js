import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
import { query } from '../services/db.js';
import { apiTokenGuards } from './apiTokenGuards.js';
import { matchApiTokenRoute } from '../services/apiTokenAllowlist.js';

// #617: the API token guards' SQL, which tells drafts among the messages a request would move
// (draftMessageSql) and the roles of the folder bulk-move would move them into (folderRoles). CI
// does not run this. Uses only connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('API token guards PostgreSQL', () => {
  let database;
  const USER = '00000000-0000-4000-8000-0000000000aa';
  const SOMEONE_ELSE = '00000000-0000-4000-8000-0000000000bb';
  const ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const GMAIL = '33333333-3333-4333-8333-333333333333';
  const THEIRS = '44444444-4444-4444-8444-444444444444';
  const MOVE_ERROR = 'API tokens cannot move mail into Trash, Junk, Drafts, Snoozed or folders MailFlow does not sync';
  const DRAFT_ERROR = 'API tokens cannot move or archive drafts';
  const ALL_MAIL_ERROR = "API tokens cannot archive into Gmail's All Mail, where the mail drops out of MailFlow. "
    + "Create a Gmail label named Archive, or choose an archive folder in the account's settings.";
  const ARCHIVE_ERROR = 'API tokens cannot archive into Trash, Junk, Drafts, Snoozed or folders MailFlow does not sync: '
    + "check the account's archive folder setting.";
  let nextId = 1;
  const newId = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid, imap_host text, oauth_provider text,
        folder_mappings jsonb);
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, delimiter text, special_use text,
        no_select boolean NOT NULL DEFAULT false);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text, uid bigint, message_id text,
        in_reply_to text, thread_references text, thread_id text, is_read boolean DEFAULT false,
        is_deleted boolean DEFAULT false, flags jsonb);
      CREATE TEMP TABLE snoozed_messages (id uuid, user_id uuid, account_id uuid, message_id_header text,
        original_folder text, snoozed_folder text, snooze_until timestamptz)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => {
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE email_accounts, folders, messages, snoozed_messages');
    await database.query(
      `INSERT INTO email_accounts VALUES ($1, $4, 'mail.example.com', NULL, NULL), ($2, $4, 'imap.gmail.com', NULL, NULL),
        ($3, $5, 'mail.example.com', NULL, NULL)`,
      [ACCOUNT, GMAIL, THEIRS, USER, SOMEONE_ELSE],
    );
    for (const [path, name, specialUse, noSelect, delimiter] of [
      ['INBOX', 'INBOX', null], ['Archive', 'Archive', null], ['Bin', 'Bin', '\\Trash'],
      ['Deleted Messages', 'Deleted Messages', null], ['INBOX.Trash', 'Trash', null, false, '.'],
      ['Clients/Trash', 'Trash', null], ['Clients/Drafts', 'Drafts', null], ['Drafts', 'Drafts', null],
      ['Unsent', 'Unsent', '\\Drafts'], ['Bulk Mail', 'Bulk Mail', null], ['Everything', 'Everything', '\\All'],
      ['Container', 'Container', null, true], ['Old', 'Old', null], ['Filtered', 'Filtered', null], ['Wip', 'Wip', null],
      ['INBOX.Snoozed', 'Snoozed', null, false, '.'], ['Clients/Snoozed', 'Snoozed', null], ['Later', 'Later', null],
    ]) {
      await database.query('INSERT INTO folders VALUES ($1, $2, $3, $4, $5, $6)', [ACCOUNT, path, name, delimiter ?? '/', specialUse, noSelect ?? false]);
    }
    await database.query("INSERT INTO folders VALUES ($1, '[Gmail]/Important', 'Important', '/', NULL, false)", [GMAIL]);
  });

  const message = async ({ account = ACCOUNT, folder = 'INBOX', messageId = `<${nextId}@example.com>`, inReplyTo = null, flags = null } = {}) => {
    const id = newId();
    await database.query(
      `INSERT INTO messages (id, account_id, folder, uid, message_id, in_reply_to, thread_id, flags)
       VALUES ($1, $2, $3, $4, $5, $6, 'thread', $7)`,
      [id, account, folder, nextId, messageId, inReplyTo, flags && JSON.stringify(flags)],
    );
    return id;
  };
  // The refusal's text, or null when the guard lets the request through.
  async function guard(method, path, body) {
    const req = { originalUrl: path, body, session: { userId: USER }, apiToken: { route: matchApiTokenRoute(method, path) } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await apiTokenGuards(req, res, next);
    if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
    return res.json.mock.calls[0]?.[0]?.error ?? null;
  }
  const move = (ids, folder) => guard('POST', '/api/mail/messages/bulk-move', { ids, folder });
  const archive = ids => guard('POST', '/api/mail/messages/bulk-archive', { ids });
  const snooze = id => guard('POST', `/api/mail/messages/${id}/snooze`, { until: '2026-10-20T08:00:00Z' });

  it('moves into ordinary folders, a Trash, Drafts or Snoozed name below the top level included', async () => {
    const id = await message();
    for (const folder of ['Archive', 'Clients/Trash', 'Clients/Drafts', 'Clients/Snoozed', 'Later', 'Nowhere']) {
      expect(await move([id], folder), folder).toBe(null);
    }
  });

  it('refuses Trash, Drafts, Spam and All Mail by flag or by name, Snoozed, and a folder that holds no mail', async () => {
    const id = await message();
    for (const folder of ['Bin', 'Deleted Messages', 'INBOX.Trash', 'Drafts', 'Unsent', 'Bulk Mail', 'Everything', 'Container', 'INBOX.Snoozed', 'Snoozed']) {
      if (folder === 'Snoozed') await database.query("INSERT INTO folders VALUES ($1, 'Snoozed', 'Snoozed', '/', NULL, false)", [ACCOUNT]);
      expect(await move([id], folder), folder).toBe(MOVE_ERROR);
    }
  });

  it('refuses a folder one of the account\'s snooze records names, as where a rename took Snoozed', async () => {
    const id = await message();
    const snoozedIn = (account, userId, folder) => database.query(
      `INSERT INTO snoozed_messages (id, user_id, account_id, message_id_header, original_folder, snoozed_folder, snooze_until)
       VALUES ($1, $2, $3, '<waiting@example.com>', 'INBOX', $4, '2026-10-20T08:00:00Z')`,
      [newId(), userId, account, folder],
    );
    // Another account's snooze says nothing about this one's folders.
    await snoozedIn(THEIRS, SOMEONE_ELSE, 'Later');
    expect(await move([id], 'Later')).toBe(null);
    await snoozedIn(ACCOUNT, USER, 'Later');
    expect(await move([id], 'Later')).toBe(MOVE_ERROR);
  });

  it('refuses the account\'s mapped Trash, Spam and Drafts', async () => {
    const id = await message();
    for (const folder of ['Old', 'Filtered', 'Wip']) expect(await move([id], folder), folder).toBe(null);
    await database.query(`UPDATE email_accounts SET folder_mappings = '{"trash":"Old","spam":"Filtered","drafts":"Wip"}' WHERE id = $1`, [ACCOUNT]);
    for (const folder of ['Old', 'Filtered', 'Wip']) expect(await move([id], folder), folder).toBe(MOVE_ERROR);
  });

  it('refuses a Gmail folder MailFlow does not sync', async () => {
    expect(await move([await message({ account: GMAIL })], '[Gmail]/Important')).toBe(MOVE_ERROR);
  });

  it('refuses to move or archive a draft, by its flag or by its folder', async () => {
    const mail = await message();
    expect(await archive([mail])).toBe(null);
    for (const draft of [await message({ flags: ['\\Draft', '\\Seen'] }), await message({ folder: 'Drafts' }), await message({ folder: 'Unsent' })]) {
      expect(await archive([mail, draft])).toBe(DRAFT_ERROR);
      expect(await move([mail, draft], 'Archive')).toBe(DRAFT_ERROR);
    }
  });

  it('looks only at the user\'s own messages', async () => {
    expect(await archive([await message({ account: THEIRS, folder: 'Drafts' })])).toBe(null);
  });

  it('refuses an archive mapping that points at Trash, Junk, Drafts or Snoozed', async () => {
    const mail = await message();
    expect(await archive([mail])).toBe(null);
    for (const folder of ['Bin', 'Bulk Mail', 'Unsent', 'INBOX.Snoozed']) {
      await database.query('UPDATE email_accounts SET folder_mappings = $2 WHERE id = $1', [ACCOUNT, JSON.stringify({ archive: folder })]);
      expect(await archive([mail]), folder).toBe(ARCHIVE_ERROR);
    }
    await database.query(`UPDATE email_accounts SET folder_mappings = '{"archive":"Later"}' WHERE id = $1`, [ACCOUNT]);
    expect(await archive([mail])).toBe(null);
  });

  it('refuses an archive into Gmail\'s All Mail, until the account has an archive label or mapping', async () => {
    await database.query("INSERT INTO folders VALUES ($1, '[Gmail]/All Mail', 'All Mail', '/', '\\All', false)", [GMAIL]);
    const mail = await message({ account: GMAIL });
    expect(await archive([mail])).toBe(ALL_MAIL_ERROR);
    // With the other account's mail too: one account archiving into All Mail is enough.
    expect(await archive([await message(), mail])).toBe(ALL_MAIL_ERROR);
    // An account with an Archive folder archives there, All Mail or not.
    expect(await archive([await message()])).toBe(null);
    await database.query("INSERT INTO folders VALUES ($1, 'Archive', 'Archive', '/', NULL, false)", [GMAIL]);
    expect(await archive([mail])).toBe(null);
    await database.query(`UPDATE email_accounts SET folder_mappings = '{"archive":"[Gmail]/All Mail"}' WHERE id = $1`, [GMAIL]);
    expect(await archive([mail])).toBe(ALL_MAIL_ERROR);
  });

  it('refuses to snooze a draft, or a message whose reply chain takes one along', async () => {
    const question = await message({ messageId: '<q@example.com>' });
    const reply = await message({ messageId: '<r@example.com>', inReplyTo: '<q@example.com>' });
    await message({ folder: 'Drafts', messageId: '<d@example.com>', inReplyTo: '<r@example.com>' });
    expect(await snooze(question)).toBe(null);
    await database.query(`UPDATE messages SET flags = '["\\\\Draft"]' WHERE id = $1`, [reply]);
    expect(await snooze(question)).toBe(DRAFT_ERROR);
    expect(await snooze(await message({ folder: 'Drafts', messageId: '<d2@example.com>' }))).toBe(DRAFT_ERROR);
  });
});
