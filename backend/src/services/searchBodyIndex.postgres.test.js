import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Uses connection-local temporary tables in an explicitly supplied test database.
const state = vi.hoisted(() => ({ pool: null, sql: null, params: null, capture: false }));
vi.mock('./db.js', () => ({
  query: async (sql, params) => {
    if (sql.includes('FROM messages m')) {
      state.sql = sql; state.params = params;
      if (state.capture) return { rows: [] };
    }
    return state.pool.query(sql, params);
  },
}));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
import router from '../routes/search.js';

const url = process.env.MAILFLOW_TEST_DATABASE_URL;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const handler = router.stack.find(s => s.route?.path === '/').route.stack.at(-1).handle;

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
    sql = sql.replace(/^\s*WITH[\s\S]*?(?=\n {6}SELECT)/, '')
      .replace(/\)\s*SELECT \* FROM matched_messages/, '')
      .replace(/LEFT JOIN body_matches_([0-9]+) ON body_matches_\1.id = m.id/g, '')
      .replace(/body_matches_([0-9]+).id IS NOT NULL/g,
        (_arm, idx) => `to_tsvector('english', LEFT(coalesce(m.body_text,''), 600000)) @@ plainto_tsquery('english', $${idx})`);
    expect(sql).not.toContain('body_matches');
  }
  return { sql, params: state.params };
}

async function search(query, baseline = false) {
  const { sql, params } = await compile(query, baseline);
  return sql ? (await state.pool.query(sql, params)).rows : [];
}

