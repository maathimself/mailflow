import { query as dbQuery } from './db.js';

// Fills message_search (migration 0080) for HTML-only messages stored before the migration.
// New and rewritten bodies are covered by the migration's trigger, so this runs once: it walks
// the mail cache in id order, a small batch at a time with a pause between batches so it never
// competes with sync or users for long, and records that it finished in system_settings.
// A restart before then starts over from the beginning; ON CONFLICT skips rows already done.
export const BACKFILL_SETTING = 'message_search_backfilled';

export async function backfillMessageSearch({
  query = dbQuery, batchSize = 500, pauseMs = 200, sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const done = await query('SELECT value FROM system_settings WHERE key = $1', [BACKFILL_SETTING]);
  if (done.rows[0]?.value === 'true') return { filled: 0, skipped: true };

  let after = '00000000-0000-0000-0000-000000000000';
  let filled = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT id FROM messages
        WHERE id > $1 AND body_text IS NULL AND body_html IS NOT NULL
        ORDER BY id LIMIT $2`,
      [after, batchSize]
    );
    if (!rows.length) break;
    const ids = rows.map(r => r.id);
    const inserted = await query(
      `INSERT INTO message_search (message_id, body_text)
       SELECT id, mf_html_to_text(body_html) FROM messages
        WHERE id = ANY($1::uuid[]) AND body_text IS NULL AND body_html IS NOT NULL
       ON CONFLICT (message_id) DO NOTHING`,
      [ids]
    );
    filled += inserted.rowCount ?? 0;
    after = ids[ids.length - 1];
    if (rows.length < batchSize) break;
    await sleep(pauseMs);
  }

  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, 'true', NOW())
     ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`,
    [BACKFILL_SETTING]
  );
  return { filled, skipped: false };
}
