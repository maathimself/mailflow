import { query } from '../services/db.js';
import * as generations from '../services/embeddings/generations.js'; // phase 3

// Epoch SECONDS (index_generations.activated_at/started_at, bigint — node-pg
// returns it as a string) → RFC3339 UTC string, matching msgvault CollectStats
// (vector/stats.go:146-153: time.Unix(sec,0).UTC().Format(time.RFC3339) — no
// sub-second digits, unlike Date.toISOString()). "" for a missing/zero/
// unparsable epoch; callers omit the field entirely then (Go omitempty on
// activated_at/started_at, stats.go:47,:56).
function epochToISO(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toISOString().replace('.000Z', 'Z');
}

// Live-message count still needing embedding, SCOPED to the caller's accounts
// (documented divergence from msgvault's single-archive count — avoids a cross-user
// cardinality leak). Frozen invariant: `embed_gen IS NULL ⟺ needs embedding` —
// createGeneration resets every live row's stamp to NULL on a rebuild, so the count
// is generation-agnostic and the old `OR embed_gen <> gen` arm was dead/double-counting.
async function missingCount(accountIds) {
  if (!accountIds || !accountIds.length) return 0;
  const { rows } = await query(
    `SELECT COUNT(*)::bigint AS n FROM messages
       WHERE account_id = ANY($1) AND is_deleted = false AND embed_gen IS NULL`,
    [accountIds],
  );
  return Number(rows[0].n);
}

// Port of vector.CollectStats. Returns null when vector search is disabled (the
// generation queries throw on stock Postgres without the vector schema); an
// enabled archive with no active generation yet reports active_generation: null.
// Generation metadata is archive-global; missing_embeddings_total is account-scoped.
export async function collectStats(accountIds) {
  let active;
  try {
    active = await generations.activeGeneration(); // null = none yet; throw = disabled
  } catch {
    return null;
  }

  // Sub-query failures degrade to partial data (msgvault stats.go:69-78: one
  // broken sub-query never blanks the whole stats envelope) — every leg below
  // catches and falls back rather than throwing the block away.
  const out = { enabled: true, active_generation: null, missing_embeddings_total: 0 };
  if (active) {
    const messageCount = await generations.chunkCount(active.id).catch(() => 0);
    const activatedAt = epochToISO(active.activatedAt);
    out.active_generation = {
      id: active.id, model: active.model, dimension: active.dimension,
      fingerprint: active.fingerprint, state: active.state,
      ...(activatedAt ? { activated_at: activatedAt } : {}), // omitempty (stats.go:47)
      message_count: messageCount,
    };
  }

  const building = await generations.buildingGeneration().catch(() => null);
  if (building) {
    // A rebuild in flight is the actionable coverage target; active-generation
    // top-ups are frozen until activation (msgvault CollectStats semantics).
    const done = await generations.chunkCount(building.id).catch(() => 0);
    const pending = await missingCount(accountIds).catch(() => 0);
    const startedAt = epochToISO(building.startedAt);
    out.building_generation = {
      id: building.id, model: building.model, dimension: building.dimension,
      ...(startedAt ? { started_at: startedAt } : {}), // omitempty (stats.go:56)
      progress: { done, total: done + pending },
    };
    out.missing_embeddings_total = pending;
  } else if (active) {
    out.missing_embeddings_total = await missingCount(accountIds).catch(() => 0);
  }
  return out;
}
