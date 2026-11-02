import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

vi.mock('./db.js', () => ({ withTransaction: vi.fn() }));
import { withTransaction } from './db.js';
import { NEXT_ACCOUNT_SORT_ORDER, setAccountOrder } from './accountOrder.js';

const MIGRATION = new URL('../../migrations/0073_email_accounts_sort_order_renumber.sql', import.meta.url);

// #695: accounts all started at sort_order 0 and a move rewrote only the two it swapped, so the
// rest reshuffled on the next load. Uses only connection-local temporary tables in an explicitly
// supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('account order', () => {
  let database;
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';
  const order = async user => (await database.query(
    'SELECT name FROM email_accounts WHERE user_id = $1 ORDER BY sort_order, created_at', [user])).rows.map(r => r.name);
  const add = (user, name, at) => database.query(
    `INSERT INTO email_accounts (user_id, name, created_at, sort_order) VALUES ($1, $2, $3, ${NEXT_ACCOUNT_SORT_ORDER})`, [user, name, at]);
  const ids = async (user, names) => {
    const { rows } = await database.query('SELECT id, name FROM email_accounts WHERE user_id = $1', [user]);
    return names.map(n => rows.find(r => r.name === n).id);
  };

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid, name text, sort_order integer DEFAULT 0, created_at timestamptz DEFAULT now())`);
    // The transaction runs on the test's own connection, where the temporary table lives.
    withTransaction.mockImplementation(async fn => {
      await database.query('BEGIN');
      try { const r = await fn(database); await database.query('COMMIT'); return r; } catch (e) { await database.query('ROLLBACK'); throw e; }
    });
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => { await database.query('TRUNCATE email_accounts'); });

  it('adds a new account after the user\'s others', async () => {
    await add(U1, 'A', '2026-01-01'); await add(U1, 'B', '2026-01-02'); await add(U2, 'X', '2026-01-03'); await add(U1, 'C', '2026-01-04');
    const { rows } = await database.query('SELECT name, sort_order FROM email_accounts ORDER BY created_at');
    expect(rows.map(r => [r.name, r.sort_order])).toEqual([['A', 0], ['B', 1], ['X', 0], ['C', 2]]);
  });

  it('saves the whole order, so the others keep their places', async () => {
    for (const [n, d] of [['A', 1], ['B', 2], ['C', 3], ['D', 4]]) {
      await database.query("INSERT INTO email_accounts (user_id, name, created_at) VALUES ($1, $2, ('2026-01-0' || $3)::timestamptz)", [U1, n, d]);
    }
    expect(await setAccountOrder(U1, await ids(U1, ['B', 'A', 'C', 'D']))).toBe(true);
    expect(await order(U1)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('changes nothing unless the ids are exactly the user\'s accounts', async () => {
    await add(U1, 'A', '2026-01-01'); await add(U1, 'B', '2026-01-02'); await add(U2, 'X', '2026-01-03');
    const [a, b] = await ids(U1, ['A', 'B']);
    const [x] = await ids(U2, ['X']);
    expect(await setAccountOrder(U1, [b])).toBe(false);
    expect(await setAccountOrder(U1, [b, a, x])).toBe(false);
    expect(await setAccountOrder(U1, [b, x])).toBe(false);
    expect(await setAccountOrder(U1, [b, b])).toBe(false);
    expect(await order(U1)).toEqual(['A', 'B']);
    expect(await order(U2)).toEqual(['X']);
  });

  it('the migration numbers each user\'s accounts in the order they show now', async () => {
    // The issue's state: four at 0, then a move up of B that wrote B=0 and A=1.
    for (const [u, n, d, s] of [[U1, 'A', 1, 1], [U1, 'B', 2, 0], [U1, 'C', 3, 0], [U1, 'D', 4, 0], [U2, 'X', 5, 0], [U2, 'Y', 6, 0]]) {
      await database.query("INSERT INTO email_accounts (user_id, name, created_at, sort_order) VALUES ($1, $2, ('2026-01-0' || $3)::timestamptz, $4)", [u, n, d, s]);
    }
    const before = [await order(U1), await order(U2)];
    await database.query(await readFile(MIGRATION, 'utf8'));
    expect([await order(U1), await order(U2)]).toEqual(before);
    const { rows } = await database.query('SELECT name, sort_order FROM email_accounts ORDER BY user_id, sort_order');
    expect(rows.map(r => [r.name, r.sort_order])).toEqual([['B', 0], ['C', 1], ['D', 2], ['A', 3], ['X', 0], ['Y', 1]]);
  });
});
