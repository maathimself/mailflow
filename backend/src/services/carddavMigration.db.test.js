import { randomUUID } from 'crypto';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrationsWithPool } from './migrations.js';
import {
  applyTestMigrations,
  assertMinimumPostgresVersion,
  createTestDatabase,
  dropTestDatabase,
  postgresTestContext,
} from './postgresTestHelpers.js';

const { Client, Pool } = pg;
const { databaseUrl, connectionStringFor } = postgresTestContext('CardDAV migration tests');
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const databaseSuffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const databaseNames = {
  upgrade: `carddav_upgrade_${databaseSuffix}`,
  fresh: `carddav_fresh_${databaseSuffix}`,
  runner: `carddav_runner_${databaseSuffix}`,
  failure: `carddav_failure_${databaseSuffix}`,
  populatedDisjoint: `carddav_populated_disjoint_${databaseSuffix}`,
  populatedCollision: `carddav_populated_collision_${databaseSuffix}`,
  populatedFirst: `carddav_populated_first_${databaseSuffix}`,
  emptyDuplicates: `carddav_empty_duplicates_${databaseSuffix}`,
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let adminClient;

async function applyMigrations(client, firstVersion, lastVersion) {
  await applyTestMigrations(client, {
    migrationsDirectory,
    first: firstVersion,
    through: lastVersion,
    transactionPerMigration: true,
  });
}

async function createMigrationDirectory(firstVersion, lastVersion) {
  const directory = await mkdtemp(join(tmpdir(), 'mailflow-migrations-'));
  const filenames = (await readdir(migrationsDirectory))
    .filter(filename => /^\d{4}_.+\.sql$/.test(filename))
    .filter(filename => filename.slice(0, 4) >= firstVersion)
    .filter(filename => filename.slice(0, 4) <= lastVersion);

  await Promise.all(filenames.map(filename => symlink(
    join(migrationsDirectory, filename),
    join(directory, filename),
  )));
  return directory;
}

async function readCardDavRows(client, userId) {
  const { rows: books } = await client.query(`
    SELECT *
    FROM address_books
    WHERE user_id = $1 AND source = 'carddav'
    ORDER BY id
  `, [userId]);
  const { rows: contacts } = await client.query(`
    SELECT *
    FROM contacts
    WHERE user_id = $1
    ORDER BY id
  `, [userId]);

  return { books, contacts };
}

async function withDatabase(name, callback) {
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  try {
    await callback(client);
  } finally {
    await client.end();
  }
}

async function readColumns(client, tableName) {
  const { rows } = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);

  return Object.fromEntries(rows.map(({ column_name, ...column }) => [column_name, column]));
}

async function readPrimaryKey(client, tableName) {
  const { rows } = await client.query(`
    SELECT key_column_usage.column_name
    FROM information_schema.table_constraints
    JOIN information_schema.key_column_usage
      USING (constraint_catalog, constraint_schema, constraint_name, table_catalog, table_schema, table_name)
    WHERE table_schema = 'public'
      AND table_name = $1
      AND constraint_type = 'PRIMARY KEY'
    ORDER BY key_column_usage.ordinal_position
  `, [tableName]);

  return rows.map(row => row.column_name);
}

async function readForeignKeys(client, tableName) {
  const { rows } = await client.query(`
    SELECT source_attribute.attname AS column_name,
           target_table.relname AS referenced_table,
           target_attribute.attname AS referenced_column,
           CASE constraint_row.confdeltype
             WHEN 'a' THEN 'NO ACTION'
             WHEN 'r' THEN 'RESTRICT'
             WHEN 'c' THEN 'CASCADE'
             WHEN 'n' THEN 'SET NULL'
             WHEN 'd' THEN 'SET DEFAULT'
           END AS delete_rule
    FROM pg_constraint constraint_row
    JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
    JOIN pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
    JOIN pg_class target_table ON target_table.oid = constraint_row.confrelid
    JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
      WITH ORDINALITY AS key_columns(source_attnum, target_attnum, position) ON true
    JOIN pg_attribute source_attribute
      ON source_attribute.attrelid = source_table.oid
     AND source_attribute.attnum = key_columns.source_attnum
    JOIN pg_attribute target_attribute
      ON target_attribute.attrelid = target_table.oid
     AND target_attribute.attnum = key_columns.target_attnum
    WHERE source_schema.nspname = 'public'
      AND source_table.relname = $1
      AND constraint_row.contype = 'f'
    ORDER BY source_attribute.attname
  `, [tableName]);

  return rows;
}

async function readChecks(client, tableNames) {
  const { rows } = await client.query(`
    SELECT table_constraints.table_name, check_constraints.check_clause
    FROM information_schema.table_constraints
    JOIN information_schema.check_constraints
      USING (constraint_catalog, constraint_schema, constraint_name)
    WHERE table_constraints.table_schema = 'public'
      AND table_constraints.table_name = ANY($1::text[])
      AND table_constraints.constraint_type = 'CHECK'
    ORDER BY table_constraints.table_name, table_constraints.constraint_name
  `, [tableNames]);

  return rows;
}

