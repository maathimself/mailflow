import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from './testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

// L2: stamp (embed_gen) + stale-vector prune must be ONE transaction. store.stampSkipped
// CAS-stamps rows with a last_modified token, unconditionally stamps rows without one,
// and deletes embeddings only for ids whose stamp actually landed — all atomically.
d('store.stampSkipped (single-tx stamp + prune)', () => {
  let store, client, acctId, userId, gen;
  beforeAll(async () => {
    const u = new URL(DSN);
    Object.assign(process.env, { DB_HOST: u.hostname, DB_PORT: u.port, DB_NAME: u.pathname.slice(1), DB_USER: u.username, DB_PASSWORD: u.password });
    store = await import('./vectorStore.js');
    await store.ensureVectorSchema();
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query('DELETE FROM embeddings'); await client.query('DELETE FROM embed_runs'); await client.query('DELETE FROM index_generations'); await client.query('DELETE FROM messages');
    ({ accountId: acctId, userId } = await seedAccount(client, 'stamp'));
    const gi = await client.query(`INSERT INTO index_generations (model, dimension, fingerprint, started_at, state) VALUES ('m',4,'fp',0,'building') RETURNING id`);
    gen = gi.rows[0].id;
  });
  afterAll(async () => { await cleanupAccount(client, userId); await client.end(); });

  async function seedMsgWithVector(uid) {
    const m = await client.query(`INSERT INTO messages (account_id, uid, folder, subject) VALUES ($1,$2,'INBOX','x') RETURNING id, last_modified::text lm`, [acctId, uid]);
    const id = m.rows[0].id;
    await client.query(`INSERT INTO embeddings (generation_id, message_id, chunk_index, embedded_at, source_char_len, dimension, embedding) VALUES ($1,$2,0,0,1,4,'[1,0,0,0]')`, [gen, id]);
    // Keep message_count honest for the seeded vector so the decrement
    // assertions below observe real deltas (upsert normally maintains this).
    await client.query('UPDATE index_generations SET message_count = message_count + 1 WHERE id = $1', [gen]);
    return { id, lm: m.rows[0].lm };
  }

  const messageCount = async () =>
    Number((await client.query('SELECT message_count FROM index_generations WHERE id = $1', [gen])).rows[0].message_count);

  it('CAS-stamps and prunes the vector when last_modified matches', async () => {
    const { id, lm } = await seedMsgWithVector(70001);
    const before = await messageCount();
    const missed = await store.stampSkipped(gen, [{ id, lastModified: lm }], []);
    expect(missed).toEqual([]);
    const stamp = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [id]);
    expect(String(stamp.rows[0].embed_gen)).toBe(String(gen));
    const emb = await client.query('SELECT COUNT(*)::int n FROM embeddings WHERE generation_id = $1 AND message_id = $2', [gen, id]);
    expect(emb.rows[0].n).toBe(0); // pruned in the same tx
    expect(await messageCount()).toBe(before - 1); // Fix 7: the prune decrements the generation
  });

  it('a CAS miss decrements nothing (the vector stays)', async () => {
    const { id } = await seedMsgWithVector(70004);
    const before = await messageCount();
    await store.stampSkipped(gen, [{ id, lastModified: '1999-01-01 00:00:00+00' }], []);
    expect(await messageCount()).toBe(before);
  });

  it('on a CAS miss leaves BOTH the stamp and the vector untouched', async () => {
    const { id } = await seedMsgWithVector(70002);
    const missed = await store.stampSkipped(gen, [{ id, lastModified: '1999-01-01 00:00:00+00' }], []);
    expect(missed).toEqual([id]);
    const stamp = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [id]);
    expect(stamp.rows[0].embed_gen).toBeNull();
    const emb = await client.query('SELECT COUNT(*)::int n FROM embeddings WHERE generation_id = $1 AND message_id = $2', [gen, id]);
    expect(emb.rows[0].n).toBe(1); // not pruned — the row still needs work
  });

  it('unconditionally stamps + prunes a plain (missing-row) id', async () => {
    const { id } = await seedMsgWithVector(70003);
    const missed = await store.stampSkipped(gen, [], [id]);
    expect(missed).toEqual([]);
    const emb = await client.query('SELECT COUNT(*)::int n FROM embeddings WHERE generation_id = $1 AND message_id = $2', [gen, id]);
    expect(emb.rows[0].n).toBe(0);
  });
});