describe.skipIf(!url)('body search (PostgreSQL)', () => {
  beforeAll(async () => {
    state.pool = new pg.Client({ connectionString: url });
    await state.pool.connect();
    // Temporary tables/indexes shadow real relations, without CREATEDB or schema changes.
    const baseline = await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8');
    const tables = baseline.slice(0, baseline.indexOf('CREATE TABLE IF NOT EXISTS folders'));
    await state.pool.query(tables.replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    await state.pool.query(`ALTER TABLE email_accounts ADD COLUMN include_in_unified_inbox boolean DEFAULT true;
      ALTER TABLE messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject,'')||' '||coalesce(from_name,'')||' '||coalesce(from_email,'')||' '||coalesce(snippet,''))) STORED;
      DROP INDEX idx_messages_search;
      CREATE INDEX idx_messages_search_vector ON messages USING gin(search_vector);
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, special_use text)`);
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
  }, 120000);

  afterAll(async () => { await state.pool?.end(); });

  it('searches full stored bodies beyond the former cap', async () => {
    expect((await search({ q: 'lighthouse' })).map(r => Number(r.uid))).toContain(14);
    expect((await search({ q: '-lighthouse' })).map(r => Number(r.uid))).not.toContain(14);
  });

  it('matches complete words instead of lexemes invented by the former cap', async () => {
    await state.pool.query('INSERT INTO messages (account_id,uid,body_text) VALUES ($1,16,$2)',
      [id(3), ' '.repeat(599995) + 'boundaryword']);
    try {
      expect((await search({ q: 'boundaryword' })).map(r => Number(r.uid))).toEqual([16]);
      expect((await search({ q: 'bound' })).map(r => Number(r.uid))).not.toContain(16);
    } finally { await state.pool.query('DELETE FROM messages WHERE uid=16'); }
  });

  it('preserves ordered route results, operators, visibility, nulls and pagination', async () => {
    expect((await search({ q: 'lighthouse' })).map(r => Number(r.uid))).toEqual([15, 14, 13, 7, 6, 5, 4, 2]);
    await state.pool.query('UPDATE messages SET is_deleted=true WHERE uid=14');
    try {
      for (const q of ['lighthouse', 'run', 'café', '東京', '-lighthouse', 'lighthouse -from:keeper', 'lighthouse is:unread has:attachment',
        'lighthouse to:recipient after:2025-01-03 before:2025-01-17', 'in:trash lighthouse', 'in:all lighthouse', 'subject:ordinary -run', 'lighthouse -absent', 'the', 'or', 'run café', 'subject:ordinary', 'from:sender', 'is:read']) {
        for (const scope of [{}, { accountId: id(4) }, { accountId: id(5) }, { accountId: id(6) }, { folder: 'INBOX' }, { limit: 2, offset: 1 }]) {
          const query = { q, ...scope };
          expect((await search(query)).map(r => r.id)).toEqual((await search(query, true)).map(r => r.id));
        }
      }
    } finally {
      await state.pool.query('UPDATE messages SET is_deleted=false WHERE uid=14');
    }
  }, 120000);

  it('tracks late hydration, body replacement and removal without stale matches', async () => {
    for (const [body, found] of [['hydrationtoken', true], ['replacementtoken', false], [null, false]]) {
      await state.pool.query('UPDATE messages SET body_text=$1 WHERE uid=1', [body]);
      expect((await search({ q: 'hydrationtoken' })).some(r => Number(r.uid) === 1)).toBe(found);
    }
  });

  it('keeps body matching behind an indexable materialization fence despite cheap date scans', async () => {
    await state.pool.query(`INSERT INTO messages (account_id,uid,date,body_text)
      SELECT $1,10000+i,NOW()+i*interval '1 second',
        repeat('calendar meeting ordinary ',20)||CASE WHEN i=1 THEN 'rarebodytoken' ELSE '' END
      FROM generate_series(1,3000)i`, [id(3)]);
    await state.pool.query('ANALYZE messages');
    await state.pool.query('SET random_page_cost=1; SET cpu_tuple_cost=0.001');
    try {
      for (const q of ['rarebodytoken', 'absentbodytoken', '-rarebodytoken', 'calendar']) {
        const { sql, params } = await compile({ q });
        const plan = (await state.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
        const nodes = [];
        const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
        visit(plan.Plan);
        expect(nodes.some(n => n['Index Name'] === 'idx_messages_body')).toBe(true);
        const body = nodes.find(n => n['Subplan Name']?.startsWith('CTE body_matches_'));
        expect(body).toBeDefined();
        expect(body['Actual Loops']).toBe(1);
        expect(nodes.filter(n => n.Filter?.includes('to_tsvector'))).toEqual([]);
      }
    } finally {
      await state.pool.query('RESET random_page_cost; RESET cpu_tuple_cost');
      await state.pool.query('DELETE FROM messages WHERE uid>10000');
    }
  }, 120000);

  it('does not evaluate bodies for empty tsqueries', async () => {
    const { sql, params } = await compile({ q: 'the or' });
    const plan = (await state.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    const nodes = [];
    const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
    visit(plan.Plan);
    const bodies = nodes.filter(n => n['Subplan Name']?.startsWith('CTE body_matches_'));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body['Actual Rows']).toBe(0);
      expect(body['One-Time Filter']).toBe('false');
    }
    expect((await search({ q: 'the or' })).map(r => r.id)).toEqual((await search({ q: 'the or' }, true)).map(r => r.id));
  });

  it('does not rescan broad negative matches at default or low work_mem', async () => {
    await state.pool.query(`INSERT INTO messages (account_id,uid,date,body_text)
      SELECT $1,20000+i,NOW()+i*interval '1 second','broadbodytoken'
      FROM generate_series(1,10000)i`, [id(3)]);
    await state.pool.query('ANALYZE messages');
    try {
      const broadQuery = await compile({ q: '-broadbodytoken' });
      const broadPlan = (await state.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${broadQuery.sql}`, broadQuery.params)).rows[0]['QUERY PLAN'][0];
      const scans = [];
      const visit = node => { if (node['CTE Name']?.startsWith('body_matches_')) scans.push(node); (node.Plans || []).forEach(visit); };
      visit(broadPlan.Plan);
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.every(n => n['Actual Loops'] <= 1)).toBe(true);
      await state.pool.query("SET work_mem='64kB'");
      const { sql, params } = await compile({ q: '-broadbodytoken' });
      const plan = (await state.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
      // A non-hashed SubPlan scans the materialized match set for each outer row.
      expect(JSON.stringify(plan)).not.toMatch(/\(SubPlan [0-9]+\)/);
      expect((await search({ q: '-broadbodytoken' })).map(r => Number(r.uid))).toEqual([15, 14, 13, 7, 6, 5, 4, 3, 2, 1]);
    } finally {
      await state.pool.query('RESET work_mem');
      await state.pool.query('DELETE FROM messages WHERE uid>20000');
    }
  }, 120000);

  it.skipIf(!process.env.SEARCH_INDEX_BENCHMARK)('benchmarks 200k hydrated messages and baseline write costs', async () => {
    // pg_trgm must already be installed in the explicitly supplied test database.
    await state.pool.query(`CREATE INDEX idx_messages_from_email_trgm ON messages USING gin(from_email gin_trgm_ops);
      CREATE INDEX idx_messages_from_name_trgm ON messages USING gin(from_name gin_trgm_ops);
      CREATE INDEX idx_messages_subject_trgm ON messages USING gin(subject gin_trgm_ops)`);
    await state.pool.query('TRUNCATE messages');
    const report = { postgres: (await state.pool.query('SELECT version()')).rows[0].version,
      messages: 200000, queries: {}, writesMs: {} };
    const prior = process.env.SEARCH_INDEX_BASELINE_REPORT
      ? JSON.parse(await readFile(process.env.SEARCH_INDEX_BASELINE_REPORT, 'utf8')) : null;
    const timed = async (sql, params) => {
      const start = performance.now();
      const result = await state.pool.query(sql, params);
      return { ms: performance.now() - start, result };
    };
    console.log('Loading benchmark mailbox');
    report.loadMs = (await timed(`INSERT INTO messages (account_id,uid,folder,date,subject,from_name,from_email,snippet,body_text)
      SELECT $1,i,CASE WHEN i<=5000 THEN 'ReadBench' ELSE 'INBOX' END,
        '2025-03-01'::timestamptz+i*interval '1 second','Bulletin '||i,'Sender '||i,'sender'||i||'@example.test','Weekly summary',
        repeat('ordinary calendar meeting invoice paragraph reference '||i||' ',75)
        ||CASE WHEN i%10007=0 THEN ' lighthouse ' ELSE '' END
        ||CASE WHEN i%40=0 THEN ' middlefrequency ' ELSE '' END
      FROM generate_series(1,200000)i`, [id(3)])).ms;
    report.bodyBytes = Number((await state.pool.query('SELECT sum(octet_length(body_text)) bytes FROM messages')).rows[0].bytes);
    report.analyzeMs = (await timed('ANALYZE messages')).ms;
    if (prior) {
      expect(prior.messages).toBe(report.messages);
      expect(prior.bodyBytes).toBe(report.bodyBytes);
      expect(prior.postgres).toBe(report.postgres);
    }
    // Avoid warming a query with a parity run before measuring it. EXPLAIN timing
    // excludes network/serialization; first observations are not cold-cache runs.
    for (const q of ['lighthouse', 'middlefrequency', 'unfindabletoken', 'ordinary', '-lighthouse', '-ordinary', 'or']) {
      console.log(`Benchmark query: ${q}`);
      const requiredComparison = ['lighthouse', 'middlefrequency', 'unfindabletoken'].includes(q);
      const priorBaseline = requiredComparison ? prior?.queries[q]?.baseline : null;
      const entry = report.queries[q] = { baseline: priorBaseline || [], revised: [], reusedBaseline: !!priorBaseline };
      for (const phase of requiredComparison && !priorBaseline ? ['baseline', 'revised'] : ['revised']) {
        await state.pool.query(`SET statement_timeout = ${phase === 'baseline' ? 0 : 30000}`);
        const { sql, params } = await compile({ q }, phase === 'baseline');
        for (let run = 0; run < 3; run++) {
          const plan = (await state.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
          entry[phase].push(plan);
        }
      }
      const revised = await search({ q });
      if (requiredComparison) {
        const priorUids = priorBaseline && prior.queries[q].orderedUids;
        entry.reusedBaselineResults = !!priorUids;
        if (priorUids) {
          expect(revised.map(r => Number(r.uid))).toEqual(priorUids);
        } else {
          await state.pool.query('SET statement_timeout=0');
          const baseline = await search({ q }, true);
          expect(revised.map(r => r.id)).toEqual(baseline.map(r => r.id));
          await state.pool.query('SET statement_timeout=30000');
        }
      } else {
        // Every row contains ordinary; none has a stopword match in metadata.
        // The most recent lighthouse hit is well outside the first 50 rows.
        const expected = ['ordinary', '-lighthouse'].includes(q)
          ? Array.from({ length: 50 }, (_, i) => 200000 - i) : [];
        expect(revised.map(r => Number(r.uid))).toEqual(expected);
      }
      entry.orderedUids = revised.map(r => Number(r.uid));
      entry.returnedRows = revised.length;
      if (requiredComparison) {
        entry.bodyHits = Number((await state.pool.query("SELECT count(*) FROM messages WHERE to_tsvector('english', coalesce(body_text,'')) @@ plainto_tsquery('english',$1)", [q])).rows[0].count);
        expect(JSON.stringify(entry.revised[0])).toContain('idx_messages_body');
      }
      if (process.env.SEARCH_INDEX_BENCHMARK_OUTPUT) await writeFile(process.env.SEARCH_INDEX_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2));
    }
    // No schema changes between phases: the fix changes SELECT only. Both
    // measurements use rolled-back statements and exclude COMMIT latency.
    for (const phase of ['baseline', 'revised']) {
      report.writesMs[phase] = {};
      for (const [name, sql, params, count] of [
        ['markAllRead', "UPDATE messages SET is_read=true, read_changed_at=NOW() WHERE account_id=$1 AND folder=$2", [id(3), 'ReadBench'], 5000],
        ['insert', "INSERT INTO messages (account_id,uid,body_text) SELECT $1,300000+i,repeat('new synthetic body reference ',160) FROM generate_series(1,500)i", [id(3)], 500],
        ['bodyUpdate', "UPDATE messages SET body_text=repeat('cached body replacement reference ',140) WHERE account_id=$1 AND uid BETWEEN 1 AND 500", [id(3)], 500],
      ]) {
        console.log(`Benchmark write: ${phase} ${name}`);
        const times = report.writesMs[phase][name] = [];
        for (let run = 0; run < 3; run++) {
          await state.pool.query('BEGIN');
          try {
            const result = await timed(sql, params);
            expect(result.result.rowCount).toBe(count);
            times.push(result.ms);
          } finally { await state.pool.query('ROLLBACK'); }
        }
      }
    }
    if (process.env.SEARCH_INDEX_BENCHMARK_OUTPUT) await writeFile(process.env.SEARCH_INDEX_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2));
    else console.log(JSON.stringify(report));
  }, 3600000);

});