async function readIndexDefinitions(client, indexNames) {
  const { rows } = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY($1::text[])
    ORDER BY indexname
  `, [indexNames]);

  return Object.fromEntries(rows.map(({ indexname, indexdef }) => [
    indexname,
    indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING btree /, '$1'),
  ]));
}

async function expectIncrementalSchema(client) {
  const addressBookColumns = await readColumns(client, 'address_books');
  expect(addressBookColumns).toMatchObject({
    remote_sync_token: { data_type: 'text', is_nullable: 'YES' },
    remote_sync_capability: { data_type: 'text', is_nullable: 'NO' },
    remote_sync_revision: { data_type: 'bigint', is_nullable: 'NO' },
    remote_projection_fingerprint: { data_type: 'text', is_nullable: 'YES' },
  });

  const remoteObjectColumns = await readColumns(client, 'carddav_remote_objects');
  expect(remoteObjectColumns).toMatchObject({
    address_book_id: { data_type: 'uuid', is_nullable: 'NO' },
    href: { data_type: 'text', is_nullable: 'NO' },
    remote_etag: { data_type: 'text', is_nullable: 'YES' },
    vcard: { data_type: 'text', is_nullable: 'NO' },
    primary_email: { data_type: 'text', is_nullable: 'YES' },
    disposition: { data_type: 'text', is_nullable: 'NO' },
    local_contact_id: { data_type: 'uuid', is_nullable: 'YES' },
    merge_before: { data_type: 'jsonb', is_nullable: 'YES' },
    merge_applied: { data_type: 'jsonb', is_nullable: 'YES' },
    created_at: { data_type: 'timestamp with time zone', is_nullable: 'NO' },
    updated_at: { data_type: 'timestamp with time zone', is_nullable: 'NO' },
  });

  expect(await readPrimaryKey(client, 'carddav_remote_objects'))
    .toEqual(['address_book_id', 'href']);

  expect(await readForeignKeys(client, 'carddav_remote_objects')).toEqual([
    {
      column_name: 'address_book_id',
      referenced_table: 'address_books',
      referenced_column: 'id',
      delete_rule: 'CASCADE',
    },
    {
      column_name: 'local_contact_id',
      referenced_table: 'contacts',
      referenced_column: 'id',
      delete_rule: 'SET NULL',
    },
  ]);

  expect(await readChecks(client, ['address_books', 'carddav_remote_objects'])).toEqual(
    expect.arrayContaining([
      {
        table_name: 'address_books',
        check_clause: "((remote_sync_capability = ANY (ARRAY['unknown'::text, 'sync-collection'::text, 'snapshot'::text])))",
      },
      {
        table_name: 'carddav_remote_objects',
        check_clause: "((disposition = ANY (ARRAY['separate'::text, 'merge'::text, 'skip'::text])))",
      },
    ]),
  );

  const indexDefinitions = await readIndexDefinitions(client, [
    'carddav_one_remote_book_idx',
    'carddav_remote_object_contact_idx',
    'carddav_remote_object_email_idx',
    'carddav_one_merge_source_per_contact_idx',
  ]);
  const definitions = Object.values(indexDefinitions);
  expect(definitions).toContainEqual(expect.stringContaining(
    'UNIQUE (user_id, external_url) WHERE',
  ));
  expect(definitions).toContainEqual(expect.stringContaining(
    "WHERE ((disposition = 'merge'::text) AND (local_contact_id IS NOT NULL))",
  ));
  expect(definitions).toContain(
    "UNIQUE (user_id, external_url) WHERE ((source = 'carddav'::text) AND (external_url IS NOT NULL))",
  );
  expect(definitions).toContain(
    "UNIQUE (local_contact_id) WHERE ((disposition = 'merge'::text) AND (local_contact_id IS NOT NULL))",
  );
  expect(definitions).toContain(
    '(local_contact_id) WHERE (local_contact_id IS NOT NULL)',
  );
  expect(definitions).toContain('(address_book_id, primary_email)');

  const userId = randomUUID();
  const contactId = randomUUID();
  await client.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `carddav-migration-${userId}`],
  );
  const { rows: [addressBook] } = await client.query(`
    INSERT INTO address_books (user_id, name, source, external_url)
    VALUES ($1, 'Remote', 'carddav', $2)
    RETURNING id, remote_sync_revision
  `, [userId, `https://carddav.example.test/${userId}`]);
  expect(addressBook.remote_sync_revision).toBe('0');

  await client.query(`
    INSERT INTO contacts (id, address_book_id, user_id, uid, vcard, display_name)
    VALUES ($1, $2, $3, 'indexed-contact', 'BEGIN:VCARD\r\nEND:VCARD\r\n', 'Indexed Contact')
  `, [contactId, addressBook.id, userId]);
  await client.query(`
    INSERT INTO carddav_remote_objects (
      address_book_id, href, vcard, primary_email, disposition, local_contact_id
    ) VALUES
      ($1, '/indexed.vcf', 'BEGIN:VCARD\r\nEND:VCARD\r\n', 'indexed@example.test', 'separate', $2),
      ($1, '/skipped.vcf', 'BEGIN:VCARD\r\nEND:VCARD\r\n', NULL, 'skip', NULL)
  `, [addressBook.id, contactId]);

  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query(`
      EXPLAIN (FORMAT JSON)
      SELECT href FROM carddav_remote_objects WHERE local_contact_id = $1
    `, [contactId]);
    expect(JSON.stringify(rows[0]['QUERY PLAN'])).toContain(
      '"Index Name":"carddav_remote_object_contact_idx"',
    );
  } finally {
    await client.query('ROLLBACK');
  }
}

