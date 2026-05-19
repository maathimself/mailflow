import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { pool } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function getMigrationFiles() {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return Promise.all(
    files.map(async filename => ({
      version: filename.replace(/\.sql$/, ''),
      sql: await readFile(join(MIGRATIONS_DIR, filename), 'utf8'),
    }))
  );
}

export async function runMigrations() {
  const client = await pool.connect();
  try {
    // Session-level advisory lock: held across individual migration transactions,
    // unlike pg_advisory_xact_lock which releases at each COMMIT and would let
    // a second runner acquire the lock between migrations.
    await client.query('SELECT pg_advisory_lock(7418291834)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = new Set(rows.map(r => r.version));

    const migrations = await getMigrationFiles();

    let ran = 0;
    for (const { version, sql } of migrations) {
      if (applied.has(version)) continue;
      console.log(`Migrations: applying ${version}`);

      // A migration whose first line is "-- no-transaction" runs outside a
      // transaction. Use this for CREATE INDEX CONCURRENTLY or data rewrites
      // that must not hold an open transaction for minutes. The migration must
      // be idempotent (use IF NOT EXISTS / IF EXISTS / ON CONFLICT) because a
      // crash after the SQL but before the schema_migrations INSERT will cause
      // it to be retried on next startup.
      const noTransaction = /^--\s*no-transaction\b/im.test(sql);

      if (noTransaction) {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version],
        );
      } else {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [version],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }
      ran++;
    }

    if (ran > 0) console.log(`Migrations: ${ran} migration(s) applied`);
    else console.log('Migrations: schema up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(7418291834)').catch(() => {});
    client.release();
  }
}
