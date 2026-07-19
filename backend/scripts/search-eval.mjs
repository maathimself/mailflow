#!/usr/bin/env node
// search-eval.mjs — IR relevance eval harness for Mailflow's lexical/vector/hybrid search.
//
// WHY THIS EXISTS
// A user reported they "can't tell the difference" between search modes on their real
// 18k-message mailbox and suspected hybrid might be *worse* than pure vector. Phase 4's
// rankingQuality.test.js proved hybrid never LOSES a lexical hit on a synthetic 16-doc
// fixture; this harness is the complementary real-corpus measurement: it builds labeled
// query sets FROM the live mailbox, runs them through the deployed REST API in all three
// modes, and reports the standard IR metrics (Recall@1/5/20, MRR@20) plus cross-mode
// result overlap and hybrid explain-score composition — so the "is hybrid working?"
// question is answered with numbers instead of vibes.
//
// DESIGN
//   * No new deps. Node >=18 global fetch; psql sampling via `docker exec` (the same
//     read-only path the eval brief documents); explain scores via one `docker exec ...
//     node` pass against the in-container searchService seam (the deployed REST route does
//     not plumb `explain` through, but the seam it calls does).
//   * Deterministic. Message sampling is ordered by md5(id || seed); paraphrase queries
//     are cached to JSON keyed by {messageId, promptVersion}, so reruns are free & stable.
//   * Two query sets, both with a single ground-truth message id:
//       KEYWORD    — 2 distinctive subject tokens (lexical should win/tie).
//       PARAPHRASE — an LLM rewrites the email's topic WITHOUT its distinctive keywords
//                    (semantic recall test; degrades to hand-written queries if the LLM
//                     is unavailable).
//
// USAGE
//   EVAL_USER='admin@example.com' \               # login username (no default)
//   EVAL_PASS='<login-password>' \
//   OPENAI_API_KEY="$(cat /path/to/key)" \        # or EVAL_KEY_FILE=/path/to/key
//   node backend/scripts/search-eval.mjs
//
//   Reruns after the first are offline for query generation (cache hit) but still hit the
//   live REST API for the actual searches. Set EVAL_SKIP_EXPLAIN=1 to skip the in-container
//   diagnostic. All knobs are env vars (see CFG below). No secrets are written to disk.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(__dirname, '..', '..', 'specs', 'search-overhaul', 'evals');

const PROMPT_VERSION = 'v1'; // bump to invalidate the paraphrase cache

function readKeyFile() {
  const f = process.env.EVAL_KEY_FILE;
  if (f && existsSync(f)) return readFileSync(f, 'utf8');
  return '';
}

const CFG = {
  baseUrl: process.env.EVAL_BASE_URL || 'http://127.0.0.1:8087',
  loginUser: process.env.EVAL_USER || '', // required for a fresh login; never defaulted
  loginPass: process.env.EVAL_PASS || '', // required for a fresh login; never defaulted
  pgContainer: process.env.EVAL_PG_CONTAINER || 'mailflow-postgres',
  pgUser: process.env.EVAL_PG_USER || 'mailflow',
  pgDb: process.env.EVAL_PG_DB || 'mailflow',
  backendContainer: process.env.EVAL_BACKEND_CONTAINER || 'mailflow-backend',
  openaiBase: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openaiKey: (process.env.OPENAI_API_KEY || readKeyFile()).trim(),
  seed: process.env.EVAL_SEED || 'mailflow-eval-2026-07-16',
  nKeyword: Number(process.env.EVAL_N_KEYWORD || 15),
  nParaphrase: Number(process.env.EVAL_N_PARAPHRASE || 25),
  limit: 20,
  spacingMs: Number(process.env.EVAL_REQUEST_SPACING_MS || 3300), // stay just under 20/min
  llmSpacingMs: Number(process.env.EVAL_LLM_SPACING_MS || 3000),  // pace flaky low-tier keys
  generateOnly: process.env.EVAL_GENERATE_ONLY === '1',           // populate the cache, then exit
  skipExplain: process.env.EVAL_SKIP_EXPLAIN === '1',
  cacheFile: resolve(EVAL_DIR, 'query-cache.json'),
  outFile: process.env.EVAL_OUT || resolve(EVAL_DIR, `results-${new Date().toISOString().slice(0, 10)}.json`),
};

