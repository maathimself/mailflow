import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from './testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

d('worker end-to-end (pgvector)', () => {
  let store, generations, worker, client, acctId, gen, userId;
  const DIM = 4;
  const fakeClient = { async embed(inputs) { return inputs.map((_, i) => [0.1, 0.2, 0.3, 0.4 + i * 1e-6]); } };

  beforeAll(async () => {
    const u = new URL(DSN);
    Object.assign(process.env, { DB_HOST: u.hostname, DB_PORT: u.port, DB_NAME: u.pathname.slice(1), DB_USER: u.username, DB_PASSWORD: u.password });
    store = await import('./vectorStore.js');
    generations = await import('./generations.js');
    const { EmbeddingWorker } = await import('./worker.js');
    await store.ensureVectorSchema();
    await store.ensureVectorIndex(DIM);
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    // embed_runs FKs index_generations without ON DELETE CASCADE, so clear it first.
    await client.query('DELETE FROM embeddings'); await client.query('DELETE FROM embed_runs'); await client.query('DELETE FROM index_generations');
    // runOnce scans EVERY live embed_gen-IS-NULL message, so stray rows left by
    // other IT files (withTestDb truncates before each test, not after the last)
    // would inflate the coverage counts — clear messages like the tables above.
    await client.query('DELETE FROM messages');
    ({ accountId: acctId, userId } = await seedAccount(client, 'wrk'));
    for (let i = 0; i < 40; i++) {
      await client.query(`INSERT INTO messages (account_id, uid, folder, subject, body_text) VALUES ($1,$2,'INBOX',$3,$4)`,
        [acctId, 83000 + i, `subject ${i}`, `body content number ${i}`]);
    }
    gen = await generations.createGeneration('fake', DIM, 'fp-e2e');
    worker = new EmbeddingWorker({ store, client: fakeClient, generations, preprocessCfg: { stripHTML: true, collapseWhitespace: true }, maxInputChars: 32768, batchSize: 8 });
  });
  afterAll(async () => { await cleanupAccount(client, userId); await client.end(); });

  it('drives the corpus to full coverage and auto-activates the building generation', async () => {
    // The worker was constructed with `generations` in its deps (above), so
    // draining the scan for the building generation promotes it to active at the
    // worker seam — NO manual activateGeneration call here. This is the regression
    // guard for the wiring that was missing in production.
    const res = await worker.runOnce(gen);
    expect(res.succeeded).toBe(40);
    const pending = await client.query('SELECT COUNT(*)::int n FROM messages WHERE account_id = $1 AND embed_gen IS DISTINCT FROM $2', [acctId, gen]);
    expect(pending.rows[0].n).toBe(0);
    const emb = await client.query('SELECT COUNT(DISTINCT message_id)::int n FROM embeddings WHERE generation_id = $1', [gen]);
    expect(emb.rows[0].n).toBe(40);
    expect((await generations.activeGeneration()).id).toBe(gen);
    expect(await generations.buildingGeneration()).toBeNull(); // promoted, no longer building
  });

  it('re-run is a no-op (idempotent coverage)', async () => {
    const res = await worker.runOnce(gen);
    expect(res.claimed).toBe(0);
  });
});
