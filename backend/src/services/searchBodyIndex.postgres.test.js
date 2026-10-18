import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Uses connection-local temporary tables in an explicitly supplied test database.
const state = vi.hoisted(() => ({ pool: null, sql: null, params: null, capture: false, memory: [], failSearch: false }));
vi.mock('./db.js', () => {
  const execute = async (sql, params) => {
    if (sql.includes('FROM messages m')) {
      state.sql = sql; state.params = params;
      if (state.capture) return { rows: [] };
      state.memory.push((await state.pool.query('SHOW work_mem')).rows[0].work_mem);
      if (state.failSearch) return state.pool.query('SELECT 1/0');
    }
    return state.pool.query(sql, params);
  };
  return {
    query: execute,
    withTransaction: async fn => {
      await state.pool.query('BEGIN');
      try {
        const result = await fn({ query: execute });
        await state.pool.query('COMMIT');
        return result;
      } catch (err) {
        await state.pool.query('ROLLBACK');
        throw err;
      }
    },
  };
});
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
import router from '../routes/search.js';
import { withTransaction } from './db.js';

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
    sql = sql.slice(sql.lastIndexOf('\n      SELECT\n'))
      .replace(/(?:AND|WHERE) NOT \(SELECT enough FROM recent_page\)/g, '')
      .replace(/\) SELECT \* FROM fast_matches[\s\S]*?SELECT \* FROM matched_messages/, '')
      .replace(/\)\s*SELECT \* FROM matched_messages/, '')
      .replace(/LEFT JOIN body_matches_([0-9]+) ON body_matches_\1.id = m.id/g, '')
      .replace(/body_matches_([0-9]+).id IS NOT NULL/g,
        (_arm, idx) => `to_tsvector('english', LEFT(coalesce(m.body_text,''), 600000)) @@ plainto_tsquery('english', $${idx})`);
    expect(sql).not.toContain('body_matches');
  }
  return { sql, params: state.params };
}

async function execute(sql, params, baseline = false) {
  if (baseline || !sql.includes('body_matches_')) return state.pool.query(sql, params);
  return withTransaction(async client => {
    await client.query("SET LOCAL work_mem='16MB'");
    expect((await client.query('SHOW work_mem')).rows[0].work_mem).toBe('16MB');
    return client.query(sql, params);
  });
}

