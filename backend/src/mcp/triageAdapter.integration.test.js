import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from '../services/embeddings/testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const integrationDescribe = DSN ? describe : describe.skip;

integrationDescribe('triageAdapter', () => {
  let client;
  let adapter;
  let db;
  let userId;
  let accountId;
  let nextUid = 700000;

  beforeAll(async () => {
    const url = new URL(DSN);
    process.env.DB_HOST = url.hostname;
    process.env.DB_PORT = url.port;
    process.env.DB_NAME = url.pathname.slice(1);
    process.env.DB_USER = url.username;
    process.env.DB_PASSWORD = url.password;

    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    ({ userId, accountId } = await seedAccount(client, 'triage-adapter'));
    adapter = await import('./triageAdapter.js');
    db = await import('../services/db.js');
  });

  afterAll(async () => {
    await cleanupAccount(client, userId);
    await client.end();
    await db.pool.end();
  });

  async function insertMessage({
    date,
    header = `<${randomUUID()}@example.com>`,
    folder = 'INBOX',
    isRead = false,
    threadId = randomUUID(),
  }) {
    const result = await client.query(
      `INSERT INTO messages
         (account_id, uid, folder, message_id, subject, from_email, date, is_read, thread_id)
       VALUES ($1, $2, $3, $4, $5, 'sender@example.com', $6, $7, $8)
       RETURNING id, message_id`,
      [accountId, nextUid++, folder, header, `message ${nextUid}`, date, isRead, threadId],
    );
    return result.rows[0];
  }

  it('keyset-pages a seeded inbox without duplicates or gaps under a mid-stream insert', async () => {
    const expectedIds = [];
    for (let index = 0; index < 60; index++) {
      const message = await insertMessage({
        date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        header: `<page-${String(index).padStart(2, '0')}@example.com>`,
      });
      expectedIds.push(message.id);
    }

    const seen = [];
    let page = await adapter.listTriageCandidates({
      accountIds: [accountId],
      limit: 20,
      unreadOnly: true,
    });
    seen.push(...page.rows.map(row => row.id));

    const inserted = await insertMessage({
      date: new Date(Date.UTC(2026, 0, 1, 0, 25, 30)).toISOString(),
      header: '<page-inserted@example.com>',
    });
    expectedIds.push(inserted.id);

    while (page.hasMore) {
      page = await adapter.listTriageCandidates({
        accountIds: [accountId],
        cursor: page.cursor,
        limit: 20,
        unreadOnly: true,
      });
      seen.push(...page.rows.map(row => row.id));
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(expectedIds));
  });

  it('marks idempotently and distinguishes INSERT from conflict UPDATE with xmax=0', async () => {
    const message = await insertMessage({ date: '2026-02-01T00:00:00.000Z' });
    const args = {
      userId,
      accountIds: [accountId],
      messageIds: [message.id],
      action: 'archived',
      note: 'integration',
      tokenId: null,
    };

    await expect(adapter.markTriaged(args)).resolves.toMatchObject({
      marked: 1,
      newly_marked: 1,
      already_triaged: 0,
    });
    await expect(adapter.markTriaged(args)).resolves.toMatchObject({
      marked: 1,
      newly_marked: 0,
      already_triaged: 1,
    });
  });

  it('skips null headers and cascades checkpoints when the account is deleted', async () => {
    const noHeader = await insertMessage({
      date: '2026-02-02T00:00:00.000Z',
      header: null,
    });
    const durable = await insertMessage({ date: '2026-02-03T00:00:00.000Z' });

    await expect(adapter.markTriaged({
      userId,
      accountIds: [accountId],
      messageIds: [noHeader.id],
    })).resolves.toMatchObject({
      marked: 0,
      skipped: [{ id: noHeader.id, reason: 'no_message_id_header' }],
    });

    await adapter.markTriaged({
      userId,
      accountIds: [accountId],
      messageIds: [durable.id],
    });
    await client.query('DELETE FROM email_accounts WHERE id = $1', [accountId]);

    const result = await client.query(
      'SELECT id FROM message_triage WHERE account_id = $1',
      [accountId],
    );
    expect(result.rows).toEqual([]);
  });
});
