import { setTimeout as delay } from 'node:timers/promises';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function requireTestDatabaseUrl(description) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(`TEST_DATABASE_URL is required for ${description}`);
  }
  return databaseUrl;
}

export function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function connectionStringFor(databaseUrl, databaseName) {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function postgresTestContext(description) {
  const databaseUrl = requireTestDatabaseUrl(description);
  return {
    databaseUrl,
    connectionStringFor: databaseName => connectionStringFor(databaseUrl, databaseName),
  };
}

export async function createTestDatabase(adminClient, databaseName) {
  await adminClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
}

export async function dropTestDatabase(adminClient, databaseName) {
  await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
}

export async function assertMinimumPostgresVersion(client, minimumVersion = 160000) {
  const { rows: [server] } = await client.query(
    "SELECT current_setting('server_version_num')::int AS version_num",
  );
  if (server.version_num < minimumVersion) {
    throw new Error(
      `PostgreSQL ${minimumVersion} or newer is required; found ${server.version_num}`,
    );
  }
  return server.version_num;
}

export function productionDatabaseEnvironment(encryptionKey) {
  const keys = [
    'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ENCRYPTION_KEY',
  ];
  const snapshot = Object.fromEntries(keys.map(key => [key, process.env[key]]));

  let configuredUrl;
  return {
    configure(connectionString) {
      const url = new URL(connectionString);
      configuredUrl = url;
      process.env.DB_HOST = url.hostname;
      process.env.DB_PORT = url.port || '5432';
      process.env.DB_NAME = decodeURIComponent(url.pathname.slice(1));
      process.env.DB_USER = decodeURIComponent(url.username);
      process.env.DB_PASSWORD = decodeURIComponent(url.password);
      process.env.ENCRYPTION_KEY = encryptionKey;
    },
    configurePool(pool) {
      if (!configuredUrl) throw new Error('Production database environment is not configured');
      pool.options.host = configuredUrl.hostname;
      pool.options.port = Number(configuredUrl.port || 5432);
      pool.options.database = decodeURIComponent(configuredUrl.pathname.slice(1));
      pool.options.user = decodeURIComponent(configuredUrl.username);
      pool.options.password = decodeURIComponent(configuredUrl.password);
    },
    restore() {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export async function applyTestMigrations(client, {
  migrationsDirectory,
  first = '0001',
  through = '9999',
  transactionPerMigration = false,
} = {}) {
  const filenames = (await readdir(migrationsDirectory))
    .filter(filename => /^\d{4}_.+\.sql$/.test(filename))
    .filter(filename => filename.slice(0, 4) >= first)
    .filter(filename => filename.slice(0, 4) <= through)
    .sort();

  for (const filename of filenames) {
    const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
    if (/^--\s*no-transaction\b/im.test(sql)) {
      const statements = sql
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map(statement => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await client.query(statement);
      continue;
    }

    if (!transactionPerMigration) {
      await client.query(sql);
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

export async function waitForPostgresState({ description, probe, timeoutMs = 10_000 }) {
  const deadline = performance.now() + timeoutMs;
  const probeTimedOut = Symbol('probe timed out');
  let lastState = null;

  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    let timeoutId;
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(probe),
        new Promise(resolve => {
          timeoutId = setTimeout(resolve, remainingMs, probeTimedOut);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (result === probeTimedOut || performance.now() >= deadline) break;

    const { done, state } = result;
    lastState = state;
    if (done) return state;

    const delayMs = Math.min(25, deadline - performance.now());
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }

  throw new Error(
    `Timed out waiting for ${description} within ${timeoutMs} ms; `
    + `last observed state: ${JSON.stringify(lastState)}`,
  );
}