async function expectBidirectionalSchema(client) {
  const addressBookColumns = await readColumns(client, 'address_books');
  expect(addressBookColumns).toMatchObject({
    remote_create_capability: {
      data_type: 'text',
      is_nullable: 'NO',
      column_default: "'unknown'::text",
    },
    remote_update_capability: {
      data_type: 'text',
      is_nullable: 'NO',
      column_default: "'unknown'::text",
    },
    remote_delete_capability: {
      data_type: 'text',
      is_nullable: 'NO',
      column_default: "'unknown'::text",
    },
  });

  const contactColumns = await readColumns(client, 'contacts');
  expect(contactColumns.additional_fields).toEqual({
    data_type: 'jsonb',
    is_nullable: 'NO',
    column_default: "'[]'::jsonb",
  });

  const mappingColumns = await readColumns(client, 'carddav_remote_objects');
  expect(mappingColumns).toEqual({
    address_book_id: { data_type: 'uuid', is_nullable: 'NO', column_default: null },
    href: { data_type: 'text', is_nullable: 'NO', column_default: null },
    remote_etag: { data_type: 'text', is_nullable: 'YES', column_default: null },
    vcard: { data_type: 'text', is_nullable: 'NO', column_default: null },
    primary_email: { data_type: 'text', is_nullable: 'YES', column_default: null },
    disposition: {
      data_type: 'text',
      is_nullable: 'NO',
      column_default: "'separate'::text",
    },
    local_contact_id: { data_type: 'uuid', is_nullable: 'YES', column_default: null },
    merge_before: { data_type: 'jsonb', is_nullable: 'YES', column_default: null },
    merge_applied: { data_type: 'jsonb', is_nullable: 'YES', column_default: null },
    created_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
      column_default: 'now()',
    },
    updated_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
      column_default: 'now()',
    },
    mapping_status: {
      data_type: 'text',
      is_nullable: 'NO',
      column_default: "'pending_materialization'::text",
    },
    vcard_version: { data_type: 'text', is_nullable: 'YES', column_default: null },
    remote_semantic_hash: { data_type: 'text', is_nullable: 'YES', column_default: null },
    local_contact_hash: { data_type: 'text', is_nullable: 'YES', column_default: null },
    mapping_revision: { data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
    last_synced_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
    last_push_error_code: { data_type: 'text', is_nullable: 'YES', column_default: null },
    last_push_error_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
    legacy_projection: { data_type: 'jsonb', is_nullable: 'YES', column_default: null },
  });

  const conflictColumns = await readColumns(client, 'carddav_conflicts');
  expect(conflictColumns).toEqual({
    id: { data_type: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
    address_book_id: { data_type: 'uuid', is_nullable: 'NO', column_default: null },
    href: { data_type: 'text', is_nullable: 'NO', column_default: null },
    user_id: { data_type: 'uuid', is_nullable: 'NO', column_default: null },
    base_local_hash: { data_type: 'text', is_nullable: 'YES', column_default: null },
    remote_etag: { data_type: 'text', is_nullable: 'YES', column_default: null },
    local_vcard: { data_type: 'text', is_nullable: 'YES', column_default: null },
    remote_vcard: { data_type: 'text', is_nullable: 'YES', column_default: null },
    local_tombstone: { data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
    remote_tombstone: { data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
    status: { data_type: 'text', is_nullable: 'NO', column_default: "'unresolved'::text" },
    resolution: { data_type: 'text', is_nullable: 'YES', column_default: null },
    resolved_by: { data_type: 'uuid', is_nullable: 'YES', column_default: null },
    resolved_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
    created_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
      column_default: 'now()',
    },
    updated_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'NO',
      column_default: 'now()',
    },
  });

  expect(await readPrimaryKey(client, 'carddav_conflicts')).toEqual(['id']);
  expect(await readForeignKeys(client, 'carddav_conflicts')).toEqual([
    {
      column_name: 'address_book_id',
      referenced_table: 'carddav_remote_objects',
      referenced_column: 'address_book_id',
      delete_rule: 'CASCADE',
    },
    {
      column_name: 'href',
      referenced_table: 'carddav_remote_objects',
      referenced_column: 'href',
      delete_rule: 'CASCADE',
    },
    {
      column_name: 'resolved_by',
      referenced_table: 'users',
      referenced_column: 'id',
      delete_rule: 'SET NULL',
    },
    {
      column_name: 'user_id',
      referenced_table: 'users',
      referenced_column: 'id',
      delete_rule: 'CASCADE',
    },
  ]);

  const checks = await readChecks(client, [
    'address_books',
    'carddav_remote_objects',
    'carddav_conflicts',
  ]);
  expect(checks).toEqual(expect.arrayContaining([
    {
      table_name: 'address_books',
      check_clause: "((remote_create_capability = ANY (ARRAY['unknown'::text, 'allowed'::text, 'denied'::text])))",
    },
    {
      table_name: 'address_books',
      check_clause: "((remote_update_capability = ANY (ARRAY['unknown'::text, 'allowed'::text, 'denied'::text])))",
    },
    {
      table_name: 'address_books',
      check_clause: "((remote_delete_capability = ANY (ARRAY['unknown'::text, 'allowed'::text, 'denied'::text])))",
    },
    {
      table_name: 'carddav_remote_objects',
      check_clause: "((mapping_status = ANY (ARRAY['pending_materialization'::text, 'synced'::text, 'pending_push'::text, 'conflict'::text])))",
    },
    {
      table_name: 'carddav_remote_objects',
      check_clause: '((mapping_revision >= 0))',
    },
    {
      table_name: 'carddav_remote_objects',
      check_clause: "(((vcard_version IS NULL) OR (vcard_version = ANY (ARRAY['3.0'::text, '4.0'::text]))))",
    },
    {
      table_name: 'carddav_conflicts',
      check_clause: "((status = ANY (ARRAY['unresolved'::text, 'resolved'::text])))",
    },
    {
      table_name: 'carddav_conflicts',
      check_clause: "(((resolution IS NULL) OR (resolution = ANY (ARRAY['keep-mailflow'::text, 'keep-carddav'::text]))))",
    },
    {
      table_name: 'carddav_conflicts',
      check_clause: '((local_tombstone OR (local_vcard IS NOT NULL)))',
    },
    {
      table_name: 'carddav_conflicts',
      check_clause: '((remote_tombstone OR (remote_vcard IS NOT NULL)))',
    },
    {
      table_name: 'carddav_conflicts',
      check_clause: "((((status = 'unresolved'::text) AND (resolution IS NULL) AND (resolved_by IS NULL) AND (resolved_at IS NULL)) OR ((status = 'resolved'::text) AND (resolution IS NOT NULL) AND (resolved_at IS NOT NULL))))",
    },
  ]));

  const indexDefinitions = await readIndexDefinitions(client, [
    'carddav_one_active_mapping_per_contact_idx',
    'carddav_one_unresolved_conflict_per_mapping_idx',
  ]);
  expect(indexDefinitions.carddav_one_active_mapping_per_contact_idx).toBe(
    "UNIQUE (local_contact_id) WHERE ((local_contact_id IS NOT NULL) AND (mapping_status <> 'pending_materialization'::text))",
  );
  expect(indexDefinitions.carddav_one_unresolved_conflict_per_mapping_idx).toBe(
    "UNIQUE (address_book_id, href) WHERE (status = 'unresolved'::text)",
  );
}