async function search(query, baseline = false) {
  const { sql, params } = await compile(query, baseline);
  return sql ? (await execute(sql, params, baseline)).rows : [];
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
        const plan = (await execute(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
        const nodes = [];
        const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
        visit(plan.Plan);
        expect(nodes.some(n => n['Index Name'] === 'idx_messages_body')).toBe(true);
        const body = nodes.find(n => n['Subplan Name']?.startsWith('CTE body_matches_'));
        expect(body).toBeDefined();
        expect(body['Actual Loops']).toBe(q === 'calendar' || q === '-rarebodytoken' ? 0 : 1);
        expect(nodes.filter(n => n.Filter?.includes('to_tsvector') && n['Relation Name'] === 'messages' && n['Actual Rows'] > 256)).toEqual([]);
      }
    } finally {
      await state.pool.query('RESET random_page_cost; RESET cpu_tuple_cost');
      await state.pool.query('DELETE FROM messages WHERE uid>10000');
    }
  }, 120000);

  it('stops after a recent page without executing the all-match body scan', async () => {
    await state.pool.query(`INSERT INTO messages (account_id,uid,date,body_text)
      SELECT $1,30000+i,NOW()+i*interval '1 second','commonpagetoken'
      FROM generate_series(1,1000)i`, [id(3)]);
    await state.pool.query('ANALYZE messages');
    try {
      const { sql, params } = await compile({ q: 'commonpagetoken', limit: 50 });
      const plan = (await execute(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
      const nodes = [];
      const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
      visit(plan.Plan);
      const bodyScans = nodes.filter(n => n['Index Name'] === 'idx_messages_body');
      expect(bodyScans.length).toBeGreaterThan(0);
      expect(bodyScans.every(n => n['Actual Loops'] === 0)).toBe(true);
      expect(nodes.filter(n => /^CTE (body_matches_|matched_messages)/.test(n['Subplan Name'] || '')).every(n => n['Actual Loops'] === 0)).toBe(true);
      expect((await search({ q: 'commonpagetoken' })).map(r => Number(r.uid)))
        .toEqual(Array.from({ length: 50 }, (_, i) => 31000 - i));
    } finally { await state.pool.query('DELETE FROM messages WHERE uid>30000'); }
  });

  it('bounds body evaluation even when the planner avoids nested loops', async () => {
    await state.pool.query(`INSERT INTO messages (account_id,uid,date,body_text)
      SELECT $1,50000+i,NOW()+i*interval '1 second','boundedbodytoken'
      FROM generate_series(1,3000)i`, [id(3)]);
    await state.pool.query('ANALYZE messages');
    await state.pool.query('SET enable_nestloop=off');
    try {
      const { sql, params } = await compile({ q: 'boundedbodytoken' });
      const plan = (await execute(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
      const evaluated = [];
      const visit = node => {
        if (node.Filter?.includes('to_tsvector') && node['Actual Loops'] > 0) evaluated.push(node);
        (node.Plans || []).forEach(visit);
      };
      visit(plan.Plan);
      expect(evaluated.length).toBeGreaterThan(0);
      expect(evaluated.every(n => (n['Actual Rows'] + (n['Rows Removed by Filter'] || 0))*n['Actual Loops'] <= 256)).toBe(true);
    } finally {
      await state.pool.query('RESET enable_nestloop');
      await state.pool.query('DELETE FROM messages WHERE uid>50000');
    }
  }, 120000);

  it('keeps exact pages at the prefix boundary and finds matches beyond an insufficient prefix', async () => {
    await state.pool.query(`INSERT INTO messages (account_id,uid,date,body_text,subject)
      SELECT $1,40000+i,'2026-01-01'::timestamptz+i*interval '1 second',
        CASE WHEN i=300 OR i<=94 THEN 'latepagetoken' ELSE 'commonpagetoken' END,
        'metadatapagetoken'
      FROM generate_series(1,350)i`, [id(3)]);
    try {
      for (const q of ['metadatapagetoken', '-absentpagetoken', 'commonpagetoken', 'latepagetoken', 'metadatapagetoken -latepagetoken']) {
        for (const offset of [0, 206, 207, 349]) {
          expect((await search({ q, offset })).map(r => r.id))
            .toEqual((await search({ q, offset }, true)).map(r => r.id));
        }
      }
      // Exactly 49 matches in the 256 newest rows, and the 50th just outside.
      await state.pool.query("UPDATE messages SET body_text=CASE WHEN uid>=40302 OR uid=40094 THEN 'edgepagetoken' ELSE '' END WHERE uid>40000");
      expect((await search({ q: 'edgepagetoken' })).map(r => Number(r.uid)))
        .toEqual([...Array.from({ length: 49 }, (_, i) => 40350 - i), 40094]);
      await state.pool.query('UPDATE messages SET date=NULL WHERE uid=40094');
      expect(Number((await search({ q: 'edgepagetoken', limit: 1 }))[0].uid)).toBe(40094);
    } finally { await state.pool.query('DELETE FROM messages WHERE uid>40000'); }
  }, 120000);

  it('uses local search memory and restores the session after success and failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const memory of ['4MB', '2MB']) {
        await state.pool.query(`SET work_mem='${memory}'`);
        for (const fail of [false, true]) {
          state.memory = [];
          state.failSearch = fail;
          let status = 200;
          let payload;
          const res = { status: n => { status = n; return res; }, json: v => { payload = v; } };
          await handler({ query: { q: 'lighthouse' }, session: { userId: id(1) } }, res);
          expect(status).toBe(fail ? 500 : 200);
          expect(state.memory).toEqual(['16MB']);
          expect((await state.pool.query('SHOW work_mem')).rows[0].work_mem).toBe(memory);
          if (fail) expect(payload).toEqual({ error: 'Search failed' });
        }
        state.failSearch = false;
        state.memory = [];
        await handler({ query: { q: 'subject:ordinary' }, session: { userId: id(1) } }, { json: () => {} });
        expect(state.memory).toEqual([memory]);
      }
    } finally {
      state.failSearch = false;
      logged.mockRestore();
      await state.pool.query('RESET work_mem');
    }
  });

  it('does not evaluate bodies for empty tsqueries', async () => {
    const { sql, params } = await compile({ q: 'the or' });
    const plan = (await execute(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
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
      const broadPlan = (await execute(`EXPLAIN (ANALYZE, FORMAT JSON) ${broadQuery.sql}`, broadQuery.params)).rows[0]['QUERY PLAN'][0];
      const scans = [];
      const visit = node => { if (node['CTE Name']?.startsWith('body_matches_')) scans.push(node); (node.Plans || []).forEach(visit); };
      visit(broadPlan.Plan);
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.every(n => n['Actual Loops'] <= 1)).toBe(true);
      await state.pool.query("SET work_mem='64kB'");
      const { sql, params } = await compile({ q: '-broadbodytoken' });
      const plan = (await execute(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
      // A non-hashed SubPlan scans the materialized match set for each outer row.
      expect(JSON.stringify(plan)).not.toMatch(/\(SubPlan [0-9]+\)/);
      expect((await search({ q: '-broadbodytoken' })).map(r => Number(r.uid))).toEqual([15, 14, 13, 7, 6, 5, 4, 3, 2, 1]);
    } finally {
      await state.pool.query('RESET work_mem');
      await state.pool.query('DELETE FROM messages WHERE uid>20000');
    }
  }, 120000);

  it.skipIf(!process.env.SEARCH_INDEX_BENCHMARK)('benchmarks 400k hydrated messages at default memory', async () => {
    await state.pool.query(`CREATE INDEX idx_messages_from_email_trgm ON messages USING gin(from_email gin_trgm_ops);
      CREATE INDEX idx_messages_from_name_trgm ON messages USING gin(from_name gin_trgm_ops);
      CREATE INDEX idx_messages_subject_trgm ON messages USING gin(subject gin_trgm_ops)`);
    await state.pool.query('TRUNCATE messages');
    await state.pool.query('UPDATE email_accounts SET include_in_unified_inbox=true WHERE id=$1', [id(4)]);
    await state.pool.query("SET work_mem='4MB'; SET statement_timeout=0");
    const settings = (await state.pool.query(`SELECT name,setting,unit FROM pg_settings
      WHERE name IN ('work_mem','shared_buffers','temp_buffers','hash_mem_multiplier','max_parallel_workers_per_gather')`)).rows;
    const report = { postgres: (await state.pool.query('SELECT version()')).rows[0].version,
      messages: 400000, node: process.version, settings, transactionWorkMem: '16MB', queries: {}, writesMs: {} };
    const save = async () => {
      if (process.env.SEARCH_INDEX_BENCHMARK_OUTPUT) await writeFile(process.env.SEARCH_INDEX_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2));
    };
    const timed = async (sql, params) => {
      const start = performance.now();
      const result = await state.pool.query(sql, params);
      return { ms: performance.now() - start, result };
    };
    console.log('Loading 400k synthetic messages across three accounts');
    report.loadMs = (await timed(`INSERT INTO messages (account_id,uid,folder,date,subject,from_name,from_email,snippet,body_text)
      SELECT CASE WHEN i<=133333 THEN $1::uuid WHEN i<=266666 THEN $2::uuid ELSE $3::uuid END,
        i,CASE WHEN i<=5000 THEN 'ReadBench' ELSE 'INBOX' END,
        '2025-03-01'::timestamptz+i*interval '1 second','Bulletin '||i,'Sender '||i,'sender'||i||'@example.test','Weekly summary',
        repeat('ordinary calendar meeting invoice paragraph reference agenda bulletin attachment summary '||i||' ',15)
        ||CASE WHEN i%10007=0 THEN ' lighthouse ' ELSE '' END
        ||CASE WHEN i%80=0 THEN ' middlefrequency ' ELSE '' END
        ||CASE WHEN i%100<53 THEN ' broadfraction ' ELSE '' END
      FROM generate_series(1,400000)i`, [id(4), id(3), id(6)])).ms;
    report.bodyBytes = Number((await state.pool.query('SELECT sum(octet_length(body_text)) bytes FROM messages')).rows[0].bytes);
    report.heapBytes = Number((await state.pool.query("SELECT pg_relation_size('messages') bytes")).rows[0].bytes);
    report.analyzeMs = (await timed('ANALYZE messages')).ms;
    await save();
    const nodesOf = plan => {
      const nodes = [];
      const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
      visit(plan.Plan);
      return nodes;
    };
    const commonTerms = 'ordinary calendar meeting invoice paragraph reference agenda bulletin attachment summary';
    const cases = [
      ['rare', { q: 'lighthouse' }, i => i%10007===0],
      ['mid', { q: 'middlefrequency' }, i => i%80===0],
      ['absent', { q: 'unfindabletoken' }, () => false],
      ['common', { q: 'ordinary' }, () => true],
      ['common53', { q: 'broadfraction' }, i => i%100<53],
      ['negativeRare', { q: '-lighthouse' }, i => i%10007!==0],
      ['negativeCommon', { q: '-ordinary' }, () => false],
      ['sender', { q: 'sender' }, () => true],
      ['stopword', { q: 'or' }, () => false],
      ['tenTermsDeep', { q: commonTerms, offset: 257 }, () => true],
      ['oldAccount', { q: 'ordinary', accountId: id(4) }, () => true],
      ['oldOperator', { q: 'ordinary subject:"Bulletin 1000"' }, i => String(i).startsWith('1000')],
    ];
    for (const [name, query, matches] of cases) {
      console.log(`Benchmark query: ${name}`);
      const entry = report.queries[name] = { query, baseline: [], revised: [] };
      const max = query.accountId ? 133333 : 266666;
      const expected = [];
      for (let i=max; i>=1; i--) if (matches(i)) expected.push(i);
      entry.expectedRows = expected.length;
      entry.orderedUids = expected.slice(query.offset || 0, (query.offset || 0)+50);
      for (const baseline of [true, false]) {
        await state.pool.query('SET statement_timeout=30000');
        const { sql, params } = await compile(query, baseline);
        try {
          for (let run=0; run<3; run++) {
            const plan = (await execute(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params, baseline)).rows[0]['QUERY PLAN'][0];
            entry[baseline ? 'baseline' : 'revised'].push(plan);
            if (!baseline) {
              expect(nodesOf(plan).filter(n => n['Lossy Heap Blocks'] > 0)).toEqual([]);
              if (['common','common53','negativeRare','sender','oldAccount'].includes(name)) {
                expect(nodesOf(plan).filter(n => n['Index Name'] === 'idx_messages_body').every(n => n['Actual Loops'] === 0)).toBe(true);
              }
            }
          }
          expect((await execute(sql, params, baseline)).rows.map(r => Number(r.uid))).toEqual(entry.orderedUids);
        } catch (err) {
          if (!baseline || err.code !== '57014') throw err;
          entry.baselineTimeoutMs = 30000;
        }
        await save();
      }
      const start = performance.now();
      let payload;
      let status=200;
      const res={ json: v => { payload=v; }, status: n => { status=n; return res; } };
      await handler({ query, session: { userId: id(1) } }, res);
      entry.routeMs = performance.now()-start;
      expect(status).toBe(200);
      expect(payload.messages.map(r => Number(r.uid))).toEqual(entry.orderedUids);
      await save();
    }
    // Repeat broad inclusion/exclusion under a lower incoming session budget.
    await state.pool.query("SET work_mem='2MB'");
    report.lowMemory = {};
    for (const q of ['ordinary', 'broadfraction', '-ordinary']) {
      const { sql, params } = await compile({ q });
      const plan = (await execute(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
      expect(nodesOf(plan).filter(n => n['Lossy Heap Blocks'] > 0)).toEqual([]);
      expect((await state.pool.query('SHOW work_mem')).rows[0].work_mem).toBe('2MB');
      report.lowMemory[q] = plan;
    }
    await state.pool.query("SET work_mem='4MB'");
    // Large bodies exercise the bounded probe without exporting a real corpus.
    await state.pool.query("UPDATE messages SET body_text=repeat('ordinary calendar meeting invoice paragraph reference agenda bulletin attachment summary ',3000) WHERE uid BETWEEN 266651 AND 266666");
    const large = await compile({ q: commonTerms });
    report.largeBodies = (await execute(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${large.sql}`, large.params)).rows[0]['QUERY PLAN'][0];
    expect(nodesOf(report.largeBodies).filter(n => n['Index Name'] === 'idx_messages_body').every(n => n['Actual Loops'] === 0)).toBe(true);
    // Same schema and UPDATE for both batches; rollback excludes commit/WAL costs.
    for (const phase of ['first', 'second']) {
      const times=report.writesMs[phase]=[];
      for (let run=0; run<3; run++) {
        await state.pool.query('BEGIN');
        try {
          const result=await timed("UPDATE messages SET is_read=true,read_changed_at=NOW() WHERE account_id=$1 AND folder='ReadBench'", [id(4)]);
          expect(result.result.rowCount).toBe(5000);
          times.push(result.ms);
        } finally { await state.pool.query('ROLLBACK'); }
      }
    }
    await save();
  }, 3600000);

});
