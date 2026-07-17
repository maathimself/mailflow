// Dev probe: bring up the vector schema, insert N random D-dim vectors under a throwaway
// generation, then run an ANN query and print the nearest neighbors with scores.
// Usage: node scripts/vector-probe.js [N=100] [D=8]
// Requires DB_* env pointing at a pgvector-enabled Postgres.
import { randomUUID } from 'crypto';
import { pool } from '../src/services/db.js';
import { ensureVectorSchema, ensureVectorIndex, upsert, annSearch } from '../src/services/embeddings/vectorStore.js';
import { createGeneration } from '../src/services/embeddings/generations.js';
import { seedAccount, cleanupAccount } from '../src/services/embeddings/testSupport.js';

const N = Number(process.argv[2]) || 100;
const D = Number(process.argv[3]) || 8;

function randVec(d) { return Array.from({ length: d }, () => Math.random() * 2 - 1); }

const { vectorAvailable } = await ensureVectorSchema();
if (!vectorAvailable) { console.error('vector unavailable — is this a pgvector image?'); process.exit(1); }
await ensureVectorIndex(D);

const gen = await createGeneration('probe-model', D, `probe:${randomUUID()}`);
// Seed N messages (probe rows) so the ANN liveness EXISTS matches. Uses a throwaway account.
const { accountId: acctId, userId } = await seedAccount(pool, 'probe');
const chunks = [];
for (let i = 0; i < N; i++) {
  const m = await pool.query(`INSERT INTO messages (account_id, uid, folder, subject) VALUES ($1,$2,'INBOX',$3) RETURNING id`,
    [acctId, 900000 + i, `probe ${i}`]);
  chunks.push({ messageId: m.rows[0].id, chunkIndex: 0, vector: randVec(D), sourceCharLen: 8, chunkCharStart: 0, chunkCharEnd: 8, truncated: false });
}
await upsert(gen, chunks);

const q = randVec(D);
console.log(`query = [${q.map((x) => x.toFixed(3)).join(', ')}]`);
const hits = await annSearch(gen, q, 5);
for (const h of hits) console.log(`  rank ${h.rank}  msg ${h.messageId}  score ${h.score.toFixed(4)}`);

await cleanupAccount(pool, userId);
await pool.end();
process.exit(0);
