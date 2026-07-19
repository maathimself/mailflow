import { query } from '../db.js';
import { searchFtsExpr, FTS_VERSION } from './lexicalRepo.js';
import { upsertJob } from '../backgroundJobs.js';

const KIND = 'fts_backfill';
const BATCH = 3000;                 // 2–5k rows/batch
const IDLE_MS = 5 * 60 * 1000;
const defaultSleep = () => new Promise((r) => setTimeout(r, 250));

let running = false;

// FTS_VERSION is inlined as a literal (not a bind param) so the predicate
// matches the partial index idx_messages_fts_stale_v1 exactly and the batch
// scan is index-served rather than a growing seq scan as the tail drains.
const STALE_PRED = `fts_version IS DISTINCT FROM ${FTS_VERSION}`;

const batchSql = `
  WITH batch AS (
    SELECT id FROM messages
     WHERE ${STALE_PRED}
     ORDER BY date DESC NULLS LAST
     LIMIT $1
  )
  UPDATE messages m
     SET search_fts = ${searchFtsExpr('m')},
         fts_version = ${FTS_VERSION}
    FROM batch
   WHERE m.id = batch.id
`;

async function processBatch() {
  try {
    const res = await query(batchSql, [BATCH]);
    return res.rowCount;
  } catch (err) {
    if (err.code !== '54000') throw err; // program_limit_exceeded
    return processBatchRowByRow();
  }
}

// A single pathological body tripped SQLSTATE 54000 for the whole batch.
// Re-process row by row so one bad row can't wedge the drainer.
async function processBatchRowByRow() {
  const { rows } = await query(
    `SELECT id FROM messages WHERE ${STALE_PRED} ORDER BY date DESC NULLS LAST LIMIT $1`,
    [BATCH]
  );
  let done = 0;
  for (const { id } of rows) {
    try {
      await query(
        `UPDATE messages m SET search_fts = ${searchFtsExpr('m')}, fts_version = ${FTS_VERSION} WHERE m.id = $1`,
        [id]
      );
    } catch (err) {
      if (err.code !== '54000') throw err;
      // Stamp the version so it is never retried; leave search_fts NULL (still
      // served by the ILIKE fallback in lexicalRepo).
      await query(`UPDATE messages SET fts_version = ${FTS_VERSION} WHERE id = $1 AND search_fts IS NULL`, [id]);
      console.warn(`FTS backfill: skipped oversized message ${id} (tsvector too large)`);
    }
    done++;
  }
  return done;
}

export async function runFtsBackfill({ sleep = defaultSleep } = {}) {
  if (running) return; // single-flight
  running = true;
  try {
    const { rows: [{ remaining }] } = await query(
      `SELECT count(*)::int AS remaining FROM messages WHERE ${STALE_PRED}`
    );
    if (remaining === 0) {
      await upsertJob({ kind: KIND, state: 'done', processed: 0, total: 0 });
      return;
    }
    const total = remaining;
    let processed = 0;
    await upsertJob({ kind: KIND, state: 'running', processed, total });

    while (true) {
      let n;
      try {
        n = await processBatch();
      } catch (err) {
        await upsertJob({ kind: KIND, state: 'error', processed, total, lastError: err.message });
        throw err;
      }
      if (n === 0) break;
      processed += n;
      await upsertJob({ kind: KIND, state: 'running', processed: Math.min(processed, total), total });
      await sleep();
    }
    await upsertJob({ kind: KIND, state: 'done', processed: total, total });
  } finally {
    running = false;
  }
}

export function scheduleFtsBackfill() {
  runFtsBackfill().catch((err) => console.error('FTS backfill error:', err.message));
  const timer = setInterval(() => {
    runFtsBackfill().catch((err) => console.error('FTS backfill error:', err.message));
  }, IDLE_MS);
  timer.unref?.();
  return timer;
}
