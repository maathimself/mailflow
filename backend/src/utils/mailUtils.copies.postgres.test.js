import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { collectHook: async () => [['Watch', 'Todo']] } }));
import { query } from '../services/db.js';
import { readCopyTargets } from './mailUtils.js';

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';
const account = '20000000-0000-4000-8000-000000000001';
const mid = '<copy@example.test>';
const acted = { id: A, uid: 11, folder: 'Sent' };

describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('copy eligibility on PostgreSQL', () => {
  const schema = `copy_targets_${process.pid}_${Date.now()}`;
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE messages (
      id uuid PRIMARY KEY, account_id uuid, uid bigint, folder text, message_id text,
      is_deleted boolean DEFAULT false, is_read boolean DEFAULT false, from_email text,
      date timestamptz, subject text, body_text text, body_html text,
      to_addresses jsonb, cc_addresses jsonb
    )`);
    query.mockImplementation((sql, params) => db.query(sql, params));
  });
  afterAll(async () => { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); });
  beforeEach(async () => {
    await db.query('TRUNCATE messages');
    for (const [id, folder, uid] of [[A, 'Sent', 11], [B, 'Watch', 42]]) {
      await db.query(`INSERT INTO messages
        (id,account_id,uid,folder,message_id,from_email,date,subject,body_text,to_addresses,cc_addresses)
        VALUES($1,$2,$3,$4,$5,'sender@example.test','2026-10-20T12:00Z','Copied subject','Original body','[{"email":"reader@example.test"}]','[]')`,
      [id, account, uid, folder, mid]);
    }
  });
  it('returns both identical copies using the real SQL projection', async () => {
    expect((await readCopyTargets(account, mid, acted)).map(r => r.id).sort()).toEqual([A, B]);
  });
  it.each([
    ['to_addresses', '[{"email":"another@example.test"}]'], ['cc_addresses', '[{"email":"copy@example.test"}]'],
    ['from_email', 'other@example.test'], ['subject', 'Another subject'], ['date', '2026-10-21T12:00Z'],
  ])('rejects a colliding header with different %s', async (field, value) => {
    await db.query(`UPDATE messages SET ${field} = $1 WHERE id = $2`, [value, B]);
    expect(await readCopyTargets(account, mid, acted)).toEqual([]);
  });
  it.each([['body_text', 'Repaired display body'], ['body_html', '<p>Repaired HTML</p>']])('allows mutable %s cache representations', async (field, value) => {
    await db.query(`UPDATE messages SET ${field} = $1 WHERE id = $2`, [value, B]);
    expect((await readCopyTargets(account, mid, acted)).map(r => r.id).sort()).toEqual([A, B]);
  });
  it('includes already-read duplicate live rows in the ambiguity check', async () => {
    await db.query(`INSERT INTO messages(id,account_id,uid,folder,message_id,is_read)
      VALUES($1,$2,12,'Sent',$3,true)`, [C, account, mid]);
    expect(await readCopyTargets(account, mid, acted)).toEqual([]);
  });
  it('requires the original acted UID and folder to remain live', async () => {
    await db.query('UPDATE messages SET uid=77 WHERE id=$1', [A]);
    expect(await readCopyTargets(account, mid, acted)).toEqual([]);
  });
});
