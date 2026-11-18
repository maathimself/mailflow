// D#751 against PostgreSQL: the SQL that records and clears an Apply label failure per account,
// and the rule update that clears failures only when what the rule does, or where, changed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./labels.js', () => ({ applyLabel: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));
const { query } = await import('./db.js');
const { applyLabel } = await import('./labels.js');
const { applyInboxRules } = await import('./inboxRules.js');
const { UPDATE_RULE_SQL } = await import('../routes/rules.js');

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('Apply label failures in PostgreSQL', () => {
  let database;
  const USER = '11111111-1111-4111-8111-111111111111';
  const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const A2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const RULE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ACTIONS = [{ type: 'apply_label', value: 'Receipt' }];
  const imap = { ensureFolder: vi.fn().mockResolvedValue({ path: 'Receipt' }) };
  const msg = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', uid: 1, folder: 'INBOX', messageId: '<m@x>', fromEmail: 'shop@example.com', to: [], subject: 'Receipt 42', parsedHeaders: {} };
  const failures = async () => (await database.query('SELECT label_failures FROM inbox_rules WHERE id = $1', [RULE])).rows[0].label_failures;
  const update = (actions, accountId, enabled = true) => database.query(UPDATE_RULE_SQL,
    ['R', accountId, enabled, false, 'AND', JSON.stringify([]), JSON.stringify(actions), RULE, USER]);

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE inbox_rules (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, account_id uuid, name varchar(255) NOT NULL DEFAULT '',
      enabled boolean NOT NULL DEFAULT true, stop_processing boolean NOT NULL DEFAULT false,
      priority integer NOT NULL DEFAULT 0, condition_logic varchar(3) NOT NULL DEFAULT 'AND',
      conditions jsonb NOT NULL DEFAULT '[]', actions jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    // The migration itself, on the temporary table.
    const { readFile } = await import('node:fs/promises');
    await database.query(await readFile(new URL('../../migrations/0081_inbox_rule_label_failures.sql', import.meta.url), 'utf8'));
    query.mockImplementation((sql, params) => database.query(sql, params));
  });
  afterAll(async () => { await database?.end(); });
  beforeEach(async () => {
    await database.query('TRUNCATE inbox_rules');
    await database.query(
      `INSERT INTO inbox_rules (id, user_id, conditions, actions) VALUES ($1, $2, $3, $4)`,
      [RULE, USER, JSON.stringify([{ field: 'from', operator: 'contains', value: 'shop@' }]), JSON.stringify(ACTIONS)]);
    applyLabel.mockReset();
  });

  it('starts empty, records a failure per account, and clears only that account once a label goes on', async () => {
    expect(await failures()).toEqual({});
    applyLabel.mockRejectedValue(new Error('copy failed'));
    await applyInboxRules([msg], { id: A1, user_id: USER }, imap);
    await applyInboxRules([msg], { id: A2, user_id: USER }, imap);
    const both = await failures();
    expect(Object.keys(both).sort()).toEqual([A1, A2]);
    expect(both[A1]).toMatchObject({ label: 'Receipt', error: 'copy failed', subject: 'Receipt 42' });
    expect(Date.parse(both[A1].at)).toBeGreaterThan(0);

    applyLabel.mockResolvedValue({ applied: true });
    await applyInboxRules([msg], { id: A1, user_id: USER }, imap);
    expect(Object.keys(await failures())).toEqual([A2]);
  });

  it('a save that changes neither actions nor account keeps the failures; a change clears them', async () => {
    await database.query(`UPDATE inbox_rules SET label_failures = $2 WHERE id = $1`, [RULE, JSON.stringify({ [A1]: { error: 'x' } })]);
    await update(ACTIONS, null, false);
    expect(Object.keys(await failures())).toEqual([A1]);
    await update(ACTIONS, null, true);
    expect(Object.keys(await failures())).toEqual([A1]);
    await update([{ type: 'apply_label', value: 'Receipts' }], null);
    expect(await failures()).toEqual({});

    await database.query(`UPDATE inbox_rules SET label_failures = $2 WHERE id = $1`, [RULE, JSON.stringify({ [A1]: { error: 'x' } })]);
    await update([{ type: 'apply_label', value: 'Receipts' }], A1);
    expect(await failures()).toEqual({}, 'a rule moved to one account');
    const { rows } = await database.query('SELECT account_id, actions FROM inbox_rules WHERE id = $1', [RULE]);
    expect(rows[0]).toEqual({ account_id: A1, actions: [{ type: 'apply_label', value: 'Receipts' }] });
  });
});