async function expectContractedBidirectionalSchema(client) {
  const mappingColumns = await readColumns(client, 'carddav_remote_objects');
  expect(mappingColumns).not.toHaveProperty('disposition');
  expect(mappingColumns).not.toHaveProperty('merge_before');
  expect(mappingColumns).not.toHaveProperty('merge_applied');
  expect(mappingColumns).not.toHaveProperty('legacy_projection');
  expect(mappingColumns).toMatchObject({
    local_contact_id: { data_type: 'uuid', is_nullable: 'YES', column_default: null },
    mapping_status: {
      data_type: 'text',
      is_nullable: 'NO',
      column_default: "'pending_materialization'::text",
    },
    remote_semantic_hash: { data_type: 'text', is_nullable: 'YES', column_default: null },
    local_contact_hash: { data_type: 'text', is_nullable: 'YES', column_default: null },
    pending_operation: { data_type: 'text', is_nullable: 'YES', column_default: null },
    pending_vcard: { data_type: 'text', is_nullable: 'YES', column_default: null },
    pending_local_hash: { data_type: 'text', is_nullable: 'YES', column_default: null },
    pending_remote_semantic_hash: {
      data_type: 'text',
      is_nullable: 'YES',
      column_default: null,
    },
    pending_started_at: {
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    },
  });

  const checks = await readChecks(client, ['carddav_remote_objects']);
  expect(checks).toEqual(expect.arrayContaining([
    {
      table_name: 'carddav_remote_objects',
      check_clause: "(((pending_operation IS NULL) OR (pending_operation = ANY (ARRAY['update'::text, 'delete'::text]))))",
    },
    {
      table_name: 'carddav_remote_objects',
      check_clause: "((((pending_operation IS NULL) AND (pending_vcard IS NULL) AND (pending_local_hash IS NULL) AND (pending_remote_semantic_hash IS NULL) AND (pending_started_at IS NULL)) OR ((pending_operation = 'update'::text) AND (pending_vcard IS NOT NULL) AND (pending_local_hash IS NOT NULL) AND (pending_remote_semantic_hash IS NOT NULL) AND (pending_started_at IS NOT NULL)) OR ((pending_operation = 'delete'::text) AND (pending_vcard IS NULL) AND (pending_local_hash IS NOT NULL) AND (pending_remote_semantic_hash IS NULL) AND (pending_started_at IS NOT NULL))))",
    },
  ]));

  const indexDefinitions = await readIndexDefinitions(client, [
    'carddav_one_active_mapping_per_contact_idx',
    'carddav_one_merge_source_per_contact_idx',
  ]);
  expect(indexDefinitions.carddav_one_active_mapping_per_contact_idx).toBe(
    "UNIQUE (local_contact_id) WHERE ((local_contact_id IS NOT NULL) AND (mapping_status <> 'pending_materialization'::text))",
  );
  expect(indexDefinitions).not.toHaveProperty('carddav_one_merge_source_per_contact_idx');
}

async function expectConflictRetentionSchema(client) {
  expect(await readForeignKeys(client, 'carddav_conflicts')).toEqual([
    {
      column_name: 'address_book_id',
      referenced_table: 'address_books',
      referenced_column: 'id',
      delete_rule: 'CASCADE',
    },
    {
      column_name: 'resolved_by',
      referenced_table: 'users',
      referenced_column: 'id',
      delete_rule: 'SET NULL',
    },
    {
      column_name: 'user_id',
      referenced_table: 'users',
      referenced_column: 'id',
      delete_rule: 'CASCADE',
    },
  ]);
}

it('keeps migration versions unique and orders the CardDAV lifecycle migrations', async () => {
  const filenames = (await readdir(migrationsDirectory))
    .filter(filename => /^\d{4}_.+\.sql$/.test(filename))
    .sort();
  const versions = filenames.map(filename => filename.slice(0, 4));
  const duplicateVersions = versions.filter((version, index) => versions.indexOf(version) !== index);
  const upstreamIndex = filenames.indexOf('0033_gtd_pets_custom.sql');
  const incrementalIndex = filenames.indexOf('0034_carddav_incremental_sync.sql');
  const expandIndex = filenames.indexOf('0035_carddav_bidirectional_sync.sql');
  const contractIndex = filenames.indexOf('0036_carddav_bidirectional_cleanup.sql');
  const retentionIndex = filenames.indexOf('0037_carddav_conflict_retention.sql');

  expect(duplicateVersions).toEqual([]);
  expect(upstreamIndex).toBeGreaterThanOrEqual(0);
  expect(incrementalIndex).toBe(upstreamIndex + 1);
  expect(expandIndex).toBe(incrementalIndex + 1);
  expect(contractIndex).toBe(expandIndex + 1);
  expect(retentionIndex).toBe(contractIndex + 1);
});

