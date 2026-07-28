import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from '../services/embeddings/testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const integrationDescribe = DSN ? describe : describe.skip;
const migrationsUrl = new URL('../../migrations/', import.meta.url);

describe('message triage migration sources', () => {
  it('keeps table creation transactional and the feed index in a later concurrent migration', async () => {
    const tableSql = await readFile(new URL('0044_message_triage.sql', migrationsUrl), 'utf8').catch(() => '');
    const feedSql = await readFile(new URL('0046_message_triage_feed_index.sql', migrationsUrl), 'utf8').catch(() => '');

    expect(tableSql).toContain('CREATE TABLE IF NOT EXISTS message_triage');
    expect(tableSql).not.toMatch(/^--\s*no-transaction\b/i);
    expect(tableSql).not.toContain('CREATE INDEX CONCURRENTLY');
    expect(feedSql).toMatch(/^--\s*no-transaction\b/i);
    expect(feedSql).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_messages_triage_feed');
    expect(feedSql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_triage_feed');
  });
});

integrationDescribe('message_triage migration', () => {
  let client;
  const users = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(() => {
    users.length = 0;
  });

  afterEach(async () => {
    for (const userId of users) await cleanupAccount(client, userId);
  });

  async function account(label) {
    const seeded = await seedAccount(client, label);
    users.push(seeded.userId);
    return seeded;
  }

  async function token(userId) {
    const result = await client.query(
      `INSERT INTO api_tokens (user_id, token_hash, name)
       VALUES ($1, $2, 'message-triage-it')
       RETURNING id`,
      [userId, `triage-it-${randomUUID()}`],
    );
    return result.rows[0].id;
  }

  async function triage({ userId, accountId, tokenId = null, header = `<${randomUUID()}@example.com>` }) {
    const result = await client.query(
      `INSERT INTO message_triage
         (user_id, account_id, message_id_header, token_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, accountId, header, tokenId],
    );
    return { id: result.rows[0].id, header };
  }

  it('has the required columns and constraints', async () => {
    const columns = await client.query(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'message_triage'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map(row => row.column_name)).toEqual([
      'id',
      'user_id',
      'account_id',
      'message_id_header',
      'triaged_at',
      'action',
      'note',
      'source',
      'token_id',
    ]);
    expect(columns.rows.find(row => row.column_name === 'message_id_header')?.is_nullable).toBe('NO');
    expect(columns.rows.find(row => row.column_name === 'source')?.column_default).toContain("'mcp'");

    const constraints = await client.query(
      `SELECT c.contype, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       WHERE c.conrelid = 'message_triage'::regclass`,
    );
    const definitions = constraints.rows.map(row => row.definition);
    expect(definitions).toContain('PRIMARY KEY (id)');
    expect(definitions).toContain('UNIQUE (account_id, message_id_header)');
    expect(definitions).toContain('FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
    expect(definitions).toContain('FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE');
    expect(definitions).toContain('FOREIGN KEY (token_id) REFERENCES api_tokens(id) ON DELETE SET NULL');
    expect(definitions.some(definition => definition.includes('message_id_header') && definition.includes('FOREIGN KEY'))).toBe(false);
  });

  it('enforces uniqueness by account and Message-ID header', async () => {
    const { userId, accountId } = await account('triage-unique');
    const first = await triage({ userId, accountId });

    await expect(triage({ userId, accountId, header: first.header })).rejects.toMatchObject({ code: '23505' });
  });

  it('cascades when an email account is deleted', async () => {
    const { userId, accountId } = await account('triage-account-cascade');
    const row = await triage({ userId, accountId });

    await client.query('DELETE FROM email_accounts WHERE id = $1', [accountId]);

    const result = await client.query('SELECT id FROM message_triage WHERE id = $1', [row.id]);
    expect(result.rows).toEqual([]);
  });

  it('cascades when a user is deleted', async () => {
    const { userId, accountId } = await account('triage-user-cascade');
    const row = await triage({ userId, accountId });

    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    users.splice(users.indexOf(userId), 1);

    const result = await client.query('SELECT id FROM message_triage WHERE id = $1', [row.id]);
    expect(result.rows).toEqual([]);
  });

  it('sets token_id to null when the API token is deleted', async () => {
    const { userId, accountId } = await account('triage-token-null');
    const tokenId = await token(userId);
    const row = await triage({ userId, accountId, tokenId });

    await client.query('DELETE FROM api_tokens WHERE id = $1', [tokenId]);

    const result = await client.query('SELECT token_id FROM message_triage WHERE id = $1', [row.id]);
    expect(result.rows[0].token_id).toBeNull();
  });

  it('has the partial inbox feed index', async () => {
    const result = await client.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_messages_triage_feed'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain('(account_id, date, message_id)');
    expect(result.rows[0].indexdef).toContain("folder = 'INBOX'");
    expect(result.rows[0].indexdef).toContain('(is_deleted = false)');
  });
});
