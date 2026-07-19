import { query } from './db.js';

// Upsert a drainer's progress row. One row per (kind, account); global jobs
// pass accountId = null. started_at is set once and preserved across updates.
export async function upsertJob({ kind, accountId = null, state, processed = 0, total = 0, lastError = null }) {
  await query(`
    INSERT INTO background_jobs (kind, account_id, state, processed, total, last_error, started_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (kind, COALESCE(account_id::text, '')) DO UPDATE SET
      state = EXCLUDED.state,
      processed = EXCLUDED.processed,
      total = EXCLUDED.total,
      last_error = EXCLUDED.last_error,
      started_at = COALESCE(background_jobs.started_at, EXCLUDED.started_at),
      updated_at = NOW()
  `, [kind, accountId, state, processed, total, lastError]);
}

export async function listJobs() {
  const { rows } = await query(
    `SELECT kind, account_id, state, processed, total, last_error, started_at, updated_at
       FROM background_jobs
      ORDER BY updated_at DESC`
  );
  return rows;
}
