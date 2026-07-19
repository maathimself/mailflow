import pg from 'pg';
import { pool, withTransaction } from '../db.js';
import { resolveEmbedConfig } from './config.js';
import { LEXICAL_RANK_SQL, ftsTermQueryArg, hasSearchableToken } from '../search/lexicalRepo.js';

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

let _vectorAvailable = false;
export function isVectorAvailable() { return _vectorAvailable; }

// Build a short-lived connection WITHOUT the pool's `-c statement_timeout=30000`
// startup option, then explicitly disable statement_timeout, so a slow DDL build
// (HNSW over a repopulated table after the alpine→Debian image swap) is not killed
// at 30s. Caller closes nothing — this helper owns the connect/end lifecycle.
async function withDedicatedClient(fn) {
  const client = new pg.Client({
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'mailflow',
    user: process.env.DB_USER || 'mailflow',
    password: process.env.DB_PASSWORD,
  });
  await client.connect();
  try {
    await client.query('SET statement_timeout = 0');
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS index_generations (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model         TEXT NOT NULL,
    dimension     INTEGER NOT NULL,
    fingerprint   TEXT NOT NULL,
    started_at    BIGINT NOT NULL,
    seeded_at     BIGINT,
    completed_at  BIGINT,
    activated_at  BIGINT,
    state         TEXT NOT NULL,
    message_count BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_active   ON index_generations(state) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_building ON index_generations(state) WHERE state = 'building';

CREATE TABLE IF NOT EXISTS embeddings (
    generation_id    BIGINT NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
    message_id       UUID NOT NULL,
    chunk_index      INTEGER NOT NULL DEFAULT 0,
    embedded_at      BIGINT NOT NULL,
    source_char_len  INTEGER NOT NULL,
    chunk_char_start INTEGER NOT NULL DEFAULT 0,
    chunk_char_end   INTEGER NOT NULL DEFAULT 0,
    truncated        BOOLEAN NOT NULL DEFAULT FALSE,
    dimension        INTEGER NOT NULL,
    embedding        vector NOT NULL,
    PRIMARY KEY (generation_id, message_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_msg ON embeddings(message_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_dim ON embeddings(dimension);

CREATE TABLE IF NOT EXISTS embed_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generation_id BIGINT NOT NULL REFERENCES index_generations(id),
    started_at    BIGINT NOT NULL,
    ended_at      BIGINT,
    claimed       INTEGER NOT NULL DEFAULT 0,
    succeeded     INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    truncated     INTEGER NOT NULL DEFAULT 0,
    error         TEXT
);

CREATE TABLE IF NOT EXISTS embed_watermark (
    generation_id BIGINT PRIMARY KEY,
    watermark_id  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
);
`;

// Best-effort startup routine (pattern: encryptExistingCredentials in db.js). Never
// throws into boot: on any failure it logs, sets vector_available=false, and returns.
export async function ensureVectorSchema() {
  _vectorAvailable = false;
  let cfg = null;
  try { cfg = await resolveEmbedConfig(); } catch { /* ai_config unreadable — treat as unset */ }
  const skipExtension = cfg?.skipExtensionCreate === true;
  try {
    if (!skipExtension) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    }
    // Apply the schema on a dedicated no-timeout connection: on a legacy populated DB
    // the idx_embeddings_* builds can exceed the pool's 30s cap (migrate.go).
    await withDedicatedClient((client) => client.query(SCHEMA_SQL));
    if (cfg?.dimension > 0) {
      await ensureVectorIndex(cfg.dimension);
    }
    // Set the flag only after the WHOLE bring-up (extension + schema + per-dimension
    // HNSW) succeeds, so isVectorAvailable() never disagrees with the return value —
    // e.g. an ensureVectorIndex failure must leave the flag false.
    _vectorAvailable = true;
    console.log('Vector schema ready — semantic search available');
    return { vectorAvailable: true };
  } catch (err) {
    _vectorAvailable = false;
    console.warn(`Vector disabled: ${err.message} — lexical search unaffected`);
    return { vectorAvailable: false };
  }
}

// Partial per-dimension HNSW cosine index, created while the table is empty so it is
// maintained incrementally (README invariant; port of migrate.go EnsureVectorIndex).
// The `WHERE dimension = N` guard lets generations of different dims coexist.
export async function ensureVectorIndex(dim) {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`invalid dimension ${dim}`);
  const stmt = `CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw_d${dim}
      ON embeddings USING hnsw ((embedding::vector(${dim})) vector_cosine_ops)
      WHERE dimension = ${dim}`;
  await withDedicatedClient((client) => client.query(stmt));
}

const LIVE_MESSAGES_WHERE = 'is_deleted = false'; // Mailflow live-message predicate
const ANN_OVERFETCH = 4; // backend.go annOverFetchFactor

// pgvector's hnsw.ef_search GUC defaults to 40 and hard-caps at 1000: the HNSW
// scan visits at most ef_search candidates, so any inner ANN `ORDER BY <=>
// LIMIT` above it is silently truncated to ~ef_search rows and widening the
// LIMIT re-runs an identical plan. msgvault sizes a per-connection GUC to 1000
// (store.go HNSWEfSearch): >= the worst-case fused inner LIMIT,
// (kPerSignal+1)*FUSED_ANN_CHUNKS_PER_MESSAGE ≈ 808 at the default
// kPerSignal=100, with headroom, while keeping per-query latency bounded.
// Mailflow's pool sets no per-connection GUCs, so every ANN-issuing statement
// runs in a transaction that `SET LOCAL`s the GUC to its own inner LIMIT,
// capped here (pgvector REJECTS values above 1000; beyond the cap, recall is
// best-effort — the same trade msgvault documents).
export const HNSW_EF_SEARCH_MAX = 1000;

// Run fn(client) in a transaction whose hnsw.ef_search covers `efSearch`
// candidates (capped at HNSW_EF_SEARCH_MAX). A pg.Pool is pinned to one
// client first — BEGIN / SET LOCAL / queries must share a session; an
// injected single client (tests) is used as-is.
async function withEfSearch(db, efSearch, fn) {
  const pinned = db instanceof pg.Pool ? await db.connect() : db;
  try {
    await pinned.query('BEGIN');
    await pinned.query(`SET LOCAL hnsw.ef_search = ${Math.min(Math.max(1, Math.floor(efSearch)), HNSW_EF_SEARCH_MAX)}`);
    const out = await fn(pinned);
    await pinned.query('COMMIT');
    return out;
  } catch (err) {
    await pinned.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (pinned !== db) pinned.release();
  }
}

export function vectorLiteral(vec) {
  return `[${vec.map((f) => Number(f).toString()).join(',')}]`;
}

// Upsert chunks for one generation. Idempotent per message: clears the message's
// prior chunks (chunk count is not stable across re-embeds) then inserts the new set,
// all in one tx. Maintains index_generations.message_count by distinct-message delta.
export async function upsert(gen, chunks) {
  if (!chunks.length) return;
  await withTransaction(async (client) => {
    // Row-lock the generation (serializes against activate/retire) and read its dim.
    const g = await client.query('SELECT dimension, state FROM index_generations WHERE id = $1 FOR UPDATE', [gen]);
    if (!g.rows.length) throw new Error(`unknown generation ${gen}`);
    if (g.rows[0].state === 'retired') { const e = new Error(`generation retired ${gen}`); e.code = 'GEN_RETIRED'; throw e; }
    const dim = g.rows[0].dimension;
    for (const c of chunks) {
      if (c.vector.length !== dim) throw new Error(`dimension mismatch: chunk for msg ${c.messageId} has ${c.vector.length}, gen has ${dim}`);
    }
    const ids = [...new Set(chunks.map((c) => c.messageId))];
    const pre = await client.query(
      'SELECT COUNT(DISTINCT message_id)::int n FROM embeddings WHERE generation_id = $1 AND message_id = ANY($2::uuid[])',
      [gen, ids],
    );
    await client.query('DELETE FROM embeddings WHERE generation_id = $1 AND message_id = ANY($2::uuid[])', [gen, ids]);
    const now = Math.floor(Date.now() / 1000);
    for (const c of chunks) {
      await client.query(
        `INSERT INTO embeddings
           (generation_id, message_id, chunk_index, embedded_at, source_char_len,
            chunk_char_start, chunk_char_end, truncated, dimension, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)`,
        [gen, c.messageId, c.chunkIndex, now, c.sourceCharLen, c.chunkCharStart, c.chunkCharEnd, c.truncated, dim, vectorLiteral(c.vector)],
      );
    }
    const delta = ids.length - pre.rows[0].n;
    if (delta !== 0) {
      await client.query('UPDATE index_generations SET message_count = message_count + $1 WHERE id = $2', [delta, gen]);
    }
  });
}

export async function chunkCount(gen) {
  const r = await pool.query('SELECT COUNT(*)::int n FROM embeddings WHERE generation_id = $1', [gen]);
  return r.rows[0].n;
}

// ANN search over one generation. Inner ORDER BY <=> LIMIT uses the partial HNSW index
// (dimension embedded as a literal); outer GROUP BY collapses multi-chunk messages to
// their best (MIN) distance. Widens the inner LIMIT until k distinct messages survive the
// dedup. Score = 1 - cosine_distance.
//
// An optional structured `filter` narrows the candidate set by pushing predicates INTO
// the inner liveness EXISTS (a Postgres-native join on messages — the equivalent of
// msgvault's json_each resolved-id set, backend.go filtered path). This is REQUIRED for
// account-scoped callers (e.g. plan-phase5 find_similar_messages in a multi-user DB):
// filtering after k-NN can return zero in-scope rows, whereas widening WITH the filter in
// SQL keeps pulling candidates until k in-scope messages survive (or the generation is
// exhausted). filter fields (all optional, AND-combined):
//   accountIds:    string[] (UUIDs) → m.account_id = ANY($n::uuid[])
//   after / before: timestamptz-comparable (ISO string or Date) → m.date >= / < $n
//   hasAttachment: boolean → m.has_attachments = true/false
// With no filter the SQL + params are byte-identical to the fast path (filter clauses and
// their binds simply don't appear). Note: with a filter present the planner may fall back
// from the HNSW index to a scan within the filtered set — the same trade msgvault accepts.
// Append the structured filter's predicates to `args` (relative to messages alias `m`)
// and return the joined WHERE string. Built with a fresh `args` per query so each
// statement's $N ordinals resolve independently (msgvault's bind-closure pattern).
function buildAnnFilter(filter, args) {
  const where = [LIVE_MESSAGES_WHERE];
  if (filter) {
    if (filter.accountIds?.length) { args.push(filter.accountIds); where.push(`m.account_id = ANY($${args.length}::uuid[])`); }
    if (filter.after)  { args.push(filter.after);  where.push(`m.date >= $${args.length}`); }
    // before is EXCLUSIVE (<) — msgvault filter.go parity, and the same
    // bound lexicalRepo's before: operator applies (one convention everywhere).
    if (filter.before) { args.push(filter.before); where.push(`m.date < $${args.length}`); }
    if (filter.hasAttachment === true) where.push('m.has_attachments = true');
    else if (filter.hasAttachment === false) where.push('m.has_attachments = false');
  }
  return where.join(' AND ');
}

// Doubling-widen the inner ANN LIMIT until at least k distinct messages survive the
// outer dedup, the distinct-message early exit is reached, or the candidate ceiling is
// hit. `ceiling` counts CHUNKS (bounds the inner LIMIT); `distinctEarlyExit` counts the
// distinct MESSAGES that can possibly appear (equals k on the empty-filter path, a
// no-op; equals the filtered distinct-message count on the filtered path, so a
// selective filter stops as soon as every in-scope message is surfaced instead of
// widening up to the whole generation's chunk count — msgvault searchWiden parity).
// Port of backend.go searchWiden. Exported for unit testing.
export async function searchWiden(k, ceiling, distinctEarlyExit, run) {
  let innerLimit = Math.max(k * ANN_OVERFETCH, k);
  for (;;) {
    if (innerLimit > ceiling) innerLimit = ceiling;
    const hits = await run(innerLimit);
    if (hits.length >= k || hits.length >= distinctEarlyExit || innerLimit >= ceiling) {
      return hits.slice(0, k).map((h, i) => ({ ...h, rank: i + 1 }));
    }
    innerLimit *= 2;
  }
}

export async function annSearch(gen, queryVec, k, { efSearch = 100, filter = null } = {}) {
  if (!queryVec.length) throw new Error('annSearch: empty query vector');
  const g = await pool.query('SELECT dimension FROM index_generations WHERE id = $1', [gen]);
  if (!g.rows.length) throw new Error(`unknown generation ${gen}`);
  const dim = g.rows[0].dimension;
  if (queryVec.length !== dim) throw new Error(`dimension mismatch: query ${queryVec.length}, gen ${dim}`);
  const lit = vectorLiteral(queryVec);

  // Widening bounds. Filtered: count only the in-scope candidate set (chunks = ceiling,
  // distinct messages = early exit) with the SAME EXISTS predicate, so the loop stops
  // once every in-scope message is surfaced. Unfiltered: whole-generation chunk count as
  // the ceiling and k as the (no-op) early exit — byte-identical to the original fast path.
  let ceiling, distinctEarlyExit;
  if (filter) {
    const cArgs = [gen];
    const cWhere = buildAnnFilter(filter, cArgs);
    const cnt = await pool.query(
      `SELECT COUNT(*)::int chunks, COUNT(DISTINCT e.message_id)::int messages
         FROM embeddings e
        WHERE e.generation_id = $1
          AND EXISTS (SELECT 1 FROM messages m WHERE m.id = e.message_id AND ${cWhere})`,
      cArgs,
    );
    ceiling = cnt.rows[0].chunks;
    distinctEarlyExit = cnt.rows[0].messages;
  } else {
    ceiling = await chunkCount(gen);
    distinctEarlyExit = k;
  }
  if (ceiling === 0) return [];

  // $1 = query vector, $2 = generation; filter binds (if any) take $3.. ; the two LIMITs
  // are appended per widening run as the trailing two params.
  const args = [lit, gen];
  const where = buildAnnFilter(filter, args);
  const innerArg = args.length + 1;
  const outerArg = args.length + 2;
  const sql = `
    SELECT ann.message_id, MIN(ann.distance) AS distance
      FROM (
        SELECT e.message_id, (e.embedding::vector(${dim})) <=> $1::vector AS distance
          FROM embeddings e
         WHERE e.generation_id = $2 AND e.dimension = ${dim}
           AND EXISTS (SELECT 1 FROM messages m WHERE m.id = e.message_id AND ${where})
         ORDER BY e.embedding::vector(${dim}) <=> $1::vector
         LIMIT $${innerArg}
      ) ann
     GROUP BY ann.message_id
     ORDER BY distance, ann.message_id
     LIMIT $${outerArg}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hits = await searchWiden(k, ceiling, distinctEarlyExit, async (innerLimit) => {
      // Re-issue the GUC per widening attempt: ef_search must cover the inner
      // LIMIT or the HNSW scan truncates it and the widening loop is a no-op
      // (see HNSW_EF_SEARCH_MAX). `efSearch` stays the floor for small limits.
      await client.query(`SET LOCAL hnsw.ef_search = ${Math.min(Math.max(Number(efSearch), innerLimit), HNSW_EF_SEARCH_MAX)}`);
      const r = await client.query(sql, [...args, innerLimit, k]);
      return r.rows.map((row, i) => ({ messageId: row.message_id, score: 1 - Number(row.distance), rank: i + 1 }));
    });
    await client.query('COMMIT');
    return hits;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Return the chunk_index=0 vector for messageId in the active generation.
export async function loadVector(messageId) {
  const active = await pool.query("SELECT id, dimension FROM index_generations WHERE state = 'active'");
  if (!active.rows.length) throw new Error('no active generation');
  const r = await pool.query(
    'SELECT embedding::text lit FROM embeddings WHERE generation_id = $1 AND message_id = $2 AND chunk_index = 0',
    [active.rows[0].id, messageId],
  );
  if (!r.rows.length) throw new Error(`no embedding for message ${messageId}`);
  return r.rows[0].lit.slice(1, -1).split(',').map(Number);
}

// Forward scan by UUID for live messages needing work, resuming above afterId. The
// predicate is `embed_gen IS NULL` (NOT the OR with `embed_gen <> target`) so the
// partial index idx_messages_embed_pending (migration 0039) drives an O(pending) scan
// even on a huge, fully-covered mailbox — an OR forces a full seq scan. This is
// correct because createGeneration resets every live row's stamp to NULL when a NEW
// generation is created, so a rebuild's prior-generation rows surface as NULL here too:
// no live row ever carries a non-null stamp for a generation OTHER than the current
// target. `target` is kept in the signature (callers pass it) but is not needed in the
// predicate given that invariant.
export async function scanForEmbedding(target, afterId, limit) {
  const r = await pool.query(
    `SELECT id FROM messages
      WHERE embed_gen IS NULL AND ${LIVE_MESSAGES_WHERE} AND id > $1
      ORDER BY id LIMIT $2`,
    [afterId, limit],
  );
  return r.rows.map((row) => row.id);
}

export async function setEmbedGen(ids, target) {
  if (!ids.length) return;
  await pool.query('UPDATE messages SET embed_gen = $1 WHERE id = ANY($2::uuid[])', [target, ids]);
}

// Optimistic CAS stamp: only stamp rows whose last_modified text token is unchanged
// since the worker read it. Returns the ids that MISSED (last_modified moved) — not
// stamped; the backstop recovers them. Bind the token back as ::timestamptz for
// exact-equality (JS Date would lose the microseconds pg stores).
export async function setEmbedGenIfUnchanged(items, target) {
  const missed = [];
  await withTransaction(async (client) => {
    for (const it of items) {
      const res = await client.query(
        'UPDATE messages SET embed_gen = $1 WHERE id = $2 AND last_modified = $3::timestamptz',
        [target, it.id, it.lastModified],
      );
      if (res.rowCount === 0) missed.push(it.id);
    }
  });
  return missed;
}

// Skip-mark rows (empty/missing) and prune their now-stale vectors in ONE transaction
// (parity with msgvault worker.go stampSkipped). CAS-stamps `casItems` (rows with a
// last_modified token) and unconditionally stamps `plainIds` (missing rows with no row
// to guard), then deletes embeddings for every id whose stamp actually landed — a
// CAS-missed id keeps both its NULL stamp and its vector so it is re-found later.
// index_generations.message_count is decremented by the DISTINCT messages the delete
// actually removes (msgvault backend.go:1118-1167 counts, deletes, and applies the
// delta under the generation row lock; this used to delete without decrementing, so
// the count drifted upward on every skipped re-embed). Returns the CAS-missed ids.
// Bind the token as ::timestamptz for exact equality.
export async function stampSkipped(gen, casItems, plainIds) {
  const missed = [];
  if (!casItems.length && !plainIds.length) return missed;
  await withTransaction(async (client) => {
    // Lock the generation row FIRST — the same order upsert() takes it (and
    // msgvault's Delete, which locks before touching embeddings precisely to
    // avoid an ABBA asymmetry with those writers) — so the decrement below is
    // serialized against concurrent upsert/activate/retire.
    const g = await client.query('SELECT id FROM index_generations WHERE id = $1 FOR UPDATE', [gen]);
    if (!g.rows.length) throw new Error(`unknown generation ${gen}`);
    for (const it of casItems) {
      const res = await client.query(
        'UPDATE messages SET embed_gen = $1 WHERE id = $2 AND last_modified = $3::timestamptz',
        [gen, it.id, it.lastModified],
      );
      if (res.rowCount === 0) missed.push(it.id);
    }
    if (plainIds.length) {
      await client.query('UPDATE messages SET embed_gen = $1 WHERE id = ANY($2::uuid[])', [gen, plainIds]);
    }
    const missedSet = new Set(missed);
    const stamped = [...casItems.map((c) => c.id), ...plainIds].filter((id) => !missedSet.has(id));
    if (stamped.length) {
      const pre = await client.query(
        'SELECT COUNT(DISTINCT message_id)::int n FROM embeddings WHERE generation_id = $1 AND message_id = ANY($2::uuid[])',
        [gen, stamped],
      );
      await client.query('DELETE FROM embeddings WHERE generation_id = $1 AND message_id = ANY($2::uuid[])', [gen, stamped]);
      if (pre.rows[0].n > 0) {
        await client.query('UPDATE index_generations SET message_count = message_count - $1 WHERE id = $2', [pre.rows[0].n, gen]);
      }
    }
  });
  return missed;
}

export async function getWatermark(gen) {
  const r = await pool.query('SELECT watermark_id FROM embed_watermark WHERE generation_id = $1', [gen]);
  return r.rows.length ? r.rows[0].watermark_id : ZERO_UUID;
}

export async function setWatermark(gen, id) {
  await pool.query(
    `INSERT INTO embed_watermark (generation_id, watermark_id) VALUES ($1, $2)
     ON CONFLICT (generation_id) DO UPDATE SET watermark_id = EXCLUDED.watermark_id`,
    [gen, id],
  );
}

export async function resetWatermark(gen) {
  await setWatermark(gen, ZERO_UUID);
}

// Fetch subject + inline bodies + the last_modified CAS token (as text) for a
// batch of message ids. Bodies are inline in messages: no message_bodies table.
export async function fetchForEmbedding(ids) {
  if (!ids.length) return [];
  const r = await pool.query(
    `SELECT id,
            COALESCE(subject, '')   AS subject,
            COALESCE(body_text, '') AS "bodyText",
            COALESCE(body_html, '') AS "bodyHtml",
            last_modified::text     AS "lastModified"
       FROM messages WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return r.rows;
}

export async function startEmbedRun(gen) {
  const now = Math.floor(Date.now() / 1000);
  const r = await pool.query('INSERT INTO embed_runs (generation_id, started_at) VALUES ($1, $2) RETURNING id', [gen, now]);
  return r.rows[0].id;
}

export async function finalizeEmbedRun(runId, res, err) {
  if (!runId) return;
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `UPDATE embed_runs SET ended_at = $1, claimed = $2, succeeded = $3, failed = $4, truncated = $5, error = $6 WHERE id = $7`,
    [now, res.claimed, res.succeeded, res.failed, res.truncated, err ? String(err.message || err) : null, runId],
  ).catch(() => {});
}

// ── Fused RRF search — port of internal/vector/pgvector/fused.go ──

export const FUSED_ANN_CHUNKS_PER_MESSAGE = 8;

const DISPLAY_COLS = `
  m.id AS message_id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
  m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
  a.name AS account_name, a.email_address AS account_email, a.color AS account_color`;

async function fusedChunkCount(db, generation) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM embeddings WHERE generation_id = $1 AND dimension = $2`,
    [generation.id, generation.dimension]);
  return rows[0].n;
}

async function filteredChunkMessageCount(db, { generation, accountIds, buildFilters }) {
  const args = [generation.id, generation.dimension, accountIds];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  const filters = buildFilters(bind).map(c => ` AND ${c}`).join('');
  const { rows } = await db.query(
    `SELECT count(DISTINCT e.message_id)::int AS n
       FROM embeddings e
       JOIN messages m ON m.id = e.message_id
      WHERE e.generation_id = $1 AND e.dimension = $2
        AND m.account_id = ANY($3) AND m.is_deleted = false${filters}`,
    args);
  return rows[0].n;
}

// Single-query hybrid RRF fusion: BM25 leg (weighted ts_rank_cd over
// search_fts, reusing LEXICAL_RANK_SQL) + ANN leg (cosine distance
// over one generation's embeddings), FULL OUTER JOIN'd and combined via
// reciprocal-rank fusion. Either leg can be omitted (ftsQuery/queryVec null)
// for lexical-only or vector-only pools. `buildFilters(bind) → string[]`
// applies the SAME structured operator predicates to both legs (README "one
// search seam" — lexicalRepo remains the single owner of those predicates).
// Each hit also carries best_chunk_index/best_char_start/best_char_end —
// the ANN leg's winning (min-distance) chunk's offsets, null on an
// FTS-only hit. These are CODE POINTS into the PREPROCESSED text (README
// Unicode contract), not raw body_text byte offsets — chunkmatch.js owns
// turning them into a raw-body byte snippet.
export async function fusedSearch(req, { client } = {}) {
  const db = client || pool;
  const { generation, accountIds, rrfK, kPerSignal, limit } = req;
  const buildFilters = req.buildFilters || (() => []);
  // Tokenize once (terms don't change across the widening loop below) and
  // apply the SAME hygiene the lexical path applies (searchLexical):
  // drop sub-2-char and punctuation-only tokens rather than handing Postgres
  // a term that would normalize to zero lexemes. This is also what makes
  // `useFTS` mean "the FTS leg actually has something to match on", not just
  // "a non-empty string was passed" — an all-punctuation ftsQuery degrades to
  // ANN-only (or throws below, same as if ftsQuery were absent, if ANN is
  // also unavailable).
  const ftsTerms = typeof req.ftsQuery === 'string'
    ? req.ftsQuery.trim().split(/\s+/).filter(t => t.length >= 2 && hasSearchableToken(t))
    : [];
  const useFTS = ftsTerms.length > 0;
  const useANN = Array.isArray(req.queryVec) && req.queryVec.length > 0;
  if (!useFTS && !useANN) throw new Error('fusedSearch: neither ftsQuery nor queryVec provided');
  if (useANN && req.queryVec.length !== generation.dimension) {
    throw new Error(`fusedSearch: dimension mismatch (query ${req.queryVec.length}, generation ${generation.dimension})`);
  }
  const dim = generation.dimension;
  const kPlus1 = kPerSignal + 1;

  let chunkCeiling = 0;
  let filteredCeiling = 0;
  if (useANN) {
    chunkCeiling = await fusedChunkCount(db, generation);
    filteredCeiling = await filteredChunkMessageCount(db, { generation, accountIds, buildFilters });
  }

  async function runFused(exec, innerChunks) {
    const args = [];
    const bind = (v) => { args.push(v); return `$${args.length}`; };

    const accArg = bind(accountIds);
    const live = `m.account_id = ANY(${accArg}) AND m.is_deleted = false`;
    const filterAnd = buildFilters(bind).map(c => ` AND ${c}`).join('');

    const ctes = [];
    if (useFTS) {
      // One bind per term, `&&`-combined into a SINGLE tsquery used for BOTH
      // the @@ match and the ts_rank_cd rank — the same per-term prefix-or-
      // phrase construction lexicalRepo.js's lexical path uses
      // (ftsTermQueryArg), so "invo" matches "invoice" here exactly as it
      // does via searchLexical, and msgvault's fused.go shape (one combined
      // BuildFTSTerm arg for match and rank alike). `@@ (a && b)` is
      // equivalent to `@@ a AND @@ b`, and `&&` DROPS an empty operand
      // (verified against pgvector/pg16) — which is what keeps an english
      // stopword ("waiting for invoice") from zeroing the whole BM25 leg:
      // the stopword's tsquery normalizes empty and simply vanishes from the
      // combined query. An ALL-stopword ftsQuery combines to an empty tsquery
      // that matches nothing, so the leg contributes silence (not noise) and
      // the fused ranking degrades to pure ANN. ftsTermQueryArg wants the raw
      // placeholder NUMBER (it prepends its own `$`, matching lexicalRepo.js's
      // own internal convention) — push directly onto `args` rather than
      // through `bind`, which returns an already-`$`-prefixed string.
      const termArgs = ftsTerms.map((term) => { args.push(term); return args.length; });
      const tsquery = `(${ftsTerms.map((term, i) => ftsTermQueryArg(termArgs[i], term)).join(' && ')})`;
      const matchWhere = `m.search_fts @@ ${tsquery}`;
      const kp1 = bind(kPlus1);
      const k = bind(kPerSignal);
      const rank = LEXICAL_RANK_SQL('m.search_fts', tsquery);
      ctes.push(`fts_pool AS (
    SELECT m.id AS message_id, ${rank} AS bm25
      FROM messages m
     WHERE ${matchWhere}
       AND ${live}${filterAnd}
     ORDER BY bm25 DESC
     LIMIT ${kp1}
)`);
      ctes.push(`fts_ranked AS (
    SELECT message_id, bm25,
           ROW_NUMBER() OVER (ORDER BY bm25 DESC, message_id ASC) AS rnk
      FROM fts_pool
     ORDER BY bm25 DESC, message_id ASC
     LIMIT ${k}
)`);
    }
    if (useANN) {
      const vecArg = bind(vectorLiteral(req.queryVec));
      const genArg = bind(generation.id);
      const innerArg = bind(innerChunks);
      const kp1 = bind(kPlus1);
      const k = bind(kPerSignal);
      // DISTINCT ON (message_id), ordered by distance, picks the SAME min-distance
      // chunk per message as the MIN(distance)/GROUP BY form — but also
      // keeps that winning chunk's offsets, which the excerpt seam
      // needs. Offsets are code points into the PREPROCESSED text, not raw
      // body_text (README Unicode contract) — phase 5's chunkmatch.js owns
      // turning them into a raw-body byte snippet.
      ctes.push(`ann_pool AS (
    SELECT d.message_id, d.distance, d.chunk_index, d.chunk_char_start, d.chunk_char_end
      FROM (
        SELECT DISTINCT ON (ann.message_id)
               ann.message_id, ann.distance, ann.chunk_index, ann.chunk_char_start, ann.chunk_char_end
          FROM (
            SELECT e.message_id, e.chunk_index, e.chunk_char_start, e.chunk_char_end,
                   (e.embedding::vector(${dim})) <=> ${vecArg}::vector AS distance
              FROM embeddings e
             WHERE e.generation_id = ${genArg} AND e.dimension = ${dim}
               AND EXISTS (SELECT 1 FROM messages m WHERE m.id = e.message_id AND ${live}${filterAnd})
             ORDER BY e.embedding::vector(${dim}) <=> ${vecArg}::vector
             LIMIT ${innerArg}
          ) ann
         ORDER BY ann.message_id, ann.distance
      ) d
     ORDER BY d.distance
     LIMIT ${kp1}
)`);
      ctes.push(`ann_ranked AS (
    SELECT message_id, distance, chunk_index, chunk_char_start, chunk_char_end,
           ROW_NUMBER() OVER (ORDER BY distance ASC, message_id ASC) AS rnk
      FROM ann_pool
     ORDER BY distance ASC, message_id ASC
     LIMIT ${k}
)`);
    }

    const poolArgsLen = args.length;              // rrfk/limit are appended after this
    const poolCTEs = ctes.slice();
    const rrfkArg = bind(rrfK);
    const limitArg = bind(limit);

    // 1.0 is a `numeric` literal in Postgres; numeric / bigint (rnk) stays
    // numeric, and node-postgres returns numeric columns as strings (to avoid
    // silent precision loss). Cast to double precision so rrf_score/bm25_score
    // come back as JS numbers, matching msgvault's float64 RRF score.
    let fused;
    if (useFTS && useANN) {
      fused = `fused AS (
    SELECT COALESCE(b.message_id, v.message_id) AS message_id,
           COALESCE(1.0::float8 / (${rrfkArg} + b.rnk), 0.0) + COALESCE(1.0::float8 / (${rrfkArg} + v.rnk), 0.0) AS rrf_score,
           b.bm25::float8 AS bm25_score,
           CASE WHEN v.distance IS NULL THEN NULL ELSE 1.0::float8 - v.distance END AS vector_score,
           v.chunk_index AS best_chunk_index, v.chunk_char_start AS best_char_start, v.chunk_char_end AS best_char_end
      FROM fts_ranked b
      FULL OUTER JOIN ann_ranked v USING (message_id)
)`;
    } else if (useFTS) {
      fused = `fused AS (
    SELECT b.message_id, 1.0::float8 / (${rrfkArg} + b.rnk) AS rrf_score,
           b.bm25::float8 AS bm25_score, CAST(NULL AS double precision) AS vector_score,
           CAST(NULL AS int) AS best_chunk_index, CAST(NULL AS int) AS best_char_start, CAST(NULL AS int) AS best_char_end
      FROM fts_ranked b
)`;
    } else {
      fused = `fused AS (
    SELECT v.message_id, 1.0::float8 / (${rrfkArg} + v.rnk) AS rrf_score,
           CAST(NULL AS double precision) AS bm25_score, 1.0::float8 - v.distance AS vector_score,
           v.chunk_index AS best_chunk_index, v.chunk_char_start AS best_char_start, v.chunk_char_end AS best_char_end
      FROM ann_ranked v
)`;
    }
    ctes.push(fused);

    const ftsPoolExpr = useFTS ? '(SELECT count(*) FROM fts_pool)' : '0';
    const annPoolExpr = useANN ? '(SELECT count(*) FROM ann_pool)' : '0';

    const sql = `WITH ${ctes.join(',\n')}
SELECT ${DISPLAY_COLS},
       f.rrf_score, f.bm25_score, f.vector_score,
       f.best_chunk_index, f.best_char_start, f.best_char_end,
       ${ftsPoolExpr} AS fts_pool_size,
       ${annPoolExpr} AS ann_pool_size
  FROM fused f
  JOIN messages m ON m.id = f.message_id
  JOIN email_accounts a ON a.id = m.account_id
 ORDER BY f.rrf_score DESC, f.message_id ASC
 LIMIT ${limitArg}`;

    const { rows } = await exec.query(sql, args);
    let ftsPoolSize = 0;
    let annPoolSize = 0;
    if (rows.length > 0) {
      ftsPoolSize = rows[0].fts_pool_size;
      annPoolSize = rows[0].ann_pool_size;
    } else {
      // Empty result: the pool-size subqueries never fired (they ride the row
      // stream). Re-run a prefix-only count over just the pool CTEs and their
      // args (drop the trailing rrfk/limit args). Port of fused.go:322-342.
      const prefix = `WITH ${poolCTEs.join(',\n')}\n`;
      const prefixArgs = args.slice(0, poolArgsLen);
      if (useFTS) {
        ftsPoolSize = (await exec.query(prefix + 'SELECT count(*)::int AS n FROM fts_pool', prefixArgs)).rows[0].n;
      }
      if (useANN) {
        annPoolSize = (await exec.query(prefix + 'SELECT count(*)::int AS n FROM ann_pool', prefixArgs)).rows[0].n;
      }
    }
    const hits = rows.map((row) => {
      const h = { ...row };
      delete h.fts_pool_size;
      delete h.ann_pool_size;
      return h;
    });
    return { hits, ftsPoolSize, annPoolSize };
  }

  // Candidate-widening loop (port of fused.go:346-380). Start wide enough that
  // the common single-chunk case is one query; grow innerChunks (doubling,
  // capped by chunkCeiling) only while the ANN dedup collapses the pool below
  // kPerSignal+1 and more chunks remain. FTS never collapses, so only ANN drives it.
  let innerChunks = kPlus1 * FUSED_ANN_CHUNKS_PER_MESSAGE;
  let result;
  let prevAnnPool = -1;
  for (;;) {
    if (useANN && chunkCeiling > 0 && innerChunks > chunkCeiling) innerChunks = chunkCeiling;
    // Each ANN attempt sets hnsw.ef_search to its OWN inner LIMIT (capped at
    // HNSW_EF_SEARCH_MAX): at the pgvector default of 40 the HNSW scan
    // truncated every attempt to ~40 chunks and this loop re-ran an identical
    // plan up to the ceiling. FTS-only requests skip the transaction — no ANN
    // scan, nothing to tune.
    result = useANN
      ? await withEfSearch(db, innerChunks, (tx) => runFused(tx, innerChunks))
      : await runFused(db, innerChunks);
    if (!useANN ||
        result.annPoolSize >= kPlus1 ||
        result.annPoolSize >= filteredCeiling ||
        innerChunks >= chunkCeiling) break;
    // A widened re-run that failed to GROW the pool will never grow it (the
    // graph/ef_search budget is saturated) — stop instead of doubling toward
    // the ceiling for identical results.
    if (result.annPoolSize <= prevAnnPool) break;
    prevAnnPool = result.annPoolSize;
    let next = innerChunks * 2;
    if (chunkCeiling > 0 && next > chunkCeiling) next = chunkCeiling;
    if (next === innerChunks) break;
    innerChunks = next;
  }

  const poolSaturated = result.ftsPoolSize > kPerSignal || result.annPoolSize > kPerSignal;
  return { hits: result.hits, poolSaturated, generation };
}
