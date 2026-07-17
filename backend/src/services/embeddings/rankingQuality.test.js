import { describe, it, expect, afterAll } from 'vitest';
import { hasTestDb, withTestDb, closeTestDb } from './__testdb__.js';
import { fusedSearch } from './vectorStore.js';

afterAll(async () => { await closeTestDb(); });

const DIM = 8;
function vec(axis, jitter = 0) { const v = new Array(DIM).fill(0); v[axis] = 1; if (jitter) v[(axis + 1) % DIM] = jitter; return v; }

// 8 concepts. Each has a keyword doc and a synonym-only doc that shares the
// vector neighbourhood but NOT the keyword. Queries ask by keyword; the gold
// hit is the synonym-only doc that lexical alone would miss.
const CONCEPTS = [
  { kw: 'invoice',   syn: 'billing statement',      axis: 0 },
  { kw: 'flight',    syn: 'boarding pass itinerary', axis: 1 },
  { kw: 'invoice2',  syn: 'amount due remittance',   axis: 2 },
  { kw: 'meeting',   syn: 'calendar sync standup',   axis: 3 },
  { kw: 'refund',    syn: 'money back reversal',     axis: 4 },
  { kw: 'password',  syn: 'credential reset link',   axis: 5 },
  { kw: 'shipment',  syn: 'parcel tracking dispatch', axis: 6 },
  { kw: 'contract',  syn: 'signed agreement terms',  axis: 7 },
];
// 20 labeled queries (concepts reused with different jitter for the extra 12).
const QUERIES = [];
for (let i = 0; i < 20; i++) {
  const c = CONCEPTS[i % CONCEPTS.length];
  QUERIES.push({ text: c.kw, qvec: vec(c.axis, (i >= 8 ? 0.15 : 0)), goldAxis: c.axis });
}

describe.skipIf(!hasTestDb())('ranking quality: hybrid must not lose to lexical', () => {
  it('hybrid recall of semantic-only gold hits >= lexical, and never lower', async () => {
    await withTestDb(async (pool) => {
      const u = (await pool.query(`INSERT INTO users (username,password_hash) VALUES ('r','x') RETURNING id`)).rows[0].id;
      const acc = (await pool.query(
        `INSERT INTO email_accounts (user_id,name,email_address,enabled) VALUES ($1,'A','a@x.test',true) RETURNING id`, [u])).rows[0].id;
      const gen = (await pool.query(
        `INSERT INTO index_generations (model,dimension,fingerprint,started_at,state) VALUES ('m',$1,'m:8:test',$2,'active') RETURNING id`,
        [DIM, Math.floor(Date.now() / 1000)])).rows[0].id;

      const goldByAxis = {};
      let uid = 0;
      for (const c of CONCEPTS) {
        // keyword doc (axis vector + keyword in subject)
        await insertDoc(pool, acc, gen, ++uid, `${c.kw} notice`, vec(c.axis), DIM);
        // synonym-only doc: gold semantic hit, NO keyword token
        const goldId = await insertDoc(pool, acc, gen, ++uid, c.syn, vec(c.axis, 0.05), DIM);
        goldByAxis[c.axis] = goldId;
      }

      let hybridWins = 0, lexicalWins = 0;
      for (const q of QUERIES) {
        const goldId = goldByAxis[q.goldAxis];
        const lex = await fusedSearch({ ftsQuery: q.text, queryVec: null, generation: { id: gen, dimension: DIM },
          accountIds: [acc], buildFilters: () => [], rrfK: 60, kPerSignal: 100, limit: 10 }, { client: pool });
        const hyb = await fusedSearch({ ftsQuery: q.text, queryVec: q.qvec, generation: { id: gen, dimension: DIM },
          accountIds: [acc], buildFilters: () => [], rrfK: 60, kPerSignal: 100, limit: 10 }, { client: pool });
        const lexHit = lex.hits.some(h => h.message_id === goldId);
        const hybHit = hyb.hits.some(h => h.message_id === goldId);
        if (hybHit && !lexHit) hybridWins++;
        if (lexHit && !hybHit) lexicalWins++;
        // Never lose: whatever lexical surfaced, hybrid still surfaces.
        for (const h of lex.hits) {
          expect(hyb.hits.some(x => x.message_id === h.message_id)).toBe(true);
        }
      }
      // Semantic-only gold hits: hybrid recovers them, lexical cannot.
      expect(hybridWins).toBeGreaterThanOrEqual(QUERIES.length);
      expect(lexicalWins).toBe(0);
      console.log(`[ranking-quality] hybridWins=${hybridWins} lexicalWins=${lexicalWins} of ${QUERIES.length}`);
    });
  });
});

async function insertDoc(pool, acc, gen, uid, subject, embedding, dim) {
  const id = (await pool.query(
    `INSERT INTO messages (account_id,uid,folder,subject,from_name,from_email,date,snippet,body_text,is_deleted)
     VALUES ($1,$2,'INBOX',$3,'S','s@x.test',now(),$3,$3,false) RETURNING id`, [acc, uid, subject])).rows[0].id;
  await pool.query(
    `INSERT INTO embeddings (generation_id,message_id,chunk_index,embedded_at,source_char_len,embedding,dimension)
     VALUES ($1,$2,0,$3,$4,$5::vector,$6)`,
    [gen, id, Math.floor(Date.now() / 1000), subject.length, `[${embedding.join(',')}]`, dim]);
  return id;
}
