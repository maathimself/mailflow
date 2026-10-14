import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Requires CREATEDB on an explicitly supplied disposable PostgreSQL server.
const state = vi.hoisted(() => ({ pool: null, sql: null, params: null, capture: false }));
vi.mock('./db.js', () => ({
  pool: { connect: () => state.pool.connect() },
  query: async (sql, params) => {
    if (sql.includes('FROM messages m')) {
      state.sql = sql; state.params = params;
      if (state.capture) return { rows: [] };
    }
    return state.pool.query(sql, params);
  },
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
import router, { FTS_BODY_CHAR_CAP } from '../routes/search.js';
import { runMigrations } from './migrations.js';

const url = process.env.SEARCH_INDEX_TEST_URL;
const database = `search_index_${randomUUID().replaceAll('-', '')}`;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const handler = router.stack.find(s => s.route?.path === '/').route.stack.at(-1).handle;
const helper = 'mailflow_body_search_vector';
const overflow = 'mailflow_body_overflow_matches';
const version = '0068_body_search_indexes';
let admin;
let boundaryBody;

async function compile(query, baseline = false) {
  let status = 200;
  let payload;
  const res = { status: n => { status = n; return res; }, json: v => { payload = v; } };
  state.sql = null;
  state.capture = true;
  try { await handler({ query, session: { userId: id(1) } }, res); }
  finally { state.capture = false; }
  expect(status, JSON.stringify(payload)).toBe(200);
  let sql = state.sql;
  if (baseline && sql) {
    // Keep the actual complete route query/parameters, replacing only the body arm.
    const oldArm = `OR ${helper}\\(m.body_text\\) @@ plainto_tsquery\\('english', \\$([0-9]+)\\)\\s+OR \\(${helper}\\(m.body_text\\) IS NULL\\s+AND ${overflow}\\(m.body_text, \\$\\1\\)\\)`;
    const guardedArm = `OR \\(numnode\\(plainto_tsquery\\('english', \\$([0-9]+)\\)\\) > 0\\s+AND \\(${helper}\\(m.body_text\\) @@ plainto_tsquery\\('english', \\$\\1\\)\\s+OR \\(${helper}\\(m.body_text\\) IS NULL\\s+AND ${overflow}\\(m.body_text, \\$\\1\\)\\)\\)\\)`;
    sql = sql.replace(
      new RegExp(sql.includes('numnode') ? guardedArm : oldArm, 'g'),
      (_arm, idx) => `OR to_tsvector('english', LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('english', $${idx})`,
    );
    expect(sql).not.toContain(helper);
    expect(sql).not.toContain(overflow);
  }
  return { sql, params: state.params };
}

async function search(query, baseline = false) {
  const { sql, params } = await compile(query, baseline);
  return sql ? (await state.pool.query(sql, params)).rows : [];
}

describe.skipIf(!url)('body search indexes (PostgreSQL 16)', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    expect((await admin.query('SHOW server_version_num')).rows[0].server_version_num).toMatch(/^16/);
    await admin.query(`CREATE DATABASE ${database}`);
    const testUrl = new URL(url);
    testUrl.pathname = `/${database}`;
    state.pool = new pg.Pool({ connectionString: testUrl.toString(), max: 2, options: '-c max_parallel_workers_per_gather=0' });
    // Full history also exercises migrations whose SQL explicitly names public.
    await runMigrations();
    await state.pool.query("INSERT INTO users (id,username) VALUES ($1,'search-test'),($2,'other-test')", [id(1), id(2)]);
    for (let n = 3; n <= 6; n++) {
      await state.pool.query(`INSERT INTO email_accounts (id,user_id,name,email_address,enabled,include_in_unified_inbox)
        VALUES ($1,$2,'synthetic','synthetic@example.test',$3,$4)`, [id(n), id(n === 6 ? 2 : 1), n !== 5, n !== 4]);
    }
    await state.pool.query("INSERT INTO folders (account_id,path,name,special_use) VALUES ($1,'Trash','Trash',$2)", [id(3), '\\Trash']);
    const fixtures = [
      [1, null, null, null, null, null],
      [2, 'lighthouse', 'ordinary', 'Sender', 'sender@example.test', 'ordinary'],
      [3, 'running café 東京 mañana', 'ordinary', 'Sender', 'sender@example.test', 'ordinary'],
      [4, null, 'lighthouse', 'Sender', 'sender@example.test', 'ordinary'],
      [5, null, 'ordinary', 'Lighthouse keeper', 'sender@example.test', 'ordinary'],
      [6, null, 'ordinary', 'Sender', 'lighthouse@example.test', 'ordinary'],
      [7, null, 'ordinary', 'Sender', 'sender@example.test', 'lighthouse'],
      [8, 'lighthouse', 'ordinary', null, null, null, 'Trash'],
      [9, 'lighthouse', 'ordinary', null, null, null, 'INBOX', 6],
      [10, 'lighthouse', 'ordinary', null, null, null, 'INBOX', 4],
      [11, 'lighthouse', 'ordinary', null, null, null, 'INBOX', 5],
      [12, 'lighthouse', 'ordinary', null, null, null, 'INBOX', 3, true],
      [13, 'lighthouse', 'ordinary', null, null, null, 'Archive'],
      [14, ' '.repeat(600000) + 'lighthouse', 'ordinary', null, null, null],
      [15, ' '.repeat(599989) + ' lighthouse ', 'ordinary', null, null, null],
    ];
    for (const [uid, body, subject, name, email, snippet, folder = 'INBOX', account = 3, deleted = false] of fixtures) {
      await state.pool.query(`INSERT INTO messages (id,account_id,uid,folder,date,subject,from_name,from_email,snippet,body_text,is_deleted,is_read,is_starred,has_attachments,to_addresses)
        VALUES ($1,$2,$3::bigint,$4,'2025-01-01'::timestamptz+$3::bigint*interval '1 day',$5,$6,$7,$8,$9,$10,false,true,true,'[{"email":"recipient@example.test"}]')`,
      [id(100 + uid), id(account), uid, folder, subject, name, email, snippet, body, deleted]);
    }
    boundaryBody = (await state.pool.query(`WITH base AS (
      SELECT string_agg('界'||to_hex(i)||'界',' ' ORDER BY i) body FROM generate_series(0,73749)i
    ) SELECT body||' '||repeat('q',100)||repeat(' ',600000-length(body)-1-100-75)||repeat('q',100) body FROM base`)).rows[0].body;
  }, 120000);

  afterAll(async () => {
    await state.pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  }, 120000);

  it('indexes an ingestible body whose capped vector exceeds the packed limit', async () => {
    expect((await state.pool.query(`SELECT ${helper}($1) vector`, [boundaryBody])).rows[0].vector).toBeNull();
    for (const length of [599999, 600000, 600001]) {
      expect((await state.pool.query(`SELECT ${helper}($1) vector`, [boundaryBody.slice(0, length)])).rows[0].vector).toBeNull();
    }
    await expect(state.pool.query("SELECT to_tsvector('english',LEFT($1,600000))", [boundaryBody])).rejects.toMatchObject({ code: '54000' });
    await state.pool.query('INSERT INTO messages (id,account_id,uid,body_text,is_deleted) VALUES ($1,$2,90,$3,true)', [id(190), id(3), boundaryBody]);
    await state.pool.query('UPDATE messages SET is_deleted=false WHERE id=$1', [id(190)]);
    for (const [q, found] of [['界123界', true], ['界123界 -absentlexeme', true], ['-界123界', false], ['absentlexeme', false]]) {
      expect((await search({ q })).some(r => r.id === id(190))).toBe(found);
    }
    expect((await state.pool.query(`SELECT ${overflow}($1,$2) matched`, [boundaryBody, '界123界'])).rows[0].matched).toBe(true);
    expect((await state.pool.query(`SELECT ${overflow}($1,$2) matched`, [boundaryBody, 'absentlexeme'])).rows[0].matched).toBe(false);
    // LEFT cuts the final q100 into a new q75; the earlier complete q100 remains.
    // This also catches a one-character drift in the overflow matcher's cap.
    for (const [term, matched] of [['q'.repeat(75), true], ['q'.repeat(76), false], ['q'.repeat(100), true]]) {
      expect((await state.pool.query(`SELECT ${overflow}($1,$2) matched`, [boundaryBody, term])).rows[0].matched).toBe(matched);
    }
    await state.pool.query('DELETE FROM messages WHERE id=$1', [id(190)]);
  }, 120000);

  it('keeps capped vectors and overflow token matching equivalent to existing FTS', async () => {
    const bodies = [null, '', 'running runner café 東京 mañana', 'foo-bar foo@example.test https://example.test/p',
      '123 3.14 abc123', 'the and or', ...[2046, 2047, 2048].map(n => 'a'.repeat(n)), ' '.repeat(599989) + ' lighthouse ', ' '.repeat(600000) + 'lighthouse'];
    for (const body of bodies) {
      const { rows } = await state.pool.query(`SELECT ${helper}($1) = to_tsvector('english',LEFT(coalesce($1,''),$2)) equal`, [body, FTS_BODY_CHAR_CAP]);
      expect(rows[0].equal).toBe(true);
      for (const term of ['run', 'café 東京', 'foo bar', 'example.test', 'the', 'abc123', 'lighthouse']) {
        const { rows: matches } = await state.pool.query(`SELECT ${overflow}($1,$2) = (to_tsvector('english',LEFT(coalesce($1,''),600000)) @@ plainto_tsquery('english',$2)) equal`, [body, term]);
        expect(matches[0].equal, `${body?.slice(0, 30)} / ${term}`).toBe(true);
      }
    }
  });

  it('preserves ordered route results, operators, visibility, nulls and pagination', async () => {
    expect((await search({ q: 'lighthouse' })).map(r => Number(r.uid))).toEqual([15, 13, 7, 6, 5, 4, 2]);
    for (const q of ['lighthouse', 'run', 'café', '東京', '-lighthouse', 'lighthouse -from:keeper', 'lighthouse is:unread has:attachment',
      'lighthouse to:recipient after:2025-01-03 before:2025-01-17', 'in:trash lighthouse', 'in:all lighthouse', 'subject:ordinary -run', 'lighthouse -absent']) {
      for (const scope of [{}, { accountId: id(4) }, { accountId: id(5) }, { accountId: id(6) }, { folder: 'INBOX' }, { limit: 2, offset: 1 }]) {
        const query = { q, ...scope };
        expect((await search(query)).map(r => r.id)).toEqual((await search(query, true)).map(r => r.id));
      }
    }
  }, 120000);

  it('tracks late hydration, body replacement and removal without stale matches', async () => {
    for (const [body, found] of [['hydrationtoken', true], ['replacementtoken', false], [null, false]]) {
      await state.pool.query('UPDATE messages SET body_text=$1 WHERE uid=1', [body]);
      expect((await search({ q: 'hydrationtoken' })).some(r => Number(r.uid) === 1)).toBe(found);
    }
  });

  it('estimates common body terms instead of the partial-index default', async () => {
    await state.pool.query(`INSERT INTO messages (account_id,uid,body_text)
      SELECT $1,100000+i,'commonbodytoken' FROM generate_series(1,2000)i`, [id(3)]);
    await state.pool.query('ANALYZE messages');
    const { rows } = await state.pool.query(`EXPLAIN (FORMAT JSON) SELECT id FROM messages
      WHERE is_deleted=false AND ${helper}(body_text) @@ plainto_tsquery('english','commonbodytoken')`);
    expect(rows[0]['QUERY PLAN'][0].Plan['Plan Rows']).toBeGreaterThan(1800);
    await state.pool.query('DELETE FROM messages WHERE uid BETWEEN 100001 AND 102000');
  }, 120000);

  it('removes body evaluation for empty tsqueries without changing matches', async () => {
    const { sql, params } = await compile({ q: 'or' });
    const plan = (await state.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    expect(JSON.stringify(plan)).not.toContain(helper);
    expect((await search({ q: 'the' })).map(r => r.id)).toEqual((await search({ q: 'the' }, true)).map(r => r.id));
  }, 120000);

  it('retries both an invalid concurrent build and valid indexes left before bookkeeping', async () => {
    await state.pool.query('DROP INDEX CONCURRENTLY idx_messages_body_search');
    await state.pool.query('INSERT INTO messages (id,account_id,uid,body_text) VALUES ($1,$2,91,$3)', [id(191), id(3), boundaryBody]);
    await expect(state.pool.query('CREATE INDEX CONCURRENTLY idx_messages_body_search ON messages USING gin(to_tsvector(\'english\',LEFT(coalesce(body_text,\'\'),600000))) WHERE is_deleted=false')).rejects.toMatchObject({ code: '54000' });
    expect((await state.pool.query(`SELECT indisvalid FROM pg_index WHERE indexrelid='idx_messages_body_search'::regclass`)).rows[0].indisvalid).toBe(false);
    await state.pool.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
    await runMigrations();
    for (let retry = 0; retry < 2; retry++) {
      expect((await state.pool.query(`SELECT indisvalid FROM pg_index WHERE indexrelid='idx_messages_body_search'::regclass`)).rows[0].indisvalid).toBe(true);
      await state.pool.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
      await runMigrations();
    }
    await state.pool.query('DELETE FROM messages WHERE id=$1', [id(191)]);
    expect((await search({ q: 'lighthouse' })).length).toBe(7);
    await state.pool.query('DROP INDEX CONCURRENTLY idx_messages_body_search');
    await state.pool.query('DROP INDEX CONCURRENTLY idx_messages_body_search_overflow');
    expect((await search({ q: 'lighthouse' })).map(r => r.id)).toEqual((await search({ q: 'lighthouse' }, true)).map(r => r.id));
    await state.pool.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
    await runMigrations();
  }, 120000);

  it.skipIf(!process.env.SEARCH_INDEX_BENCHMARK)('benchmarks complete queries and writes on 75000 synthetic messages', async () => {
    const report = { postgres: (await state.pool.query('SELECT version()')).rows[0].version, messages: 75000, phases: {} };
    const prior = process.env.SEARCH_INDEX_BASELINE_REPORT
      ? JSON.parse(await readFile(process.env.SEARCH_INDEX_BASELINE_REPORT, 'utf8')) : null;
    if (prior) {
      expect(prior.messages).toBe(report.messages);
      expect(prior.postgres).toBe(report.postgres);
    }
    report.reusedBaselineTimings = !!prior;
    const timed = async (sql, params, client = state.pool) => {
      const start = performance.now();
      const result = await client.query(sql, params);
      return { ms: performance.now() - start, result };
    };
    const drop = async () => {
      await state.pool.query('DROP INDEX CONCURRENTLY idx_messages_body_search');
      await state.pool.query('DROP INDEX CONCURRENTLY idx_messages_body_search_overflow');
    };
    await drop();
    await state.pool.query("INSERT INTO email_accounts (id,user_id,name,email_address) VALUES ($1,$2,'second synthetic','second@example.test')", [id(7), id(1)]);
    const load = await timed(`INSERT INTO messages (account_id,uid,folder,date,subject,from_name,from_email,snippet,body_text)
      SELECT CASE i%3 WHEN 0 THEN $1::uuid WHEN 1 THEN $2::uuid ELSE $3::uuid END,i+1000,
        CASE WHEN i%7=0 THEN 'Trash' WHEN i%5=0 THEN 'Archive' ELSE 'INBOX' END,
        '2025-03-01'::timestamptz+i*interval '1 second','Bulletin '||i,'Sender '||i,'sender'||i||'@example.test','Weekly summary',
        repeat('ordinary calendar meeting invoice paragraph reference '||i||' ',
          CASE WHEN i%1000=0 THEN 3500 WHEN i%100=0 THEN 300 ELSE 20+i%40 END)
        ||CASE WHEN i%5003=0 THEN ' lighthouse ' ELSE '' END
      FROM generate_series(1,75000)i`, [id(3), id(7), id(4)]);
    report.loadMs = load.ms;
    // Both comparators retain main's uncapped body index and all other indexes.
    for (const phase of ['baseline', 'indexed']) {
      if (phase === 'indexed') {
        await state.pool.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
        const start = performance.now();
        await runMigrations();
        report.upgradeMs = performance.now() - start;
        report.indexBytes = (await state.pool.query(`SELECT indexrelid::regclass::text name,pg_relation_size(indexrelid)::int bytes
          FROM pg_index WHERE indexrelid IN ('idx_messages_body_search'::regclass,'idx_messages_body_search_overflow'::regclass)`)).rows;
      }
      await state.pool.query('ANALYZE messages');
      const results = { queries: {}, writesMs: {} };
      report.phases[phase] = results;
      for (const q of ['lighthouse', 'ordinary', 'or', 'unfindabletoken', '-ordinary']) {
        const { sql, params } = await compile({ q }, phase === 'baseline');
        expect(sql.includes(helper)).toBe(phase === 'indexed');
        const plans = prior && phase === 'baseline' ? prior.phases.baseline.queries[q].plans : [];
        if (!plans.length) {
          for (let run = 0; run < 4; run++) plans.push((await state.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0]);
        }
        const ids = (await state.pool.query(sql, params)).rows.map(r => r.id);
        results.queries[q] = { ids, plans };
        if (phase === 'indexed') expect(ids).toEqual(report.phases.baseline.queries[q].ids);
      }
      for (const [name, sql] of [
        ['insert', `INSERT INTO messages (account_id,uid,body_text) SELECT $1,900000+i,repeat('new synthetic body reference ',80) FROM generate_series(1,500)i`],
        ['hydrate', `UPDATE messages SET body_text=repeat('cached body replacement reference ',80) WHERE account_id=$1 AND uid BETWEEN 901001 AND 901500`],
        ['flags', `UPDATE messages SET is_read=NOT is_read WHERE account_id=$1 AND uid BETWEEN 1001 AND 1500`],
      ]) {
        if (name === 'hydrate') await state.pool.query('INSERT INTO messages (account_id,uid) SELECT $1,901000+i FROM generate_series(1,500)i', [id(3)]);
        const times = [];
        const client = await state.pool.connect();
        try {
          for (let run = 0; run < 3; run++) {
            await client.query('BEGIN');
            try { times.push((await timed(sql, [id(3)], client)).ms); }
            finally { await client.query('ROLLBACK'); }
          }
        } finally { client.release(); }
        results.writesMs[name] = times;
      }
      await state.pool.query('DELETE FROM messages WHERE uid BETWEEN 901001 AND 901500');
    }
    const plan = JSON.stringify(report.phases.indexed.queries.lighthouse.plans[0].Plan);
    expect(plan).toContain('BitmapOr');
    expect(plan).toContain('idx_messages_body_search');
    // First observed runs are not cold: loading/building/ANALYZE warm caches.
    if (process.env.SEARCH_INDEX_BENCHMARK_OUTPUT) await writeFile(process.env.SEARCH_INDEX_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2));
    else console.log(JSON.stringify(report));
  }, 1800000);
});
