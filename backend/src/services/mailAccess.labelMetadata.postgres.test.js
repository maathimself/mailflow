import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
import { query } from './db.js';
import { getLabelMetadata } from './mailAccess.js';

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('label metadata PostgreSQL', () => {
  let database;
  let nextId = 1;
  const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE messages (
      id uuid PRIMARY KEY, account_id uuid, folder text, message_id text,
      thread_key text, date timestamptz, is_deleted boolean DEFAULT false)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => { await database.query('TRUNCATE messages'); });

  const insert = async (folder, messageId, threadKey, date, overrides = {}) => {
    const rowId = id();
    await database.query(`INSERT INTO messages VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rowId, overrides.account || account, folder, messageId, threadKey, date, overrides.deleted || false]);
    return rowId;
  };

  it('combines same-thread and same-message copies with oldest dates, within the account', async () => {
    const target = await insert('INBOX', '<target@test>', 'thread', '2026-10-09');
    await insert('Todo', '<reply@test>', 'thread', '2026-10-05');
    await insert('Todo', '<older@test>', 'thread', '2026-10-01');
    await insert('Todo', '<unknown@test>', 'thread', null);
    await insert('Watch', '<target@test>', 'divergent-copy-key', '2026-10-02');
    await insert('Delegated', '<unrelated@test>', 'unrelated', '2026-09-01');
    await insert('Reference', '<target@test>', 'thread', '2026-09-01', { account: foreign });
    await insert('Someday', '<deleted@test>', 'thread', '2026-09-01', { deleted: true });
    await insert('Archive', '<archive@test>', 'thread', '2026-09-01');

    expect(await getLabelMetadata(account, [target], ['Todo', 'Watch', 'Delegated', 'Reference', 'Someday'])).toEqual([
      { messageId: target, folder: 'Todo', date: '2026-10-01T00:00:00.000Z' },
      { messageId: target, folder: 'Watch', date: '2026-10-02T00:00:00.000Z' },
    ]);
  });

  it('ignores deleted and foreign requested targets', async () => {
    const deleted = await insert('INBOX', '<deleted@test>', 'thread', '2026-10-09', { deleted: true });
    const other = await insert('INBOX', '<other@test>', 'thread', '2026-10-09', { account: foreign });
    await insert('Todo', '<label@test>', 'thread', '2026-10-01');
    expect(await getLabelMetadata(account, [deleted, other], ['Todo'])).toEqual([]);
  });

  it('does not join unrelated headerless messages and preserves unknown dates', async () => {
    const target = await insert('INBOX', null, 'headerless-target', '2026-10-09');
    await insert('Todo', null, 'headerless-other', '2026-10-01');
    await insert('Watch', null, 'headerless-target', null);
    expect(await getLabelMetadata(account, [target], ['Todo', 'Watch'])).toEqual([
      { messageId: target, folder: 'Watch', date: null },
    ]);
  });
});