const MODES = ['lexical', 'vector', 'hybrid'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── DB sampling (docker exec psql, read-only) ──────────────────────────────────────────
const FSEP = '\x1f';
function psql(sql) {
  const out = execFileSync(
    'docker',
    ['exec', CFG.pgContainer, 'psql', '-U', CFG.pgUser, '-d', CFG.pgDb, '-tAF', FSEP, '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter((l) => l.length > 0).map((l) => l.split(FSEP));
}

function resolveScope() {
  const rows = psql(
    `SELECT u.id, (SELECT string_agg(id::text, ',') FROM email_accounts WHERE user_id=u.id AND enabled=true)
       FROM users u WHERE u.username='${CFG.loginUser.replace(/'/g, "''")}'`,
  );
  if (!rows.length) throw new Error(`no user ${CFG.loginUser}`);
  const [userId, accts] = rows[0];
  return { userId, accountIds: (accts || '').split(',').filter(Boolean) };
}

// Sanitize subject/snippet in SQL so newlines/separators never break TSV row parsing.
const CLEAN = (col) => `regexp_replace(coalesce(${col},''), '\\s+', ' ', 'g')`;

function sampleMessages({ salt, where, n }) {
  const acctList = SCOPE.accountIds.map((a) => `'${a}'`).join(',');
  return psql(
    `SELECT id, ${CLEAN('subject')}, ${CLEAN('snippet')}, coalesce(from_name,'')
       FROM messages m
      WHERE m.is_deleted=false AND m.account_id IN (${acctList}) AND ${where}
      ORDER BY md5(m.id::text || '${salt.replace(/'/g, "''")}')
      LIMIT ${n}`,
  ).map(([id, subject, snippet, fromName]) => ({ id, subject, snippet, fromName }));
}

// ── KEYWORD query derivation ───────────────────────────────────────────────────────────
const STOP = new Set([
  'the', 'and', 'for', 'you', 'your', 'with', 'from', 'this', 'that', 'have', 'has', 'was',
  'are', 'will', 'not', 'new', 'can', 'all', 'our', 'out', 'get', 'now', 'about', 'been',
  'account', 'email', 'please', 'update', 'updated', 'notification', 're', 'fwd', 'fw',
  'order', 'invoice', 'payment', 'confirm', 'confirmation', 'reminder', 'receipt', 'alert',
  'security', 'verify', 'verification', 'here', 'more', 'just', 'been', 'they', 'them',
  'default', 'routing', 'transaction', 'needs', 'sent', 'may', 'copy', 'left', 'comment',
]);
function keywordTokens(subject) {
  const toks = (subject.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || [])
    .map((t) => t.replace(/^[-']+|[-']+$/g, ''))
    .filter((t) => t.length >= 4 && !STOP.has(t));
  const uniq = [...new Set(toks)].sort((a, b) => b.length - a.length);
  return uniq.slice(0, 2);
}

function buildKeywordSet() {
  const cands = sampleMessages({
    salt: `${CFG.seed}:kw`,
    where: `length(coalesce(m.subject,'')) BETWEEN 10 AND 160`,
    n: CFG.nKeyword * 4,
  });
  const set = [];
  for (const m of cands) {
    if (set.length >= CFG.nKeyword) break;
    const toks = keywordTokens(m.subject);
    if (toks.length < 2) continue;
    set.push({ id: m.id, set: 'keyword', query: toks.join(' '), subject: m.subject });
  }
  return set;
}

// ── PARAPHRASE query generation (LLM, cached) ──────────────────────────────────────────
async function openaiParaphrase(subject, snippet) {
  const body = {
    model: CFG.openaiModel,
    temperature: 0.3,
    max_tokens: 40,
    messages: [
      { role: 'system', content: 'You write realistic email-search queries the way a busy person would type them months later from memory.' },
      { role: 'user', content:
        `Email subject: ${subject}\nEmail preview: ${snippet}\n\n` +
        'Write ONE short natural-language search query (4-9 words) that a person might type to re-find THIS email later. ' +
        'Describe its topic or purpose in everyday words. Do NOT reuse the distinctive names, brands, product names, codes, or rare keywords from the subject — paraphrase them with common synonyms. ' +
        'Output only the query text, no quotes, no punctuation at the end.' },
    ],
  };
  // Low-tier keys rate-limit bursts (429), sometimes even reporting it as a quota error;
  // back off (3s,6s,12s,24s) and retry before giving up to the hand-written fallback.
  const backoff = [3000, 6000, 12000, 24000];
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    const res = await fetch(`${CFG.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CFG.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < backoff.length) { await sleep(backoff[attempt]); continue; }
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
    return (j.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('openai 429: retries exhausted');
}

// Hand-written fallbacks, only used if the LLM is unavailable AND nothing is cached.
function fallbackParaphrase(subject) {
  const t = keywordTokens(subject);
  return t.length ? `email about ${t.join(' and ')}` : 'that email i got recently';
}

async function buildParaphraseSet(cache) {
  const cands = sampleMessages({
    salt: `${CFG.seed}:para`,
    where: `length(coalesce(m.subject,'')) BETWEEN 12 AND 160 AND m.snippet IS NOT NULL AND length(m.snippet) >= 40`,
    n: CFG.nParaphrase,
  });
  const set = [];
  let generated = 0; let usedFallback = 0;
  for (const m of cands) {
    const key = `${m.id}:${PROMPT_VERSION}`;
    let query = cache[key]?.query;
    if (!query) {
      if (CFG.openaiKey) {
        try {
          query = await openaiParaphrase(m.subject, m.snippet);
          generated++;
          await sleep(CFG.llmSpacingMs); // pace LLM calls to avoid burst rate-limits on low-tier keys
        } catch (err) {
          console.warn(`  paraphrase LLM failed for ${m.id.slice(0, 8)}: ${err.message}`);
        }
      }
      if (!query) { query = fallbackParaphrase(m.subject); usedFallback++; }
      cache[key] = { query, subject: m.subject, source: generated && query !== fallbackParaphrase(m.subject) ? 'llm' : 'fallback' };
    }
    set.push({ id: m.id, set: 'paraphrase', query, subject: m.subject });
  }
  // Tally the provenance of every query actually used (cache may hold llm/handwritten/fallback).
  const sourceCounts = {};
  for (const m of cands) {
    const s = cache[`${m.id}:${PROMPT_VERSION}`]?.source || 'unknown';
    sourceCounts[s] = (sourceCounts[s] || 0) + 1;
  }
  if (generated || usedFallback) console.log(`  paraphrases: ${generated} generated, ${usedFallback} fallback, ${set.length - generated - usedFallback} cached`);
  console.log(`  paraphrase sources: ${JSON.stringify(sourceCounts)}`);
  return { set, usedFallback, sourceCounts };
}

// ── Live REST search (session + 429-aware throttling) ──────────────────────────────────
let COOKIE = '';
async function login() {
  if (!CFG.loginUser) throw new Error('EVAL_USER is required for a fresh login (no default; local test creds)');
  if (!CFG.loginPass) throw new Error('EVAL_PASS is required for a fresh login (no default; local test creds)');
  const res = await fetch(`${CFG.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ username: CFG.loginUser, password: CFG.loginPass }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const set = res.headers.getSetCookie?.() || [];
  COOKIE = set.map((c) => c.split(';')[0]).join('; ');
  if (!COOKIE) throw new Error('login returned no session cookie');
}

async function restSearch(query, mode) {
  const url = `${CFG.baseUrl}/api/search/?q=${encodeURIComponent(query)}&mode=${mode}&limit=${CFG.limit}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { Cookie: COOKIE, 'X-Requested-With': 'XMLHttpRequest' } });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') || 5);
      console.log(`    429 rate-limited, sleeping ${retry + 1}s`);
      await sleep((retry + 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`search ${res.status} for "${query}" (${mode})`);
    return res.json();
  }
  throw new Error(`search gave up after retries: "${query}" (${mode})`);
}

// ── Metrics ────────────────────────────────────────────────────────────────────────────
function rankOf(ids, targetId) {
  const i = ids.indexOf(targetId);
  return i < 0 ? null : i + 1; // 1-indexed
}
function jaccard(a, b) {
  const sa = new Set(a); const sb = new Set(b);
  if (!sa.size && !sb.size) return 1;
  let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
function summarize(ranks) {
  const n = ranks.length;
  const rec = (k) => ranks.filter((r) => r != null && r <= k).length / n;
  const mrr = ranks.reduce((s, r) => s + (r != null && r <= 20 ? 1 / r : 0), 0) / n;
  const found = ranks.filter((r) => r != null).length;
  return { n, recall_at_1: rec(1), recall_at_5: rec(5), recall_at_20: rec(20), mrr_at_20: mrr, found };
}

// ── In-container explain diagnostic (single node pass) ─────────────────────────────────
function explainDiagnostic(queries) {
  const payload = JSON.stringify(queries.map((q) => ({ id: q.id, q: q.query, set: q.set })));
  const script = `
import { search } from './src/services/search/searchService.js';
import { parseQuery } from './src/services/search/queryParser.js';
const userId = process.env.EVAL_USER_ID;
const queries = JSON.parse(process.env.EVAL_Q);
const out = [];
for (const item of queries) {
  const parsed = parseQuery(item.q);
  const row = { id: item.id, q: item.q, set: item.set };
  for (const mode of ['hybrid', 'vector']) {
    try {
      const r = await search({ userId, parsed, mode, limit: 20, explain: true });
      const hits = r.messages || [];
      const ids = hits.map((h) => h.id);
      const gi = ids.indexOf(item.id);
      row[mode] = {
        fellBack: !!r.fellBack, mode: r.mode, pool_saturated: !!r.pool_saturated, n: hits.length,
        n_bm25: hits.filter((h) => h.score && h.score.bm25 != null).length,
        n_vector: hits.filter((h) => h.score && h.score.vector != null).length,
        n_both: hits.filter((h) => h.score && h.score.bm25 != null && h.score.vector != null).length,
        n_subject_boosted: hits.filter((h) => h.score && h.score.subject_boosted).length,
        gt_rank: gi < 0 ? null : gi + 1,
        gt_score: gi < 0 ? null : hits[gi].score,
      };
    } catch (e) { row[mode] = { error: String(e.message || e) }; }
  }
  out.push(row);
}
process.stdout.write(JSON.stringify(out));
`;
  const raw = execFileSync(
    'docker',
    ['exec', '-e', `EVAL_Q=${payload}`, '-e', `EVAL_USER_ID=${SCOPE.userId}`,
      CFG.backendContainer, 'node', '--input-type=module', '-e', script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

// ── Main ───────────────────────────────────────────────────────────────────────────────
let SCOPE;
async function main() {
  if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
  SCOPE = resolveScope();
  console.log(`user=${SCOPE.userId.slice(0, 8)} accounts=${SCOPE.accountIds.length}`);

  const cache = existsSync(CFG.cacheFile) ? JSON.parse(readFileSync(CFG.cacheFile, 'utf8')) : {};

  console.log('building keyword set...');
  const keywordSet = buildKeywordSet();
  console.log(`building paraphrase set (LLM=${CFG.openaiKey ? 'on' : 'off'})...`);
  const { set: paraphraseSet, usedFallback, sourceCounts } = await buildParaphraseSet(cache);
  // cacheFile holds paraphrases of real mail — gitignored, regenerated on demand; never committed.
  writeFileSync(CFG.cacheFile, JSON.stringify(cache, null, 2));
  if (CFG.generateOnly) {
    console.log(`generate-only: cache written (${paraphraseSet.length} paraphrases, ${usedFallback} still fallback). Exiting.`);
    return;
  }

  const queries = [...keywordSet, ...paraphraseSet];
  console.log(`total queries: ${queries.length} (${keywordSet.length} keyword, ${paraphraseSet.length} paraphrase)`);

  console.log('logging in...');
  await login();

  // Run every query in every mode against the live REST API.
  const perQuery = [];
  let done = 0;
  for (const q of queries) {
    const rec = { id: q.id, set: q.set, query: q.query, subject: q.subject, byMode: {} };
    for (const mode of MODES) {
      const r = await restSearch(q.query, mode);
      const ids = (r.messages || []).map((m) => m.id);
      rec.byMode[mode] = { ids, rank: rankOf(ids, q.id), fellBack: !!r.fellBack, total: r.total };
      await sleep(CFG.spacingMs);
    }
    perQuery.push(rec);
    done++;
    if (done % 5 === 0) console.log(`  ${done}/${queries.length} queries searched`);
  }

  // Explain diagnostics (in-container seam).
  let explain = [];
  if (!CFG.skipExplain) {
    console.log('collecting hybrid/vector explain scores (in-container)...');
    try { explain = explainDiagnostic(queries); }
    catch (e) { console.warn(`  explain diagnostic failed: ${e.message}`); }
  }
  const explainById = Object.fromEntries(explain.map((e) => [`${e.set}:${e.id}`, e]));

  // Aggregate metrics.
  const sets = ['keyword', 'paraphrase', 'overall'];
  const metrics = {};
  for (const s of sets) {
    metrics[s] = {};
    const rows = perQuery.filter((r) => s === 'overall' || r.set === s);
    for (const mode of MODES) metrics[s][mode] = summarize(rows.map((r) => r.byMode[mode].rank));
  }

  // Cross-mode overlap (how identical are the result sets?).
  const overlap = {};
  for (const s of ['keyword', 'paraphrase', 'overall']) {
    const rows = perQuery.filter((r) => s === 'overall' || r.set === s);
    const pairMean = (a, b) => rows.reduce((acc, r) => acc + jaccard(r.byMode[a].ids, r.byMode[b].ids), 0) / rows.length;
    const identicalTop20 = (a, b) => rows.filter((r) => jaccard(r.byMode[a].ids, r.byMode[b].ids) === 1).length / rows.length;
    overlap[s] = {
      jaccard_hybrid_vector: pairMean('hybrid', 'vector'),
      jaccard_hybrid_lexical: pairMean('hybrid', 'lexical'),
      jaccard_vector_lexical: pairMean('vector', 'lexical'),
      identical_top20_hybrid_vector: identicalTop20('hybrid', 'vector'),
      identical_top20_hybrid_lexical: identicalTop20('hybrid', 'lexical'),
    };
  }

  // Explain composition rollup (per set): how often did the BM25 leg actually contribute?
  const explainRollup = {};
  for (const s of ['keyword', 'paraphrase']) {
    const rows = explain.filter((e) => e.set === s && e.hybrid && !e.hybrid.error);
    if (!rows.length) continue;
    const avg = (f) => rows.reduce((a, e) => a + f(e), 0) / rows.length;
    explainRollup[s] = {
      n: rows.length,
      queries_with_any_bm25_hit: rows.filter((e) => e.hybrid.n_bm25 > 0).length,
      avg_hybrid_bm25_hits: avg((e) => e.hybrid.n_bm25),
      avg_hybrid_vector_hits: avg((e) => e.hybrid.n_vector),
      avg_hybrid_subject_boosted: avg((e) => e.hybrid.n_subject_boosted),
      queries_pool_saturated: rows.filter((e) => e.hybrid.pool_saturated).length,
    };
  }

  // ── Print human-readable tables ──
  const pct = (x) => (x * 100).toFixed(1).padStart(5);
  const num = (x) => x.toFixed(3);
  console.log('\n================ RESULTS ================');
  for (const s of sets) {
    console.log(`\n[${s.toUpperCase()}]  (n=${metrics[s].lexical.n})`);
    console.log('  mode     R@1    R@5   R@20   MRR@20  found');
    for (const mode of MODES) {
      const m = metrics[s][mode];
      console.log(`  ${mode.padEnd(7)} ${pct(m.recall_at_1)}% ${pct(m.recall_at_5)}% ${pct(m.recall_at_20)}%  ${num(m.mrr_at_20)}   ${m.found}/${m.n}`);
    }
  }
  console.log('\n[OVERLAP] mean Jaccard@20 of result sets');
  for (const s of ['keyword', 'paraphrase']) {
    const o = overlap[s];
    console.log(`  ${s.padEnd(11)} hybrid~vector=${num(o.jaccard_hybrid_vector)}  hybrid~lexical=${num(o.jaccard_hybrid_lexical)}  vector~lexical=${num(o.jaccard_vector_lexical)}  (identical hybrid==vector top20: ${pct(o.identical_top20_hybrid_vector)}%)`);
  }
  console.log('\n[EXPLAIN] hybrid BM25-leg contribution');
  for (const s of ['keyword', 'paraphrase']) {
    const e = explainRollup[s]; if (!e) continue;
    console.log(`  ${s.padEnd(11)} queries with >=1 BM25 hit: ${e.queries_with_any_bm25_hit}/${e.n}  avg BM25 hits=${num(e.avg_hybrid_bm25_hits)}  avg vector hits=${num(e.avg_hybrid_vector_hits)}  avg subject-boosted=${num(e.avg_hybrid_subject_boosted)}`);
  }

  // ── Write results JSON (NO secrets) ──
  const results = {
    generated_at: new Date().toISOString(),
    config: {
      baseUrl: CFG.baseUrl, seed: CFG.seed, limit: CFG.limit,
      openaiModel: CFG.openaiKey ? CFG.openaiModel : null,
      n_keyword: keywordSet.length, n_paraphrase: paraphraseSet.length,
      paraphrase_fallback_used: usedFallback,
      paraphrase_sources: sourceCounts,
    },
    corpus: { messages: Number(psql('SELECT count(*) FROM messages')[0][0]), note: 'bodies mostly NULL; embeddings ~subject-only' },
    metrics, overlap, explainRollup,
    perQuery: perQuery.map((r) => ({
      id: r.id, set: r.set, query: r.query, subject: r.subject,
      rank: { lexical: r.byMode.lexical.rank, vector: r.byMode.vector.rank, hybrid: r.byMode.hybrid.rank },
      fellBack: { vector: r.byMode.vector.fellBack, hybrid: r.byMode.hybrid.fellBack },
      explain: explainById[`${r.set}:${r.id}`] || null,
    })),
  };
  writeFileSync(CFG.outFile, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${CFG.outFile}`);
  console.log(`wrote ${CFG.cacheFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
