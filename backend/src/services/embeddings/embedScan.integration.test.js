import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from './testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

// S1: the steady-state embed scan must be O(pending), not O(mailbox). The partial
// index idx_messages_embed_pending (migration 0039) only helps if the scan predicate
// is `embed_gen IS NULL` (an OR with `embed_gen <> target` forces a seq scan), which
// in turn is only correct if createGeneration resets stale stamps to NULL so a
// generation rebuild still finds prior-generation rows via the NULL scan.
d('embed scan O(pending) + reset-on-create', () => {
  let store, gens, client, acctId, userId;
  beforeAll(async () => {
    const u = new URL(DSN);
    Object.assign(process.env, { DB_HOST: u.hostname, DB_PORT: u.port, DB_NAME: u.pathname.slice(1), DB_USER: u.username, DB_PASSWORD: u.password });
    store = await import('./vectorStore.js');
    gens = await import('./generations.js');
    await store.ensureVectorSchema();
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query('DELETE FROM embeddings'); await client.query('DELETE FROM embed_runs'); await client.query('DELETE FROM index_generations'); await client.query('DELETE FROM messages');
    ({ accountId: acctId, userId } = await seedAccount(client, 'scan'));
  });
  afterAll(async () => { await cleanupAccount(client, userId); await client.end(); });

  it('scanForEmbedding returns only embed_gen-IS-NULL rows (steady state)', async () => {
    // 2000 stamped under an active-like gen id, 3 new (NULL).
    await client.query("INSERT INTO messages (account_id, uid, folder, subject, embed_gen) SELECT $1, 500000+g, 'INBOX', 'x', 424242 FROM generate_series(0,1999) g", [acctId]);
    const nulls = await client.query("INSERT INTO messages (account_id, uid, folder, subject, embed_gen) SELECT $1, 520000+g, 'INBOX', 'x', NULL FROM generate_series(0,2) g RETURNING id", [acctId]);
    const nullIds = nulls.rows.map((r) => r.id).sort();
    const got = (await store.scanForEmbedding('424242', store.ZERO_UUID, 100)).sort();
    expect(got).toEqual(nullIds);
  });

  it('the scan plan uses the partial pending index (no Seq Scan)', async () => {
    await client.query('ANALYZE messages');
    const r = await client.query(
      `EXPLAIN SELECT id FROM messages WHERE embed_gen IS NULL AND is_deleted = false AND id > $1 ORDER BY id LIMIT $2`,
      [store.ZERO_UUID, 32],
    );
    const plan = r.rows.map((x) => x['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/idx_messages_embed_pending/);
    expect(plan).not.toMatch(/Seq Scan/);
  });

  it('createGeneration resets stale non-null stamps to NULL (so a rebuild re-finds them)', async () => {
    // All current rows are stamped 424242 (a prior gen). A new-fingerprint generation
    // must reset them to NULL so scanForEmbedding finds them for re-embedding.
    const before = await client.query('SELECT COUNT(*)::int n FROM messages WHERE embed_gen IS NULL AND account_id = $1', [acctId]);
    expect(before.rows[0].n).toBe(3); // only the 3 new rows are NULL pre-create
    const g = await gens.createGeneration('m', 4, 'fp-reset');
    const after = await client.query('SELECT COUNT(*)::int nulls, COUNT(*) FILTER (WHERE embed_gen IS NOT NULL)::int stamped FROM messages WHERE account_id = $1', [acctId]);
    expect(after.rows[0].stamped).toBe(0);        // every live stamp reset
    expect(after.rows[0].nulls).toBe(2003);       // all rows now pending for the new gen
    // and the scan now surfaces them (bounded here by limit)
    const pending = await store.scanForEmbedding(g, store.ZERO_UUID, 100);
    expect(pending.length).toBe(100);
    // cleanup the building gen so later IT files start clean
    await gens.retireGeneration(g, true);
  });
});
