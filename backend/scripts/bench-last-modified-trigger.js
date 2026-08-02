// Benchmark the last_modified trigger overhead on the hot re-sync UPSERT.
// Usage: node scripts/bench-last-modified-trigger.js [rows=5000] [iters=20000]
// Requires DB_* env pointing at a migrated Postgres (trigger present).
import { pool } from '../src/services/db.js';
import { seedAccount, cleanupAccount } from '../src/services/embeddings/testSupport.js';

const ROWS = Number(process.argv[2]) || 5000;
const ITERS = Number(process.argv[3]) || 20000;

const { accountId: acctId, userId } = await seedAccount(pool, 'bench');
const ids = [];
for (let i = 0; i < ROWS; i++) {
  const r = await pool.query(`INSERT INTO messages (account_id, uid, folder, subject, is_read)
    VALUES ($1, $2, 'INBOX', 'bench', false) RETURNING id`, [acctId, 700000 + i]);
  ids.push(r.rows[0].id);
}

// Flag-only churn: toggles is_read (NOT an embedding-input column) so the trigger's
// WHEN clause should skip the function entirely.
async function churn() {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) {
    const id = ids[i % ids.length];
    await pool.query('UPDATE messages SET is_read = NOT is_read WHERE id = $1', [id]);
  }
  return Number(process.hrtime.bigint() - t0) / 1e6; // ms
}

const withTrig = await churn();
await pool.query('DROP TRIGGER IF EXISTS trg_messages_last_modified ON messages');
const withoutTrig = await churn();
// Restore the trigger.
await pool.query(`CREATE TRIGGER trg_messages_last_modified
  BEFORE UPDATE ON messages FOR EACH ROW
  WHEN (NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body_text IS DISTINCT FROM OLD.body_text OR NEW.body_html IS DISTINCT FROM OLD.body_html)
  EXECUTE FUNCTION messages_bump_last_modified()`);

await cleanupAccount(pool, userId);
await pool.end();

const regression = ((withTrig - withoutTrig) / withoutTrig) * 100;
console.log(`with trigger:    ${withTrig.toFixed(0)} ms`);
console.log(`without trigger: ${withoutTrig.toFixed(0)} ms`);
console.log(`regression:      ${regression.toFixed(1)}%  (gate: < 10%)`);
process.exit(regression < 10 ? 0 : 2);
