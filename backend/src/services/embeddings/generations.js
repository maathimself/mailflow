import { pool, withTransaction } from '../db.js';
import { ensureVectorIndex } from './vectorStore.js';

export class BuildingInProgressError extends Error {}
export class NoActiveGenerationError extends Error {}

const LIVE = 'is_deleted = false';

// Coverage gate predicate: a generation is fully covered when NO live message still
// needs embedding for it. Port of backend.go missingForGenExistsClause.
export async function coverageMissing(gen) {
  const r = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM messages WHERE (embed_gen IS NULL OR embed_gen <> $1) AND ${LIVE}) missing`,
    [gen],
  );
  return r.rows[0].missing;
}

// activated_at/started_at are epoch SECONDS (bigint); get_stats' generation
// summaries surface them (active → activated_at, building → started_at), so both
// must be selected here or vectorStats only ever sees undefined and the wire
// fields collapse to "". node-pg returns bigint as a string; the wire formatter
// in vectorStats coerces + renders RFC3339.
async function generationByState(state) {
  const r = await pool.query(
    `SELECT id, model, dimension, fingerprint, state, message_count AS "messageCount",
            activated_at AS "activatedAt", started_at AS "startedAt"
       FROM index_generations WHERE state = $1`,
    [state],
  );
  return r.rows[0] || null;
}

export async function activeGeneration() { return generationByState('active'); }
export async function buildingGeneration() { return generationByState('building'); }

// Distinct embedded-message count for a generation — a direct port of msgvault's
// Backend.Stats EmbeddingCount (internal/vector/pgvector/backend.go): "distinct
// messages, not chunk rows — a long message occupies multiple rows but counts as
// one embedded message". get_stats' collectStats consumes it for both
// active_generation.message_count and the building generation's progress.done,
// so COUNT(DISTINCT message_id) is required — COUNT(*) would inflate the count by
// every extra chunk a long message carries (live: 18,193 chunk rows vs 18,192
// distinct messages → message_count 18,192, matching the index_generations
// .message_count column upsert maintains). Scoped to one generation_id (msgvault's
// gen != 0 path); the aggregate gen == 0 path is unused here. Kept named
// `chunkCount` per the frozen cross-phase contract (README vectorStore bullet)
// even though the value is a message count, not a chunk count.
export async function chunkCount(gen) {
  const r = await pool.query(
    'SELECT COUNT(DISTINCT message_id)::bigint AS n FROM embeddings WHERE generation_id = $1',
    [gen],
  );
  return Number(r.rows[0].n);
}

// Claim-or-insert a building generation. A same-fingerprint building row is resumed
// (returns its id); a mismatched building fingerprint → BuildingInProgressError. Ensures
// the per-dimension HNSW index exists first (port of backend.go CreateGeneration).
export async function createGeneration(model, dim, fingerprint) {
  await ensureVectorIndex(dim);
  const fp = fingerprint || `${model}:${dim}`;
  const now = Math.floor(Date.now() / 1000);
  const existing = await buildingGeneration();
  if (existing) {
    if (existing.fingerprint !== fp) {
      throw new BuildingInProgressError(`building fingerprint=${existing.fingerprint}, requested=${fp} — activate or retire it first`);
    }
    return existing.id;
  }
  try {
    return await withTransaction(async (client) => {
      await client.query('SET LOCAL statement_timeout = 0'); // corpus-size reset may exceed 30s
      const r = await client.query(
        `INSERT INTO index_generations (model, dimension, fingerprint, started_at, seeded_at, state)
         VALUES ($1,$2,$3,$4,$4,'building') RETURNING id`,
        [model, dim, fp, now],
      );
      // Reset every live row's stale stamp so scanForEmbedding (embed_gen IS NULL)
      // finds each row that must be (re)embedded under the new generation — the
      // invariant that lets the scan use the partial pending index. Atomic with the
      // insert so a crash never strands prior-generation rows the NULL-only scan can't
      // see. Skips already-NULL rows; only fires the last_modified trigger's WHEN
      // clause on subject/body columns, so a pure embed_gen reset never bumps it.
      await client.query('UPDATE messages SET embed_gen = NULL WHERE embed_gen IS NOT NULL AND is_deleted = false');
      return r.rows[0].id;
    });
  } catch (err) {
    if (err.code === '23505') { // unique_violation on idx_generations_building — a race
      const raced = await buildingGeneration();
      if (raced && raced.fingerprint === fp) return raced.id;
      throw new BuildingInProgressError(`building generation exists with a different fingerprint`);
    }
    throw err;
  }
}

// Retire the current active (if any) and promote gen. The auto-retire DELETEs the
// demoted generation's rows in the same tx (shared per-dimension HNSW graph, README
// invariant). Coverage gate folded into the promote UPDATE unless force.
export async function activateGeneration(gen, force = false) {
  const now = Math.floor(Date.now() / 1000);
  await withTransaction(async (client) => {
    await client.query('SET LOCAL statement_timeout = 0'); // corpus-size DELETE may exceed 30s
    const demoted = await client.query(
      `UPDATE index_generations SET state = 'retired', completed_at = COALESCE(completed_at, $1)
        WHERE state = 'active' RETURNING id`,
      [now],
    );
    if (demoted.rows.length) {
      await client.query('DELETE FROM embeddings WHERE generation_id = $1', [demoted.rows[0].id]);
    }
    const res = await client.query(
      `UPDATE index_generations
          SET state = 'active', activated_at = $1, completed_at = COALESCE(completed_at, $2)
        WHERE id = $3 AND state = 'building'
          AND ($4 OR NOT EXISTS (SELECT 1 FROM messages WHERE (embed_gen IS NULL OR embed_gen <> $3) AND ${LIVE}))`,
      [now, now, gen, force],
    );
    if (res.rowCount === 0) {
      const st = await client.query('SELECT state FROM index_generations WHERE id = $1', [gen]);
      if (!st.rows.length) throw new Error(`unknown generation ${gen}`);
      if (st.rows[0].state !== 'building') throw new Error(`generation ${gen} not in 'building' state`);
      throw new Error(`generation ${gen} still has messages needing embedding; pass force to override`);
    }
  });
}

// Mark gen retired and DELETE its rows. Refuses to retire an active generation unless force.
export async function retireGeneration(gen, force = false) {
  await withTransaction(async (client) => {
    await client.query('SET LOCAL statement_timeout = 0');
    const res = await client.query(
      `UPDATE index_generations SET state = 'retired' WHERE id = $1 AND ($2 OR state != 'active')`,
      [gen, force],
    );
    if (res.rowCount === 0) {
      const st = await client.query('SELECT state FROM index_generations WHERE id = $1', [gen]);
      if (!st.rows.length) throw new Error(`unknown generation ${gen}`);
      if (st.rows[0].state === 'active' && !force) throw new Error(`refusing to retire active generation ${gen} without force`);
      throw new Error(`retire generation ${gen}: no rows affected (state=${st.rows[0].state})`);
    }
    await client.query('DELETE FROM embeddings WHERE generation_id = $1', [gen]);
  });
}
