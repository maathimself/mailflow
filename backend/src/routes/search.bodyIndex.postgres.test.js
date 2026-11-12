import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: vi.fn() }));
import { freeTextTermCondition } from './search.js';

// Use an explicitly supplied disposable database; fixtures are connection-local.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('indexed English body search PostgreSQL', () => {
  let database;
  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`CREATE TEMP TABLE search_bodies (body_text text);
      CREATE INDEX ON search_bodies USING gin(to_tsvector('english',coalesce(body_text,'')));`);
  });
  afterAll(async () => { await database?.end(); });

  async function matches(body, term) {
    const result = await database.query(`SELECT ${freeTextTermCondition(1, 2)} AS matched FROM
      (SELECT ''::text AS from_name, ''::text AS from_email, ''::text AS subject,
        ''::tsvector AS search_vector, $3::text AS body_text) m`, [`%${term}%`, term, body]);
    return result.rows[0].matched;
  }

  it('searches English words after the old cap in bodies admitted by the existing GIN index', async () => {
    const body = 'ordinary '.repeat(70000) + ' uniquequartz';
    await database.query('INSERT INTO search_bodies VALUES ($1)', [body]);
    expect(await matches(body, 'uniquequartz')).toBe(true);
    expect(await matches(body, 'absentunicorn')).toBe(false);
  });

  it('does not manufacture a partial word by truncating the body at the old cap', async () => {
    const body = ' '.repeat(599997) + 'unicorn';
    expect(await matches(body, 'uni')).toBe(false);
    expect(await matches(body, 'unicorn')).toBe(true);
  });

  it('retains stemming and simple-dictionary fallback, including NULL and empty bodies', async () => {
    expect(await matches('They are running swiftly.', 'runs')).toBe(true);
    expect(await matches('They are running swiftly.', 'the running')).toBe(true);
    expect(await matches('How are we doing?', 'we')).toBe(true);
    expect(await matches('somewhere', 'we')).toBe(false);
    expect(await matches(null, 'unicorn')).toBe(false);
    expect(await matches('', 'unicorn')).toBe(false);
  });

  it('agrees with the old English predicate for generated bodies shorter than the cap', async () => {
    for (const term of ['running', 'unicorn', 'absentquartz', 'СПАСИБО']) {
      const result = await database.query(`SELECT count(*)::int AS differences FROM (
        SELECT ''::text AS from_name, ''::text AS from_email, ''::text AS subject,
          ''::tsvector AS search_vector,
          repeat('ordinary ', i) || CASE WHEN i%3=0 THEN 'running unicorn СПАСИБО' ELSE 'walking' END AS body_text
        FROM generate_series(0,100) i
      ) m WHERE (${freeTextTermCondition(1, 2)}) IS DISTINCT FROM
        (to_tsvector('english',LEFT(coalesce(m.body_text,''),600000)) @@ plainto_tsquery('english',$2))`,
      [`%${term}%`,term]);
      expect(result.rows[0].differences,term).toBe(0);
    }
  });

  it('cannot store an oversized English vector through the baseline body index', async () => {
    // This is the same expression as migration 0001, not a new write-path constraint.
    await expect(database.query(`INSERT INTO search_bodies
      SELECT string_agg('word'||i::text,' ') FROM generate_series(1,150000) i`))
      .rejects.toMatchObject({ code: '54000' });
  });
});