describe('CardDAV schema migrations', () => {
  beforeAll(async () => {
    adminClient = new Client({ connectionString: databaseUrl });
    await adminClient.connect();

    for (const name of Object.values(databaseNames)) {
      await createTestDatabase(adminClient, name);
    }
  }, 120_000);

  afterAll(async () => {
    if (!adminClient) return;

    for (const name of Object.values(databaseNames)) {
      await dropTestDatabase(adminClient, name);
    }
    await adminClient.end();
  }, 120_000);

  it('runs the production migration loop idempotently against a fresh database', async () => {
    const migrationPool = new Pool({
      connectionString: connectionStringFor(databaseNames.runner),
    });
    try {
      await runMigrationsWithPool(migrationPool, migrationsDirectory);
      await runMigrationsWithPool(migrationPool, migrationsDirectory);

      const versions = await migrationPool.query(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(versions.rows.map(row => row.version))
        .toContain('0037_carddav_conflict_retention');
      expect(new Set(versions.rows.map(row => row.version)).size)
        .toBe(versions.rows.length);
    } finally {
      await migrationPool.end();
    }
  }, 120_000);

  it('rolls back a failing production migration and releases its advisory lock', async () => {
    const failingDirectory = await mkdtemp(join(tmpdir(), 'mailflow-migrations-'));
    const migrationPool = new Pool({
      connectionString: connectionStringFor(databaseNames.failure),
    });
    const lockClient = new Client({
      connectionString: connectionStringFor(databaseNames.failure),
    });
    await writeFile(
      join(failingDirectory, '9000_failing.sql'),
      'CREATE TABLE rollback_probe (id integer);\nSELECT missing_column FROM rollback_probe;\n',
    );

    try {
      await expect(runMigrationsWithPool(migrationPool, failingDirectory)).rejects.toThrow();

      const versions = await migrationPool.query(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(versions.rows.map(row => row.version)).not.toContain('9000_failing');
      const { rows: [probe] } = await migrationPool.query(
        "SELECT to_regclass('public.rollback_probe') AS relation",
      );
      expect(probe.relation).toBeNull();

      await lockClient.connect();
      const { rows: [lock] } = await lockClient.query(
        'SELECT pg_try_advisory_lock(7418291834) AS acquired',
      );
      expect(lock.acquired).toBe(true);
      await lockClient.query('SELECT pg_advisory_unlock(7418291834)');
    } finally {
      await lockClient.end().catch(() => {});
      await migrationPool.end();
      await rm(failingDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([
    {
      databaseName: databaseNames.populatedDisjoint,
      label: 'disjoint contact UIDs',
      contactUids: ['disjoint-a', 'disjoint-b'],
    },
    {
      databaseName: databaseNames.populatedCollision,
      label: 'colliding contact UIDs',
      contactUids: ['same-uid', 'same-uid'],
    },
  ])('aborts 0034 without changing populated duplicates with $label', async ({
    databaseName,
    contactUids,
  }) => {
    const through0033Directory = await createMigrationDirectory('0001', '0033');
    const migration0034Directory = await createMigrationDirectory('0034', '0034');
    const migrationPool = new Pool({ connectionString: connectionStringFor(databaseName) });
    const userId = randomUUID();
    const earlierBookId = '10000000-0000-4000-8000-000000000001';
    const laterBookId = '10000000-0000-4000-8000-000000000002';

    try {
      await runMigrationsWithPool(migrationPool, through0033Directory);
      await migrationPool.query(
        'INSERT INTO users (id, username) VALUES ($1, $2)',
        [userId, `carddav-populated-${userId}`],
      );
      await migrationPool.query(`
        INSERT INTO address_books (id, user_id, name, source, external_url, created_at)
        VALUES
          ($1, $3, 'Earlier', 'carddav', 'https://dav.example.test/populated',
           '2026-01-01T00:00:00Z'),
          ($2, $3, 'Later', 'carddav', 'https://dav.example.test/populated',
           '2026-01-02T00:00:00Z')
      `, [earlierBookId, laterBookId, userId]);
      await migrationPool.query(`
        INSERT INTO contacts (address_book_id, user_id, uid, display_name)
        VALUES
          ($1, $3, $4, 'Earlier Contact'),
          ($2, $3, $5, 'Later Contact')
      `, [earlierBookId, laterBookId, userId, ...contactUids]);
      const before = await readCardDavRows(migrationPool, userId);

      await expect(runMigrationsWithPool(migrationPool, migration0034Directory))
        .rejects.toThrow('cannot consolidate populated duplicate CardDAV address books');

      expect(await readCardDavRows(migrationPool, userId)).toEqual(before);
      const { rows: [index] } = await migrationPool.query(
        "SELECT to_regclass('public.carddav_one_remote_book_idx') AS relation",
      );
      expect(index.relation).toBeNull();
      const { rows: versions } = await migrationPool.query(
        "SELECT version FROM schema_migrations WHERE version = '0034_carddav_incremental_sync'",
      );
      expect(versions).toEqual([]);
    } finally {
      await migrationPool.end();
      await rm(through0033Directory, { recursive: true, force: true });
      await rm(migration0034Directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('consolidates an empty later duplicate while preserving the populated first book', async () => {
    const through0033Directory = await createMigrationDirectory('0001', '0033');
    const migration0034Directory = await createMigrationDirectory('0034', '0034');
    const migrationPool = new Pool({
      connectionString: connectionStringFor(databaseNames.populatedFirst),
    });
    const userId = randomUUID();
    const keptBookId = '10000000-0000-4000-8000-000000000001';
    const removedBookId = '10000000-0000-4000-8000-000000000002';

    try {
      await runMigrationsWithPool(migrationPool, through0033Directory);
      await migrationPool.query(
        'INSERT INTO users (id, username) VALUES ($1, $2)',
        [userId, `carddav-populated-first-${userId}`],
      );
      await migrationPool.query(`
        INSERT INTO address_books (id, user_id, name, source, external_url, created_at)
        VALUES
          ($1, $3, 'Earlier', 'carddav', 'https://dav.example.test/populated-first',
           '2026-01-01T00:00:00Z'),
          ($2, $3, 'Later', 'carddav', 'https://dav.example.test/populated-first',
           '2026-01-02T00:00:00Z')
      `, [keptBookId, removedBookId, userId]);
      const { rows: [contact] } = await migrationPool.query(`
        INSERT INTO contacts (address_book_id, user_id, uid, display_name)
        VALUES ($1, $2, 'kept-contact', 'Kept Contact')
        RETURNING id
      `, [keptBookId, userId]);

      await runMigrationsWithPool(migrationPool, migration0034Directory);

      expect(await readCardDavRows(migrationPool, userId)).toMatchObject({
        books: [{ id: keptBookId }],
        contacts: [{ id: contact.id, address_book_id: keptBookId }],
      });
    } finally {
      await migrationPool.end();
      await rm(through0033Directory, { recursive: true, force: true });
      await rm(migration0034Directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('collapses empty duplicates by created_at and id and reruns 0034 as a no-op', async () => {
    const through0033Directory = await createMigrationDirectory('0001', '0033');
    const migration0034Directory = await createMigrationDirectory('0034', '0034');
    const migrationPool = new Pool({
      connectionString: connectionStringFor(databaseNames.emptyDuplicates),
    });
    const userId = randomUUID();
    const keptBookId = '10000000-0000-4000-8000-000000000001';

    try {
      await runMigrationsWithPool(migrationPool, through0033Directory);
      await migrationPool.query(
        'INSERT INTO users (id, username) VALUES ($1, $2)',
        [userId, `carddav-empty-${userId}`],
      );
      await migrationPool.query(`
        INSERT INTO address_books (id, user_id, name, source, external_url, created_at)
        VALUES
          ($1, $4, 'Same Time Lower ID', 'carddav', $5, '2026-01-01T00:00:00Z'),
          ($2, $4, 'Same Time Higher ID', 'carddav', $5, '2026-01-01T00:00:00Z'),
          ($3, $4, 'Later', 'carddav', $5, '2026-01-02T00:00:00Z')
      `, [
        keptBookId,
        '10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000003',
        userId,
        'https://dav.example.test/empty',
      ]);

      await runMigrationsWithPool(migrationPool, migration0034Directory);
      const { rows: booksAfterFirstRun } = await migrationPool.query(`
        SELECT id
        FROM address_books
        WHERE user_id = $1 AND source = 'carddav'
        ORDER BY created_at, id
      `, [userId]);
      expect(booksAfterFirstRun).toEqual([{ id: keptBookId }]);
      const { rows: [index] } = await migrationPool.query(
        "SELECT to_regclass('public.carddav_one_remote_book_idx') AS relation",
      );
      expect(index.relation).toBe('carddav_one_remote_book_idx');

      await runMigrationsWithPool(migrationPool, migration0034Directory);
      expect((await migrationPool.query(`
        SELECT id
        FROM address_books
        WHERE user_id = $1 AND source = 'carddav'
        ORDER BY created_at, id
      `, [userId])).rows).toEqual(booksAfterFirstRun);
      const { rows: versions } = await migrationPool.query(
        "SELECT version FROM schema_migrations WHERE version = '0034_carddav_incremental_sync'",
      );
      expect(versions).toEqual([{ version: '0034_carddav_incremental_sync' }]);
    } finally {
      await migrationPool.end();
      await rm(through0033Directory, { recursive: true, force: true });
      await rm(migration0034Directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('upgrades a duplicate schema at migration 0033', async () => {
    await withDatabase(databaseNames.upgrade, async client => {
      await assertMinimumPostgresVersion(client);
      await applyMigrations(client, '0001', '0033');

      const userId = randomUUID();
      const secondMissingUserId = randomUUID();
      const existingStringUserId = randomUUID();
      const existingNullUserId = randomUUID();
      const nonCarddavUserId = randomUUID();
      const earliestBookId = randomUUID();
      const secondBookId = randomUUID();
      const thirdBookId = randomUUID();
      const externalUrl = 'https://carddav.example.test/books/shared';
      await client.query(`
        INSERT INTO users (id, username)
        VALUES
          ($1, $6),
          ($2, $7),
          ($3, $8),
          ($4, $9),
          ($5, $10)
      `, [
        userId,
        secondMissingUserId,
        existingStringUserId,
        existingNullUserId,
        nonCarddavUserId,
        `carddav-upgrade-${userId}`,
        `carddav-upgrade-${secondMissingUserId}`,
        `carddav-upgrade-${existingStringUserId}`,
        `carddav-upgrade-${existingNullUserId}`,
        `carddav-upgrade-${nonCarddavUserId}`,
      ]);
      await client.query(`
        INSERT INTO address_books (id, user_id, name, source, external_url, created_at)
        VALUES
          ($1, $4, 'Earliest', 'carddav', $5, '2026-01-01T00:00:00Z'),
          ($2, $4, 'Second', 'carddav', $5, '2026-01-02T00:00:00Z'),
          ($3, $4, 'Third', 'carddav', $5, '2026-01-03T00:00:00Z')
      `, [earliestBookId, secondBookId, thirdBookId, userId, externalUrl]);
      await client.query(`
        INSERT INTO user_integrations (user_id, provider, config)
        VALUES
          ($1, 'carddav', '{"serverUrl":"https://dav.example.test","nested":{"keep":true}}'::jsonb),
          ($2, 'carddav', '{"username":"second-missing","nested":{"preserve":true}}'::jsonb),
          ($3, 'carddav', '{"connectionGeneration":"legacy-generation","keep":"value"}'::jsonb),
          ($4, 'carddav', '{"connectionGeneration":null,"keep":"value"}'::jsonb),
          ($5, 'caldav-test', '{"keep":"non-carddav"}'::jsonb)
      `, [
        userId,
        secondMissingUserId,
        existingStringUserId,
        existingNullUserId,
        nonCarddavUserId,
      ]);

      await applyMigrations(client, '0034', '0034');

      const { rows: books } = await client.query(`
        SELECT id, remote_sync_token, remote_sync_capability, remote_sync_revision
        FROM address_books
        WHERE user_id = $1 AND external_url = $2
        ORDER BY created_at, id
      `, [userId, externalUrl]);
      expect(books).toEqual([{
        id: earliestBookId,
        remote_sync_token: null,
        remote_sync_capability: 'unknown',
        remote_sync_revision: '0',
      }]);

      const { rows: integrations } = await client.query(`
        SELECT provider, config
        FROM user_integrations
        WHERE user_id = $1
        ORDER BY provider
      `, [userId]);
      const carddavConfig = integrations.find(row => row.provider === 'carddav').config;
      expect(carddavConfig.connectionGeneration).toMatch(UUID_PATTERN);
      expect(carddavConfig).toEqual({
        connectionGeneration: carddavConfig.connectionGeneration,
        nested: { keep: true },
        serverUrl: 'https://dav.example.test',
      });

      const { rows: generationRows } = await client.query(`
        SELECT user_id, provider, config
        FROM user_integrations
        WHERE user_id = ANY($1::uuid[])
        ORDER BY user_id, provider
      `, [[
        secondMissingUserId,
        existingStringUserId,
        existingNullUserId,
        nonCarddavUserId,
      ]]);
      const generationConfigs = new Map(generationRows.map(row => [row.user_id, row.config]));
      const secondMissingConfig = generationConfigs.get(secondMissingUserId);
      expect(secondMissingConfig.connectionGeneration).toMatch(UUID_PATTERN);
      expect(secondMissingConfig.connectionGeneration).not.toBe(carddavConfig.connectionGeneration);
      expect(secondMissingConfig).toEqual({
        connectionGeneration: secondMissingConfig.connectionGeneration,
        nested: { preserve: true },
        username: 'second-missing',
      });
      expect(generationConfigs.get(existingStringUserId)).toEqual({
        connectionGeneration: 'legacy-generation',
        keep: 'value',
      });
      expect(generationConfigs.get(existingNullUserId)).toEqual({
        connectionGeneration: null,
        keep: 'value',
      });
      expect(generationConfigs.get(nonCarddavUserId)).toEqual({ keep: 'non-carddav' });

      const separateContactId = randomUUID();
      const mergeContactId = randomUUID();
      await client.query(`
        INSERT INTO contacts (id, address_book_id, user_id, uid, vcard, display_name)
        VALUES
          ($1, $3, $4, 'legacy-separate', 'BEGIN:VCARD\r\nEND:VCARD\r\n', 'Legacy Separate'),
          ($2, $3, $4, 'legacy-merge', 'BEGIN:VCARD\r\nEND:VCARD\r\n', 'Legacy Merge')
      `, [separateContactId, mergeContactId, earliestBookId, userId]);
      await client.query(`
        INSERT INTO carddav_remote_objects (
          address_book_id, href, remote_etag, vcard, primary_email, disposition,
          local_contact_id, merge_before, merge_applied
        ) VALUES
          ($1, '/legacy-separate.vcf', 'separate-etag', 'BEGIN:VCARD\r\nEND:VCARD\r\n',
           'separate@example.test', 'separate', $2, NULL, NULL),
          ($1, '/legacy-merge.vcf', 'merge-etag', 'BEGIN:VCARD\r\nEND:VCARD\r\n',
           'merge@example.test', 'merge', $3,
           '{"display_name":"Before"}'::jsonb, '{"display_name":"Remote"}'::jsonb),
          ($1, '/legacy-skip.vcf', 'skip-etag', 'BEGIN:VCARD\r\nEND:VCARD\r\n',
           'skip@example.test', 'skip', $2, NULL, NULL)
      `, [earliestBookId, separateContactId, mergeContactId]);

      await applyMigrations(client, '0035', '0035');

      const { rows: legacyMappings } = await client.query(`
        SELECT href, disposition, local_contact_id, merge_before, merge_applied,
               mapping_status, mapping_revision, remote_semantic_hash,
               local_contact_hash, legacy_projection
        FROM carddav_remote_objects
        WHERE address_book_id = $1
        ORDER BY href
      `, [earliestBookId]);
      expect(legacyMappings).toEqual([
        {
          href: '/legacy-merge.vcf',
          disposition: 'merge',
          local_contact_id: mergeContactId,
          merge_before: { display_name: 'Before' },
          merge_applied: { display_name: 'Remote' },
          mapping_status: 'pending_materialization',
          mapping_revision: '0',
          remote_semantic_hash: null,
          local_contact_hash: null,
          legacy_projection: {
            disposition: 'merge',
            merge_before: { display_name: 'Before' },
            merge_applied: { display_name: 'Remote' },
          },
        },
        {
          href: '/legacy-separate.vcf',
          disposition: 'separate',
          local_contact_id: separateContactId,
          merge_before: null,
          merge_applied: null,
          mapping_status: 'pending_materialization',
          mapping_revision: '0',
          remote_semantic_hash: null,
          local_contact_hash: null,
          legacy_projection: {
            disposition: 'separate',
            merge_before: null,
            merge_applied: null,
          },
        },
        {
          href: '/legacy-skip.vcf',
          disposition: 'skip',
          local_contact_id: separateContactId,
          merge_before: null,
          merge_applied: null,
          mapping_status: 'pending_materialization',
          mapping_revision: '0',
          remote_semantic_hash: null,
          local_contact_hash: null,
          legacy_projection: {
            disposition: 'skip',
            merge_before: null,
            merge_applied: null,
          },
        },
      ]);

      await client.query(`
        UPDATE carddav_remote_objects
        SET mapping_status = 'synced'
        WHERE address_book_id = $1 AND href = '/legacy-separate.vcf'
      `, [earliestBookId]);
      await expect(client.query(`
        UPDATE carddav_remote_objects
        SET mapping_status = 'synced'
        WHERE address_book_id = $1 AND href = '/legacy-skip.vcf'
      `, [earliestBookId])).rejects.toMatchObject({ code: '23505' });
      await client.query(`
        UPDATE carddav_remote_objects
        SET mapping_status = 'pending_materialization'
        WHERE address_book_id = $1 AND href = '/legacy-separate.vcf'
      `, [earliestBookId]);

      const { rows: [defaultedMapping] } = await client.query(`
        INSERT INTO carddav_remote_objects (address_book_id, href, vcard)
        VALUES ($1, '/defaulted.vcf', 'BEGIN:VCARD\r\nEND:VCARD\r\n')
        RETURNING disposition, mapping_status, mapping_revision
      `, [earliestBookId]);
      expect(defaultedMapping).toEqual({
        disposition: 'separate',
        mapping_status: 'pending_materialization',
        mapping_revision: '0',
      });

      await expectIncrementalSchema(client);
      await expectBidirectionalSchema(client);

      await applyMigrations(client, '0036', '0036');
      await expectContractedBidirectionalSchema(client);
      await applyMigrations(client, '0037', '0037');
      await expectConflictRetentionSchema(client);
      await expect(client.query(`
        UPDATE carddav_remote_objects
        SET pending_operation = 'delete', pending_started_at = NOW()
        WHERE address_book_id = $1 AND href = '/defaulted.vcf'
      `, [earliestBookId])).rejects.toMatchObject({ code: '23514' });
      const { rows: [deleteIntent] } = await client.query(`
        UPDATE carddav_remote_objects
        SET pending_operation = 'delete', pending_local_hash = 'local-delete-hash',
            pending_started_at = NOW()
        WHERE address_book_id = $1 AND href = '/defaulted.vcf'
        RETURNING pending_operation, pending_vcard, pending_local_hash,
                  pending_remote_semantic_hash, pending_started_at IS NOT NULL AS started
      `, [earliestBookId]);
      expect(deleteIntent).toEqual({
        pending_operation: 'delete',
        pending_vcard: null,
        pending_local_hash: 'local-delete-hash',
        pending_remote_semantic_hash: null,
        started: true,
      });
      const { rows: [contractedIntegration] } = await client.query(`
        SELECT config FROM user_integrations
        WHERE user_id = $1 AND provider = 'carddav'
      `, [userId]);
      expect(contractedIntegration.config).not.toHaveProperty('dupMode');
    });
  }, 120_000);

  it('creates the retained-conflict schema from migrations 0001 through 0037', async () => {
    await withDatabase(databaseNames.fresh, async client => {
      await assertMinimumPostgresVersion(client);
      const freshUserId = randomUUID();
      await applyMigrations(client, '0001', '0033');
      await client.query(
        'INSERT INTO users (id, username) VALUES ($1, $2)',
        [freshUserId, `carddav-fresh-${freshUserId}`],
      );
      await client.query(`
        INSERT INTO user_integrations (user_id, provider, config)
        VALUES ($1, 'carddav', $2::jsonb)
      `, [freshUserId, JSON.stringify({
        serverUrl: 'https://fresh.example.test/dav/',
        username: 'fresh-user',
        dupMode: 'skip',
        intervalMin: 45,
        nested: { preserve: true },
      })]);
      await applyMigrations(client, '0034', '0037');
      const { rows: [freshIntegration] } = await client.query(`
        SELECT config
        FROM user_integrations
        WHERE user_id = $1 AND provider = 'carddav'
      `, [freshUserId]);
      expect(freshIntegration.config.connectionGeneration).toMatch(UUID_PATTERN);
      expect(freshIntegration.config).toEqual({
        connectionGeneration: freshIntegration.config.connectionGeneration,
        intervalMin: 45,
        nested: { preserve: true },
        serverUrl: 'https://fresh.example.test/dav/',
        username: 'fresh-user',
      });
      await expectContractedBidirectionalSchema(client);
      await expectConflictRetentionSchema(client);
    });
  }, 120_000);
});
