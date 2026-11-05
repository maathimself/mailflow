import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
import { query } from '../services/db.js';
import { RELOCATE_INSERT_COLS, relocateRows } from './mail.js';
import { clearCarries, takeCarry } from '../services/movedRowCarry.js';

// The bulk move, archive and Trash paths relocate rows in one statement: a row whose new uid the
// server named is re-inserted there, and one without is dropped and kept for the destination's
// sync (#665). Uses only a connection-local temporary table in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('relocateRows on PostgreSQL', () => {
  let database;
  const ACC = '00000000-0000-4000-8000-0000000000aa';
  const A = '00000000-0000-4000-8000-000000000001';
  const B = '00000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    const carried = RELOCATE_INSERT_COLS.split(',').map(c => c.trim())
      .filter(c => !['account_id', 'uid', 'folder', 'message_id', 'date'].includes(c));
    await database.query(`CREATE TEMP TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, uid bigint, folder text,
      message_id text, date timestamptz, ${carried.map(c => `${c} text`).join(', ')},
      UNIQUE (account_id, uid, folder))`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    clearCarries();
    await database.query('TRUNCATE messages');
    const insert = `INSERT INTO messages (id, account_id, uid, folder, message_id, date, subject, spam_user_override, category)
      VALUES ($1, $2, $3, 'Junk', $4, '2026-11-04T10:00:00Z', $5, 'ham', 'social')`;
    await database.query(insert, [A, ACC, 10, '<a@x>', 'Known']);
    await database.query(insert, [B, ACC, 11, '<b@x>', 'Unknown']);
  });

  it('moves a row with a new uid, and drops one without for the sync to file with its state', async () => {
    await relocateRows([A, B], new Map([[A, 500]]), 'INBOX');

    const { rows } = await database.query('SELECT uid, folder, subject, spam_user_override, category FROM messages ORDER BY uid');
    expect(rows).toEqual([{ uid: '500', folder: 'INBOX', subject: 'Known', spam_user_override: 'ham', category: 'social' }]);
    expect(takeCarry(ACC, 'INBOX', '<a@x>', '2026-11-04T10:00:00Z')).toBeNull();
    expect(takeCarry(ACC, 'INBOX', '<b@x>', '2026-11-04T10:00:00Z')).toMatchObject({ spam_user_override: 'ham', category: 'social' });
  });

  it('keeps the row a sync already filed at the new uid, with what only MailFlow knew, and does not count it as dropped', async () => {
    await database.query(`INSERT INTO messages (account_id, uid, folder, message_id, subject, spam_verdict, unsubscribed_at)
      VALUES ($1, 500, 'INBOX', '<a@x>', 'Synced', 'spam', '2026-11-01')`, [ACC]);
    await relocateRows([A], new Map([[A, 500]]), 'INBOX');

    const { rows } = await database.query("SELECT subject, spam_user_override, category, spam_verdict, unsubscribed_at FROM messages WHERE folder = 'INBOX'");
    // The server's copy stays (subject); the "Not spam" decision and category come back; what the
    // moved row never had keeps the synced row's value.
    expect(rows).toEqual([{ subject: 'Synced', spam_user_override: 'ham', category: 'social', spam_verdict: 'spam', unsubscribed_at: '2026-11-01' }]);
    expect(takeCarry(ACC, 'INBOX', '<a@x>', '2026-11-04T10:00:00Z')).toBeNull();
  });
});
