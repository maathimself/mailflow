import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
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
import { ImapManager } from './imapManager.js';

const MIGRATION = new URL('../../migrations/0072_messages_has_attachments_heal.sql', import.meta.url);

// A Sent row recorded right after sending kept has_attachments false and no reply links for good:
// sync skips uids it already holds and storing the body leaves them alone. Uses only
// connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Sent row attachment flag', () => {
  let database;
  const account = { id: '22222222-2222-4222-8222-222222222222', email_address: 'me@example.com' };
  const upsert = (uid, meta) => ImapManager.prototype.upsertSentMessageRecord.call({}, account, 'Sent', uid, {
    messageId: `<m${uid}@example.com>`, subject: 'Hello', fromName: 'Me', fromEmail: 'me@example.com',
    to: [{ name: 'To', email: 'to@example.com' }], ...meta,
  });
  const flagOf = async uid => (await database.query('SELECT has_attachments FROM messages WHERE uid = $1', [uid])).rows[0].has_attachments;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE messages (id serial, account_id uuid, uid bigint, folder text,
      message_id text, subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
      bcc_addresses jsonb, date timestamptz, snippet text, is_read boolean, is_starred boolean,
      has_attachments boolean DEFAULT false, flags jsonb, thread_id text, thread_key text, in_reply_to text,
      thread_references text, normalized_subject text, is_bulk boolean, is_deleted boolean DEFAULT false,
      attachments jsonb DEFAULT '[]', UNIQUE (account_id, uid, folder))`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => { await database.query('TRUNCATE messages'); });

  it('records the flag of a message sent with a file attached', async () => {
    await upsert(1, { hasAttachments: true });
    expect(await flagOf(1)).toBe(true);
    await upsert(2, {});
    expect(await flagOf(2)).toBe(false);
  });

  it('keeps a flag sync already set when the row is written again without it', async () => {
    await upsert(3, {});
    await database.query('UPDATE messages SET has_attachments = true WHERE uid = 3');
    await upsert(3, {});
    expect(await flagOf(3)).toBe(true);
  });

  it('records the reply links, keeping ones sync already stored', async () => {
    const links = async uid => (await database.query('SELECT in_reply_to, thread_references FROM messages WHERE uid = $1', [uid])).rows[0];
    await upsert(4, { inReplyTo: '<parent@example.com>', references: '<root@example.com> <parent@example.com>' });
    expect(await links(4)).toEqual({ in_reply_to: '<parent@example.com>', thread_references: '<root@example.com> <parent@example.com>' });
    await upsert(5, {});
    expect(await links(5)).toEqual({ in_reply_to: null, thread_references: null });
    await database.query("UPDATE messages SET in_reply_to = '<synced@example.com>', thread_references = '<synced@example.com>' WHERE uid = 5");
    await upsert(5, { inReplyTo: '<other@example.com>', references: '<other@example.com>' });
    expect(await links(5)).toEqual({ in_reply_to: '<synced@example.com>', thread_references: '<synced@example.com>' });
  });

  it('the migration sets it for stored attachments sent as attachments, not for inline ones', async () => {
    const att = rows => JSON.stringify(rows);
    await database.query(`INSERT INTO messages (account_id, uid, folder, has_attachments, attachments) VALUES
      ($1, 10, 'Sent', false, $2), ($1, 11, 'Sent', false, $3), ($1, 12, 'Sent', false, '[]'), ($1, 13, 'INBOX', false, NULL)`,
    [account.id, att([{ filename: 'a.pdf', disposition: 'attachment' }]), att([{ filename: 'logo.png', disposition: 'inline' }])]);
    await database.query(await readFile(MIGRATION, 'utf8'));
    const { rows } = await database.query('SELECT uid, has_attachments FROM messages ORDER BY uid');
    expect(rows.map(r => [Number(r.uid), r.has_attachments])).toEqual([[10, true], [11, false], [12, false], [13, false]]);
  });
});
