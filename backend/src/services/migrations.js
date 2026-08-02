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
    // Disable statement_timeout for the migration client — bulk backfill migrations
    // (0002, 0017) can take longer than the 30 s pool default on large databases.
    await client.query('SET statement_timeout = 0');

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
        // Execute each statement individually. Sending a multi-statement string
        // as one client.query() call causes pg to use PostgreSQL's simple query
        // protocol, which wraps all statements in a single implicit transaction —
        // blocking CONCURRENTLY operations. Running them one at a time avoids this.
        const statements = sql
          .replace(/--[^\n]*/g, '')  // strip single-line comments
          .split(';')
          .map(s => s.trim())
          .filter(Boolean);
        for (const stmt of statements) {
          await client.query(stmt);
        }
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

// --- Collation-version drift check (best-effort, never aborts boot) ---------------
// The compose move from postgres:16-alpine (musl libc) to pgvector/pgvector:pg16
// (Debian, glibc) silently changes how the OS collates text. Postgres records the
// collation version a database was created under (pg_database.datcollversion, PG15+);
// pg_database_collation_actual_version(oid) reports what the running server's libc/ICU
// provides NOW. Two shapes of drift matter here (field-verified on both images):
//   - recorded != actual: a versioned libc changed underneath (e.g. a glibc bump).
//     Postgres emits its own per-connection WARNING for this, easily lost in logs.
//   - recorded IS NULL while actual is not: the database was created under a libc
//     that reports NO collation version — exactly what musl/alpine does — and now
//     runs under glibc. This is the actual alpine → pgvector upgrade signature, and
//     Postgres itself stays completely SILENT about it.
// (actual is NULL for versionless locales like C/POSIX — byte-order collation is
// immune to libc swaps, so there is nothing to warn about.)
// Either way, text indexes built under the old ordering may silently return wrong or
// missing rows until reindexed, so surface it loudly at boot with the remedy. The
// REFRESH COLLATION VERSION step records the current version and silences this
// warning on subsequent boots. Returns whether a mismatch was reported
// (observability only; never throws).
export async function warnOnCollationMismatch(deps = {}) {
  const q = deps.query || ((text) => pool.query(text));
  const warn = deps.warn || console.warn;
  try {
    const { rows } = await q(`
      SELECT current_database() AS db,
             datcollversion AS recorded,
             pg_database_collation_actual_version(oid) AS actual
      FROM pg_database
      WHERE datname = current_database()
    `);
    const r = rows[0];
    if (!r || !r.actual || r.recorded === r.actual) return false;
    const origin = r.recorded
      ? [
        `  Database "${r.db}" was created under collation version ${r.recorded}, but`,
        `  the operating system now provides ${r.actual}.`,
      ]
      : [
        `  Database "${r.db}" was created under a C library that reported no collation`,
        `  version (e.g. postgres:16-alpine/musl); the current one provides ${r.actual}.`,
      ];
    warn([
      '='.repeat(76),
      'WARNING: database collation version mismatch detected',
      '',
      ...origin,
      '  This happens when the Postgres image\'s C library changes — e.g. the',
      '  docker-compose switch from postgres:16-alpine (musl) to',
      '  pgvector/pgvector:pg16 (glibc).',
      '',
      '  Text indexes built under the old collation can silently return wrong or',
      '  missing rows. Reindex once, then record the new version:',
      '',
      `      docker compose exec postgres psql -U mailflow -d ${r.db} \\`,
      `        -c 'REINDEX DATABASE "${r.db}";' \\`,
      `        -c 'ALTER DATABASE "${r.db}" REFRESH COLLATION VERSION;'`,
      '='.repeat(76),
    ].join('\n'));
    return true;
  } catch (err) {
    // Postgres < 15 has no datcollversion; a restricted role may not read pg_database.
    // The check is observability only — never block or fail the boot on it.
    console.log(`Collation version check skipped: ${err.message}`);
    return false;
  }
}
