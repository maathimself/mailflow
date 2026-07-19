import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { seedAccount, cleanupAccount } from './testSupport.js';

const DSN = process.env.VECTOR_IT_DB;
const d = DSN ? describe : describe.skip;

d('vectorStore ANN', () => {
  let store, client, gen, mA, mB, userId;
  beforeAll(async () => {
    const u = new URL(DSN);
    Object.assign(process.env, { DB_HOST: u.hostname, DB_PORT: u.port, DB_NAME: u.pathname.slice(1), DB_USER: u.username, DB_PASSWORD: u.password });
    store = await import('./vectorStore.js');
    await store.ensureVectorSchema();
    await store.ensureVectorIndex(4);
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    // Re-runnable: clear generation state before seeding. embed_runs FKs
    // index_generations without ON DELETE CASCADE (generations are never hard-deleted
    // in production), so clear it before the parent to keep the reset re-runnable.
    await client.query('DELETE FROM embeddings');
    await client.query('DELETE FROM embed_runs');
    await client.query('DELETE FROM index_generations');
    let acctId;
    ({ accountId: acctId, userId } = await seedAccount(client, 'ann'));
    const a = await client.query(`INSERT INTO messages (account_id, uid, folder, subject) VALUES ($1, 81001, 'INBOX', 'A') RETURNING id`, [acctId]);
    const b = await client.query(`INSERT INTO messages (account_id, uid, folder, subject) VALUES ($1, 81002, 'INBOX', 'B') RETURNING id`, [acctId]);
    mA = a.rows[0].id; mB = b.rows[0].id;
    const now = Math.floor(Date.now() / 1000);
    const gi = await client.query(`INSERT INTO index_generations (model, dimension, fingerprint, started_at, state) VALUES ('m',4,'fp',$1,'building') RETURNING id`, [now]);
    gen = gi.rows[0].id;
  });
  afterAll(async () => { await cleanupAccount(client, userId); await client.end(); });

  it('returns the nearest message first', async () => {
    await store.upsert(gen, [
      { messageId: mA, chunkIndex: 0, vector: [1, 0, 0, 0], sourceCharLen: 4, chunkCharStart: 0, chunkCharEnd: 4, truncated: false },
      { messageId: mB, chunkIndex: 0, vector: [0, 1, 0, 0], sourceCharLen: 4, chunkCharStart: 0, chunkCharEnd: 4, truncated: false },
    ]);
    const hits = await store.annSearch(gen, [1, 0, 0, 0], 2);
    expect(hits[0].messageId).toBe(mA);
    expect(hits[0].rank).toBe(1);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('re-upsert is idempotent (PK replace, no duplicate chunks)', async () => {
    await store.upsert(gen, [{ messageId: mA, chunkIndex: 0, vector: [1, 0, 0, 0], sourceCharLen: 4, chunkCharStart: 0, chunkCharEnd: 4, truncated: false }]);
    const c = await client.query('SELECT COUNT(*)::int n FROM embeddings WHERE generation_id = $1 AND message_id = $2', [gen, mA]);
    expect(c.rows[0].n).toBe(1);
  });

  it('dedups multi-chunk messages by best (MIN) distance', async () => {
    // mB gets a far chunk (0,1,0,0) and a near chunk (1,0,0,0); querying [1,0,0,0]
    // should rank mB by its BEST chunk, ahead of a mid message.
    await store.upsert(gen, [
      { messageId: mB, chunkIndex: 0, vector: [0, 1, 0, 0], sourceCharLen: 4, chunkCharStart: 0, chunkCharEnd: 4, truncated: false },
      { messageId: mB, chunkIndex: 1, vector: [1, 0, 0, 0], sourceCharLen: 4, chunkCharStart: 4, chunkCharEnd: 8, truncated: false },
    ]);
    const hits = await store.annSearch(gen, [1, 0, 0, 0], 5);
    const mbHit = hits.find((h) => h.messageId === mB);
    expect(mbHit.score).toBeGreaterThan(0.9); // best chunk is an exact match
    // one hit per message
    expect(new Set(hits.map((h) => h.messageId)).size).toBe(hits.length);
  });

  it('filter.accountIds scopes ANN to one account (find_similar_messages needs this)', async () => {
    // A second account whose message is an EXACT match for the query — without the
    // filter it would surface; with the account filter it must be excluded, and the
    // widening still returns the in-scope match.
    const other = await seedAccount(client, 'ann-other');
    const oc = await client.query(`INSERT INTO messages (account_id, uid, folder, subject) VALUES ($1, 81003, 'INBOX', 'C') RETURNING id`, [other.accountId]);
    const mC = oc.rows[0].id;
    await store.upsert(gen, [
      { messageId: mA, chunkIndex: 0, vector: [1, 0, 0, 0], sourceCharLen: 4, chunkCharStart: 0, chunkCharEnd: 4, truncated: false },
      { messageId: mC, chunkIndex: 0, vector: [1, 0, 0, 0], sourceCharLen: 4, chunkCharStart: 0, chunkCharEnd: 4, truncated: false },
    ]);
    const firstAcct = (await client.query('SELECT account_id FROM messages WHERE id = $1', [mA])).rows[0].account_id;
    const scoped = await store.annSearch(gen, [1, 0, 0, 0], 5, { filter: { accountIds: [firstAcct] } });
    expect(scoped.some((h) => h.messageId === mC)).toBe(false);
    expect(scoped.some((h) => h.messageId === mA)).toBe(true);
    const unscoped = await store.annSearch(gen, [1, 0, 0, 0], 5);
    expect(unscoped.some((h) => h.messageId === mC)).toBe(true);
    await cleanupAccount(client, other.userId);
  });
});
