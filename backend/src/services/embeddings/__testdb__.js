// pgvector test-DB harness for fused search + ranking-quality gates.
//
// Reuses Phase 3's established IT convention (env var VECTOR_IT_DB, the SAME
// var every *.integration.test.js in this directory already gates on) rather
// than introducing a second, parallel gating mechanism. Migrations are applied
// ONCE out-of-band via the real runMigrations() against the scratch DB (see
// implementation.md) — this harness does not run them itself, matching every
// existing IT file here. `ensureVectorSchema()` takes no arguments (reads its
// own module-level pool from db.js), so targeting the scratch DB requires the
// same trick those files use: mutate DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
// from the DSN, then dynamically `import()` the module AFTER that mutation so
// db.js's pool (constructed once, at import time) picks up the right env.
import pg from 'pg';

const DSN = process.env.VECTOR_IT_DB || '';

export function hasTestDb() {
  return DSN.length > 0;
}

let _pool = null;
let _ready = null;

async function ready() {
  if (_ready) return _ready;
  _ready = (async () => {
    const u = new URL(DSN);
    Object.assign(process.env, {
      DB_HOST: u.hostname,
      DB_PORT: u.port,
      DB_NAME: u.pathname.slice(1),
      DB_USER: u.username,
      DB_PASSWORD: u.password,
    });
    const { ensureVectorSchema } = await import('./vectorStore.js');
    await ensureVectorSchema();
    _pool = new pg.Pool({ connectionString: DSN, max: 4 });
    return _pool;
  })();
  return _ready;
}

// Runs fn with a clean slate: truncate every table the fused-search / ranking
// tests touch, in one statement (Postgres resolves FK order within a single
// TRUNCATE ... CASCADE regardless of listed order). embed_runs has no ON
// DELETE CASCADE from index_generations by design (Phase 3 finding — the
// production code never hard-deletes a generation), so it must be listed
// explicitly rather than relying on cascade from index_generations alone.
export async function withTestDb(fn) {
  const pool = await ready();
  await pool.query(
    `TRUNCATE embeddings, embed_runs, embed_watermark, index_generations,
              messages, folders, email_accounts, users RESTART IDENTITY CASCADE`
  );
  return fn(pool);
}

export async function closeTestDb() {
  if (_pool) { await _pool.end(); _pool = null; _ready = null; }
}
