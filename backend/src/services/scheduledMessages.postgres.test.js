import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';
import { gunzipSync } from 'zlib';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null, upTo: null }));

// The real migration runner on throwaway databases. `upTo` stops the runner at a migration, so
// one database can be taken to 0070 first and then updated, as an existing installation is.
vi.mock('./db.js', () => ({
  pool: { connect: (...a) => h.pool.connect(...a), query: (...a) => h.pool.query(...a) },
  query: (text, params) => h.pool.query(text, params),
}));
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal();
  const readdir = async (...args) => {
    const files = await real.readdir(...args);
    return h.upTo ? files.filter(f => f.slice(0, 4) <= h.upTo) : files;
  };
  return { ...real, readdir, default: { ...real, readdir } };
});

import { runMigrations } from './migrations.js';
import { restoreBackup, writeBackup } from './backup.js';
import { decryptBytes, encryptBytes } from './encryption.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
const KEY = '3c'.repeat(32);
const TABLES = ['scheduled_messages', 'scheduled_message_attachments'];
const MiB = 1024 * 1024;

// Everything about the two tables that a migration decides: columns, constraints and indexes.
async function schemaOf(pool) {
  const columns = (await pool.query(`
    SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns WHERE table_name = ANY($1) ORDER BY table_name, ordinal_position`, [TABLES])).rows;
  const constraints = (await pool.query(`
    SELECT conrelid::regclass::text AS tbl, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid::regclass::text = ANY($1) ORDER BY 1, 2, 3`, [TABLES])).rows;
  const indexes = (await pool.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1) ORDER BY 1, 2`, [TABLES])).rows;
  return { columns, constraints, indexes };
}

describe.skipIf(!ADMIN_URL)('scheduled messages schema on PostgreSQL (#543)', () => {
  const suffix = randomBytes(4).toString('hex');
  const freshDb = `mailflow_543f_${suffix}`;
  const upgradedDb = `mailflow_543u_${suffix}`;
  let admin;
  const pools = {};
  const use = name => { h.pool = pools[name]; return h.pool; };
  let user, other, account, alias;

  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    for (const name of [freshDb, upgradedDb]) {
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(ADMIN_URL);
      url.pathname = `/${name}`;
      pools[name] = new pg.Pool({ connectionString: url.toString() });
    }
  });

  afterAll(async () => {
    for (const pool of Object.values(pools)) await pool.end();
    for (const name of [freshDb, upgradedDb]) await admin?.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin?.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('applies on a fresh database and on one at 0070, to the same schema, and again as a no-op', async () => {
    use(freshDb);
    h.upTo = null;
    await runMigrations();
    await runMigrations();

    use(upgradedDb);
    h.upTo = '0070';
    await runMigrations();
    expect((await h.pool.query("SELECT to_regclass('scheduled_messages') AS t")).rows[0].t).toBeNull();
    h.upTo = null;
    await runMigrations();

    for (const name of [freshDb, upgradedDb]) {
      const { rows } = await pools[name].query("SELECT version FROM schema_migrations WHERE version LIKE '0071_%'");
      expect(rows).toEqual([{ version: '0071_scheduled_messages' }]);
    }
    const fresh = await schemaOf(pools[freshDb]);
    expect(await schemaOf(pools[upgradedDb])).toEqual(fresh);
    expect(fresh.indexes.map(i => i.indexname)).toEqual(expect.arrayContaining([
      'idx_scheduled_due', 'idx_scheduled_user', 'idx_scheduled_sending', 'idx_scheduled_editing',
      'idx_scheduled_purge', 'idx_scheduled_account', 'idx_scheduled_account_sending',
    ]));
    expect(fresh.columns.map(c => c.column_name)).not.toContain('failure_detail');
    // The claim query's index covers only the rows it can claim.
    expect(fresh.indexes.find(i => i.indexname === 'idx_scheduled_due').indexdef).toMatch(/WHERE \(status = 'scheduled'::text\)/);
    // Foreign keys to the user and the account, none to an alias.
    const fks = fresh.constraints.filter(c => c.contype === 'f').map(c => c.def);
    expect(fks.sort()).toEqual([
      'FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE',
      'FOREIGN KEY (scheduled_id) REFERENCES scheduled_messages(id) ON DELETE CASCADE',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    ]);
  });

  const insertMessage = (over = {}) => {
    const row = {
      user_id: user.id, account_id: account.id, client_key: randomUUID(),
      send_at: '2026-10-25T07:00:00Z', due_at: '2026-10-25T07:00:00Z', ...over,
    };
    const cols = Object.keys(row);
    return h.pool.query(
      `INSERT INTO scheduled_messages (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(row),
    ).then(r => r.rows[0]);
  };
  const insertChunk = (scheduledId, attachmentIndex, chunkIndex, data, meta = null) => h.pool.query(
    'INSERT INTO scheduled_message_attachments (scheduled_id, attachment_index, chunk_index, meta_enc, data_enc) VALUES ($1, $2, $3, $4, $5)',
    [scheduledId, attachmentIndex, chunkIndex, meta, data],
  );

  it('has the designed defaults, and refuses what the design rules out', async () => {
    use(freshDb);
    ({ rows: [user] } = await h.pool.query("INSERT INTO users (username) VALUES ('ann') RETURNING id"));
    ({ rows: [other] } = await h.pool.query("INSERT INTO users (username) VALUES ('ben') RETURNING id"));
    ({ rows: [account] } = await h.pool.query(
      "INSERT INTO email_accounts (user_id, name, email_address, imap_host) VALUES ($1, 'Ann', 'ann@example.com', 'imap.example.com') RETURNING id", [user.id]));
    ({ rows: [alias] } = await h.pool.query(
      "INSERT INTO account_aliases (account_id, name, email) VALUES ($1, 'Sales', 'sales@example.com') RETURNING id", [account.id]));

    const row = await insertMessage({ time_zone: 'Europe/Berlin' });
    expect(row).toMatchObject({ status: 'scheduled', version: 1, attempts: 0, payload_bytes: 0, attachment_bytes: '0', sent_late: false, time_zone: 'Europe/Berlin', claim_token: null, pause_reason: null });

    const refused = [
      { status: 'queued' },
      { pause_reason: 'tired' },
      { status_before: 'gone' },
      { status_before: 'editing' },
      { status_before: 'sending' },
      { version: 0 },
      { attempts: -1 },
      { attachment_bytes: 26214401 },
      { time_zone: 'x'.repeat(65) },
      { payload_enc: Buffer.alloc(10 * MiB + 30) },
      { smtp_accepted_at: '2026-10-25T07:00:02Z' },
    ];
    for (const over of refused) await expect(insertMessage(over)).rejects.toThrow();
    expect(await insertMessage({ payload_enc: Buffer.alloc(10 * MiB + 29), attachment_bytes: 26214400 })).toBeTruthy();
    for (const before of ['scheduled', 'paused', 'failed', 'uncertain']) expect(await insertMessage({ status_before: before })).toBeTruthy();
    for (const reason of ['overdue', 'restored', 'edit_abandoned', 'account_disabled', 'needs_reauth', 'user']) {
      expect(await insertMessage({ status: 'paused', pause_reason: reason })).toBeTruthy();
    }
    expect(await insertMessage({ smtp_started_at: '2026-10-25T07:00:01Z', smtp_accepted_at: '2026-10-25T07:00:02Z' })).toBeTruthy();

    // One send in flight per account.
    await insertMessage({ status: 'sending' });
    await expect(insertMessage({ status: 'sending' })).rejects.toThrow(/idx_scheduled_account_sending/);
    await h.pool.query("DELETE FROM scheduled_messages WHERE status = 'sending'");

    // A retried create with the same client_key is one row per user.
    const key = randomUUID();
    await insertMessage({ client_key: key });
    await expect(insertMessage({ client_key: key })).rejects.toThrow(/duplicate key/);
    expect(await insertMessage({ client_key: key, user_id: other.id })).toBeTruthy();

    await insertChunk(row.id, 0, 0, Buffer.alloc(MiB + 29), Buffer.from('meta'));
    await expect(insertChunk(row.id, 0, 1, Buffer.alloc(MiB + 30))).rejects.toThrow(/check constraint/);
    await expect(insertChunk(row.id, 0, 1, Buffer.alloc(10), Buffer.from('meta'))).rejects.toThrow(/check constraint/);
    await expect(insertChunk(row.id, 0, 0, Buffer.alloc(10))).rejects.toThrow(/duplicate key/);
    await expect(insertChunk(row.id, -1, 0, Buffer.alloc(10))).rejects.toThrow(/check constraint/);
    await expect(insertChunk(randomUUID(), 0, 0, Buffer.alloc(10))).rejects.toThrow(/foreign key/);
  });

  it('keeps a message whose alias is deleted, and deletes it with its account or user', async () => {
    use(freshDb);
    const kept = await insertMessage();
    await h.pool.query('DELETE FROM account_aliases WHERE id = $1', [alias.id]);
    expect((await h.pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [kept.id])).rows).toEqual([{ status: 'scheduled' }]);

    const { rows: [second] } = await h.pool.query(
      "INSERT INTO email_accounts (user_id, name, email_address, imap_host) VALUES ($1, 'Ann 2', 'ann2@example.com', 'imap.example.com') RETURNING id", [user.id]);
    const gone = await insertMessage({ account_id: second.id });
    await insertChunk(gone.id, 0, 0, Buffer.alloc(10));
    await h.pool.query('DELETE FROM email_accounts WHERE id = $1', [second.id]);
    expect((await h.pool.query('SELECT 1 FROM scheduled_messages WHERE id = $1', [gone.id])).rows).toHaveLength(0);
    expect((await h.pool.query('SELECT 1 FROM scheduled_message_attachments WHERE scheduled_id = $1', [gone.id])).rows).toHaveLength(0);

    const { rows: [carl] } = await h.pool.query("INSERT INTO users (username) VALUES ('carl') RETURNING id");
    await insertMessage({ user_id: carl.id });
    await h.pool.query('DELETE FROM users WHERE id = $1', [carl.id]);
    expect((await h.pool.query('SELECT 1 FROM scheduled_messages WHERE user_id = $1', [carl.id])).rows).toHaveLength(0);
  });

  it('backs up a 1 MiB chunk on a line of its own size, and a restore brings it back with pending messages paused', async () => {
    use(freshDb);
    await h.pool.query('DELETE FROM scheduled_messages');
    // One send in flight per account, so each sending row gets an account of its own.
    const accountFor = async name => (await h.pool.query(
      "INSERT INTO email_accounts (user_id, name, email_address, imap_host) VALUES ($1, $2, $3, 'imap.example.com') RETURNING id",
      [user.id, name, `${name}@example.com`])).rows[0].id;
    const byStatus = {};
    const claimed = { claim_token: randomUUID(), claimed_at: '2026-10-25T06:59:00Z' };
    for (const status of ['scheduled', 'editing', 'sending', 'sent', 'failed', 'paused', 'uncertain', 'cancelled']) {
      byStatus[status] = await insertMessage({
        status,
        ...(status === 'sending' ? { ...claimed, account_id: await accountFor('sending') } : {}),
        ...(status === 'editing' ? { edit_token: randomUUID(), edit_lease_until: '2026-10-25T07:05:00Z' } : {}),
        pause_reason: status === 'paused' ? 'overdue' : null,
        updated_at: '2026-10-01T00:00:00Z',
      });
    }
    // Open for editing when the backup was made, after failing, maybe going out, or on time.
    const editingFrom = extra => insertMessage({ status: 'editing', edit_token: randomUUID(), edit_lease_until: '2026-10-25T07:05:00Z', ...extra });
    byStatus.editingUncertain = await editingFrom({ status_before: 'uncertain', failure_code: 'connection_lost', smtp_started_at: '2026-10-25T06:00:00Z' });
    byStatus.editingFailed = await editingFrom({ status_before: 'failed', failure_code: 'smtp_rejected' });
    byStatus.editingScheduled = await editingFrom({ status_before: 'scheduled' });
    // Handed to SMTP with no answer yet, and accepted by SMTP but not yet recorded as sent.
    byStatus.started = await insertMessage({ status: 'sending', ...claimed, account_id: await accountFor('started'), smtp_started_at: '2026-10-25T07:00:01Z' });
    byStatus.accepted = await insertMessage({
      status: 'sending', ...claimed, account_id: await accountFor('accepted'), smtp_started_at: '2026-10-25T07:00:01Z', smtp_accepted_at: '2026-10-25T07:00:02Z',
    });
    const id = byStatus.scheduled.id;
    const plaintext = randomBytes(MiB);
    const aad = `scheduled:${id}:att:0:0:1`;
    const chunk = encryptBytes(plaintext, { purpose: 'scheduled-send', aad });
    await insertChunk(id, 0, 0, chunk);

    const parts = [];
    const out = new Writable({ write(c, _e, done) { parts.push(c); done(); } });
    const client = await h.pool.connect();
    try {
      await writeBackup(client, { scope: 'setup', appVersion: 'test', out });
    } finally {
      client.release();
    }
    const backup = Buffer.concat(parts);
    const lines = gunzipSync(backup).toString('utf8').trim().split('\n');
    const manifest = JSON.parse(lines[0]);
    expect(manifest.tables).toEqual(expect.arrayContaining(TABLES));
    // Parents first: the chunks come after the message they belong to.
    expect(manifest.tables.indexOf('scheduled_message_attachments')).toBeGreaterThan(manifest.tables.indexOf('scheduled_messages'));
    const chunkLine = lines.find(l => l.startsWith('{"table":"scheduled_message_attachments"'));
    // About 2 MiB of hex, a thirtieth of the 64 MiB a row may take.
    expect(chunkLine.length).toBeGreaterThan(2 * MiB);
    expect(chunkLine.length).toBeLessThan(2 * MiB + 4096);

    const restoring = await h.pool.connect();
    try {
      await restoreBackup(restoring, Readable.from([backup]));
    } finally {
      restoring.release();
    }

    const { rows: [restored] } = await h.pool.query(
      'SELECT data_enc FROM scheduled_message_attachments WHERE scheduled_id = $1 AND attachment_index = 0 AND chunk_index = 0', [id]);
    expect(decryptBytes(restored.data_enc, { purpose: 'scheduled-send', aad }).equals(plaintext)).toBe(true);

    const { rows } = await h.pool.query(`
      SELECT id, status, status_before, failure_code, smtp_started_at, pause_reason, claim_token, claimed_at, edit_token, edit_lease_until, smtp_accepted_at,
             updated_at > NOW() - INTERVAL '1 minute' AS touched
        FROM scheduled_messages`);
    const after = Object.fromEntries(rows.map(r => [r.id, r]));
    const released = { claim_token: null, claimed_at: null, edit_token: null, edit_lease_until: null, touched: true };
    for (const status of ['scheduled', 'editing', 'sending']) {
      expect(after[byStatus[status].id]).toMatchObject({ status: 'paused', pause_reason: 'restored', ...released });
    }
    // Never resent: one that may have gone out is the user's to decide, and one SMTP accepted
    // stays sending, unclaimed, for the sender to finish recording.
    expect(after[byStatus.started.id]).toMatchObject({ status: 'uncertain', pause_reason: null, ...released });
    expect(after[byStatus.accepted.id]).toMatchObject({ status: 'sending', pause_reason: null, ...released });
    expect(after[byStatus.accepted.id].smtp_accepted_at).not.toBeNull();
    for (const status of ['sent', 'failed', 'uncertain', 'cancelled']) {
      expect(after[byStatus[status].id]).toMatchObject({ status, pause_reason: null, touched: false });
    }
    expect(after[byStatus.paused.id]).toMatchObject({ status: 'paused', pause_reason: 'overdue', touched: false });
    // An edit hold gives back what it saved: uncertain keeps its question and Mark as sent, failed
    // stays failed; one that was scheduled is paused as the others are. None keeps status_before.
    expect(after[byStatus.editingUncertain.id]).toMatchObject({ status: 'uncertain', status_before: null, failure_code: 'connection_lost', pause_reason: null, ...released });
    expect(after[byStatus.editingUncertain.id].smtp_started_at).not.toBeNull();
    expect(after[byStatus.editingFailed.id]).toMatchObject({ status: 'failed', status_before: null, failure_code: 'smtp_rejected', pause_reason: null, ...released });
    expect(after[byStatus.editingScheduled.id]).toMatchObject({ status: 'paused', status_before: null, pause_reason: 'restored', ...released });
  });
});
