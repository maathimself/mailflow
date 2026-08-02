import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from './testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

d('generations lifecycle', () => {
  let gens, store, client, acctId, userId;
  beforeAll(async () => {
    const u = new URL(DSN);
    Object.assign(process.env, { DB_HOST: u.hostname, DB_PORT: u.port, DB_NAME: u.pathname.slice(1), DB_USER: u.username, DB_PASSWORD: u.password });
    store = await import('./vectorStore.js');
    await store.ensureVectorSchema();
    gens = await import('./generations.js');
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    // Clean slate for generations (integration DB is shared across tasks). embed_runs
    // FKs index_generations without ON DELETE CASCADE, so clear it before the parent.
    await client.query('DELETE FROM embeddings');
    await client.query('DELETE FROM embed_runs');
    await client.query('DELETE FROM index_generations');
    ({ accountId: acctId, userId } = await seedAccount(client, 'gen'));
  });
  afterAll(async () => { await cleanupAccount(client, userId); await client.end(); });

  it('creates a building generation, then a same-fingerprint create resumes it', async () => {
    const g1 = await gens.createGeneration('m', 4, 'fp-A');
    const g2 = await gens.createGeneration('m', 4, 'fp-A');
    expect(g2).toBe(g1);
    const building = await gens.buildingGeneration();
    expect(building.id).toBe(g1);
  });

  it('rejects a mismatched-fingerprint create while building', async () => {
    await expect(gens.createGeneration('m', 4, 'fp-B')).rejects.toBeInstanceOf(gens.BuildingInProgressError);
  });

  it('blocks activation while a live message still needs embedding', async () => {
    const g = (await gens.buildingGeneration()).id;
    await client.query(`INSERT INTO messages (account_id, uid, folder, subject) VALUES ($1, 82001, 'INBOX', 'needs work')`, [acctId]);
    await expect(gens.activateGeneration(g)).rejects.toThrow(/needing embedding/);
  });

  it('activates once coverage is complete and deletes retired rows on the next activate', async () => {
    const g = (await gens.buildingGeneration()).id;
    await client.query('UPDATE messages SET embed_gen = $1 WHERE account_id = $2', [g, acctId]);
    await gens.activateGeneration(g);
    expect((await gens.activeGeneration()).id).toBe(g);

    // New generation covering the same corpus; activating it must delete g's rows.
    await client.query(`INSERT INTO embeddings (generation_id, message_id, chunk_index, embedded_at, source_char_len, dimension, embedding)
      SELECT $1, id, 0, 0, 1, 4, '[1,0,0,0]' FROM messages WHERE account_id = $2`, [g, acctId]);
    const g3 = await gens.createGeneration('m', 4, 'fp-C');
    await client.query('UPDATE messages SET embed_gen = $1 WHERE account_id = $2', [g3, acctId]);
    await gens.activateGeneration(g3);
    const left = await client.query('SELECT COUNT(*)::int n FROM embeddings WHERE generation_id = $1', [g]);
    expect(left.rows[0].n).toBe(0);
  });
});
