import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));
import { freeTextTermCondition } from './search.js';

// Opt-in only. No mailbox data: connection-local synthetic tables and indexes.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL || process.env.MAILFLOW_SEARCH_BENCHMARK !== '1')('body search benchmark', () => {
  let database;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`SET statement_timeout='10min';
      CREATE TEMP TABLE messages(id bigint PRIMARY KEY, account_id int, date timestamptz,
        is_deleted boolean DEFAULT false, from_name text, from_email text, subject text, snippet text, body_text text,
        search_vector tsvector GENERATED ALWAYS AS (
          to_tsvector('english', coalesce(subject,'')||' '||coalesce(from_name,'')||' '||coalesce(from_email,'')||' '||coalesce(snippet,''))
        ) STORED);
      INSERT INTO messages(id,account_id,date,from_name,from_email,subject,snippet,body_text)
      SELECT i,1+(i%3), '2026-01-01'::timestamptz+i*interval '1 second',
        'sender'||(i%100), 'person'||(i%100)||'@example.test','mail'||i,'preview',
        repeat('standard shared common letter business receipt correspondence message invoice information delivery confirmation subscription account customer statement ',55)
          ||CASE WHEN i%20000=1 THEN ' unicornrare' ELSE '' END
      FROM generate_series(1,60000) i;
      CREATE INDEX ON messages(date DESC);
      CREATE INDEX ON messages(account_id);
      CREATE INDEX ON messages USING gin(to_tsvector('english',coalesce(body_text,'')));
      CREATE INDEX ON messages USING gin(search_vector);
      CREATE INDEX ON messages USING gin(from_name gin_trgm_ops);
      CREATE INDEX ON messages USING gin(from_email gin_trgm_ops);
      CREATE INDEX ON messages USING gin(subject gin_trgm_ops);
      ANALYZE messages;
      SET statement_timeout='12s'; SET work_mem='4MB';`);
  }, 600000);
  afterAll(async () => { await database?.end(); });

  it('reports baseline and candidate plans without hardware-dependent speed assertions', async () => {
    const baseline = `(m.from_name ILIKE $1 OR m.from_email ILIKE $1 OR m.subject ILIKE $1
      OR m.search_vector @@ plainto_tsquery('english',$2)
      OR CASE WHEN numnode(plainto_tsquery('english',$2))>0
        THEN to_tsvector('english',LEFT(coalesce(m.body_text,''),600000)) @@ plainto_tsquery('english',$2)
        ELSE to_tsvector('simple',LEFT(coalesce(m.body_text,''),600000)) @@ plainto_tsquery('simple',$2) END)`;
    const candidate = freeTextTermCondition(1,2);
    for (const [term, negate, limit, offset] of [
      ['common',false,50,0], ['unicornrare',false,50,0], ['absentunicorn',false,50,0],
      ['sender20',false,50,0], ['common',false,200,250], ['unicornrare',true,200,250],
      ['common',true,50,0],
    ]) {
      const completed = [];
      for (const [variant,predicate] of [['baseline',baseline],['candidate',candidate]]) {
        const condition = negate ? `NOT COALESCE(${predicate},false)` : predicate;
        const sql = `SELECT id FROM messages m WHERE account_id=ANY('{1,2}'::int[])
          AND NOT is_deleted AND ${condition} ORDER BY date DESC LIMIT ${limit} OFFSET ${offset}`;
        try {
          const plan = (await database.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, [`%${term}%`,term])).rows[0]['QUERY PLAN'][0];
          const ids = (await database.query(sql,[`%${term}%`,term])).rows.map(row => row.id);
          completed.push(ids);
          process.stdout.write(JSON.stringify({term,negate,limit,offset,variant,plan}) + '\n');
        } catch (error) {
          if (error.code !== '57014') throw error;
          process.stdout.write(JSON.stringify({term,negate,limit,offset,variant,timeoutMs:12000}) + '\n');
        }
      }
      if (completed.length === 2) expect(completed[0]).toEqual(completed[1]);
    }
  }, 240000);
});
