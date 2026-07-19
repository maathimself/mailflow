import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from './testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

// Re-verification catch (slice 05 contract): a row embedded subject-only and stamped,
// whose body arrives LATER (phase-2 drainer / on-open fetch — the primary product flow),
// must re-surface for embedding. The 0038 trigger clears embed_gen on a content change,
// so the NULL-only scan finds it and the idempotent upsert replaces the stale chunks.
d('post-stamp late-body re-embed (end-to-end)', () => {
  let store, generations, worker, client, acctId, userId, gen, msgId;
  const DIM = 4;
  // Vector encodes the source length so a re-embed with a longer (subject+body) input is
  // observably different from the subject-only embedding.
  const fakeClient = { async embed(inputs) { return inputs.map((t) => [t.length, 0, 0, 0]); } };

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
    await client.query('DELETE FROM embeddings'); await client.query('DELETE FROM embed_runs'); await client.query('DELETE FROM index_generations'); await client.query('DELETE FROM messages');
    ({ accountId: acctId, userId } = await seedAccount(client, 'restale'));
    const m = await client.query(`INSERT INTO messages (account_id, uid, folder, subject, body_text) VALUES ($1, 84001, 'INBOX', 'meeting notes', NULL) RETURNING id`, [acctId]);
    msgId = m.rows[0].id;
    gen = await generations.createGeneration('fake', DIM, 'fp-restale');
    worker = new EmbeddingWorker({ store, client: fakeClient, generations, preprocessCfg: {}, maxInputChars: 32768, batchSize: 8 });
  });
  afterAll(async () => { await cleanupAccount(client, userId); await client.end(); });

  it('re-embeds a stamped row after a late body arrives (trigger clears embed_gen)', async () => {
    // 1. Subject-only embed + stamp.
    await worker.runOnce(gen);
    const stamped = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [msgId]);
    expect(String(stamped.rows[0].embed_gen)).toBe(String(gen));
    const first = await client.query('SELECT source_char_len FROM embeddings WHERE generation_id = $1 AND message_id = $2', [gen, msgId]);
    expect(first.rows.length).toBe(1);
    const subjectOnlyLen = first.rows[0].source_char_len;

    // 2. Late body arrives — the trigger must clear embed_gen so the scan re-finds it.
    await client.query("UPDATE messages SET body_text = 'a much longer body that arrived after the subject-only embedding was already stamped' WHERE id = $1", [msgId]);
    const cleared = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [msgId]);
    expect(cleared.rows[0].embed_gen).toBeNull();
    const pending = await store.scanForEmbedding(gen, store.ZERO_UUID, 10);
    expect(pending).toContain(msgId);

    // 3. Re-embed replaces the stale chunk (idempotent upsert) with the longer source text.
    await worker.runOnce(gen);
    const restamped = await client.query('SELECT embed_gen FROM messages WHERE id = $1', [msgId]);
    expect(String(restamped.rows[0].embed_gen)).toBe(String(gen));
    const after = await client.query('SELECT source_char_len FROM embeddings WHERE generation_id = $1 AND message_id = $2', [gen, msgId]);
    expect(after.rows.length).toBe(1);                            // one chunk — replaced, not duplicated
    expect(after.rows[0].source_char_len).toBeGreaterThan(subjectOnlyLen); // re-embedded WITH the body
  });
});
