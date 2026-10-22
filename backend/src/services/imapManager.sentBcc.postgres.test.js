import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// #585: the row for a message you sent kept To and Cc but never the Bcc, so the reading pane had
// none to show although the Sent copy on the server carries the header. Uses only connection-local
// temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Sent row Bcc (upsertSentMessageRecord)', () => {
  let database;
  const account = { id: '22222222-2222-4222-8222-222222222222', email_address: 'me@example.com' };
  const upsert = (uid, meta) => ImapManager.prototype.upsertSentMessageRecord.call({}, account, 'Sent', uid, {
    messageId: `<m${uid}@example.com>`, subject: 'Hello', fromName: 'Me', fromEmail: 'me@example.com',
    to: [{ name: 'To', email: 'to@example.com' }], ...meta,
  });
  const bccOf = async uid => (await database.query('SELECT bcc_addresses FROM messages WHERE uid = $1', [uid])).rows[0].bcc_addresses;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE messages (id serial, account_id uuid, uid bigint, folder text,
      message_id text, subject text, from_name text, from_email text, to_addresses jsonb, cc_addresses jsonb,
      bcc_addresses jsonb, date timestamptz, snippet text, is_read boolean, is_starred boolean,
      has_attachments boolean, flags jsonb, thread_id text, thread_key text, in_reply_to text,
      thread_references text, normalized_subject text, is_bulk boolean, is_deleted boolean DEFAULT false,
      UNIQUE (account_id, uid, folder))`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => { await database.query('TRUNCATE messages'); });

  it('stores the Bcc of a message sent with one', async () => {
    await upsert(1, { bcc: [{ name: 'Hidden', email: 'hidden@example.com' }] });
    expect(await bccOf(1)).toEqual([{ name: 'Hidden', email: 'hidden@example.com' }]);
  });

  it('stores nothing for a message sent without one', async () => {
    await upsert(2, {});
    expect(await bccOf(2)).toBeNull();
  });

  it('keeps a stored Bcc when the row is written again without one', async () => {
    await upsert(3, { bcc: [{ name: '', email: 'hidden@example.com' }] });
    await upsert(3, {});
    expect(await bccOf(3)).toEqual([{ name: '', email: 'hidden@example.com' }]);
  });
});
