import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
const imapManager = vi.hoisted(() => ({ findReplyDrafts: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager }));
import routes from './draft.js';
import { query } from '../services/db.js';

// Use only connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('cached reply indicators PostgreSQL pagination', () => {
  let database, server, base;
  const account = '22222222-2222-4222-8222-222222222222';
  const selected = '11111111-1111-4111-8111-111111111111';
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid, user_id text, enabled boolean,
        include_in_unified_inbox boolean, folder_mappings jsonb);
      CREATE TEMP TABLE folders (account_id uuid, path text, special_use text, no_select boolean);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text,
        uid bigint, message_id text, in_reply_to text, thread_references text,
        thread_id text, thread_key text, date timestamptz, is_deleted boolean DEFAULT false)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use(express.json());
    app.use('/api/mail', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });

  it('finds late exact-header bridges across more than 5000 UUID-ordered drafts', async () => {
    await database.query(`INSERT INTO email_accounts VALUES ($1,'owner',true,true,'{"drafts":"Drafts"}');`, [account]);
    await database.query("INSERT INTO folders VALUES ($1,'Drafts',NULL,false)", [account]);
    await database.query(`INSERT INTO messages(id,account_id,folder,message_id,thread_id,thread_key)
      VALUES ($1,$2,'INBOX','<parent@test>','<parent@test>','<parent@test>')`, [selected, account]);
    await database.query(`INSERT INTO messages(id,account_id,folder,uid,message_id,in_reply_to,thread_id,thread_key,date)
      SELECT (lpad(to_hex(i),8,'0') || '-0000-4000-8000-000000000000')::uuid,
        $1,'Drafts',i,'<draft-' || i || '@test>','<unrelated-' || i || '@test>',
        '<other-root@test>','<other-root@test>','2026-10-01'::timestamptz
      FROM generate_series(1,6002) i`, [account]);
    await database.query(`UPDATE messages SET in_reply_to='<late@test>' WHERE uid=6001;
      UPDATE messages SET in_reply_to='<parent@test>', thread_references='<parent@test> <late@test>' WHERE uid=6002`);
    const response = await fetch(`${base}/api/mail/reply-drafts/indicators`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [selected], threaded: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ indicators: { [selected]: { exists: true, accountId: account } } });
    const pages = query.mock.calls.filter(([sql]) => sql.includes('draft_candidates'));
    expect(pages).toHaveLength(13);
    expect(pages[0][1][2]).toBeNull();
    expect(pages.at(-1)[1][2]).toBe('00001770-0000-4000-8000-000000000000');
    expect(pages.every(([, params]) => params[3] === 500)).toBe(true);
    expect(imapManager.findReplyDrafts).not.toHaveBeenCalled();
  });
});
