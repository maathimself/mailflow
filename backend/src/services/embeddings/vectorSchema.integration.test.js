import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

d('ensureVectorSchema (pgvector image)', () => {
  let store, client;
  beforeAll(async () => {
    // Point db.js's pool at the test DB via env before importing the module graph.
    const u = new URL(DSN);
    process.env.DB_HOST = u.hostname;
    process.env.DB_PORT = u.port;
    process.env.DB_NAME = u.pathname.slice(1);
    process.env.DB_USER = u.username;
    process.env.DB_PASSWORD = u.password;
    store = await import('./vectorStore.js');
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
  });
  afterAll(async () => { await client.end(); });

  it('creates the vector schema and reports available', async () => {
    const { vectorAvailable } = await store.ensureVectorSchema();
    expect(vectorAvailable).toBe(true);
    expect(store.isVectorAvailable()).toBe(true);
    const t = await client.query(
      "SELECT to_regclass('embeddings') e, to_regclass('index_generations') g, to_regclass('embed_watermark') w, to_regclass('embed_runs') r"
    );
    expect(t.rows[0].e).not.toBeNull();
    expect(t.rows[0].g).not.toBeNull();
    expect(t.rows[0].w).not.toBeNull();
    expect(t.rows[0].r).not.toBeNull();
  });

  it('is idempotent (second call does not throw)', async () => {
    await expect(store.ensureVectorSchema()).resolves.toMatchObject({ vectorAvailable: true });
  });

  it('builds a partial HNSW index for a dimension on the empty table', async () => {
    await store.ensureVectorIndex(4);
    const idx = await client.query("SELECT indexname FROM pg_indexes WHERE tablename='embeddings' AND indexname='idx_embeddings_hnsw_d4'");
    expect(idx.rows.length).toBe(1);
  });
});
