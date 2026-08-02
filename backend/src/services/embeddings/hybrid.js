import { resolveEmbedConfig, generationFingerprint } from './config.js';
import { resolveActiveGeneration, resolveActiveGenerationFromConfig } from './activeGeneration.js';
import { VectorUnavailableError } from './vectorErrors.js';
import { EmbeddingClient } from './client.js';
import { fusedSearch } from './vectorStore.js';

const RRF_K = 60;
const K_PER_SIGNAL = 100;
const SUBJECT_BOOST = 2.0;

export class MissingFreeTextError extends Error {
  constructor() { super('missing_free_text'); this.name = 'MissingFreeTextError'; this.code = 'MISSING_FREE_TEXT'; }
}

const ORCHESTRATOR_DEFAULTS = {
  resolveEmbedConfig,
  generationFingerprint,          // sync (cfg) => string
  resolveActiveGeneration,        // throws VectorUnavailableError
  resolveActiveGenerationFromConfig,
  makeClient: (cfg) => new EmbeddingClient(cfg),
  fusedSearch,
};

// Port of msgvault's internal/vector/hybrid/{engine,rrf}.go orchestration:
// embed the free text once, resolve the active generation by fingerprint,
// dispatch to fusedSearch (mode:'vector' skips the BM25 leg), then rerank in
// JS. Every degradation (disabled/absent embed config, stale/building/no
// generation, a transient embed failure) collapses to VectorUnavailableError
// so searchService has one predicate (isLexicalFallback) to decide whether
// to fall back silently (REST) or raise (MCP strictVector).
export async function hybridSearch(req, overrides = {}) {
  const d = { ...ORCHESTRATOR_DEFAULTS, ...overrides };
  const { mode, accountIds, buildFilters, limit } = req;
  const freeText = (req.freeText || '').trim();
  if (!freeText) throw new MissingFreeTextError();

  // One owner (activeGeneration.js) resolves the embed config, rejects a disabled/absent
  // one as VectorUnavailableError('vector_not_enabled'), and resolves the active generation
  // by fingerprint (throws index_stale | index_building | no_active_generation). Fakes thread
  // through `d`.
  const { cfg, generation } = await d.resolveActiveGenerationFromConfig(d);

  let queryVec;
  try {
    const vecs = await d.makeClient(cfg).embed([freeText]);
    if (!Array.isArray(vecs) || vecs.length !== 1) {
      throw new Error(`embedder returned ${vecs && vecs.length} vectors, want 1`);
    }
    queryVec = vecs[0];
  } catch (err) {
    if (err instanceof VectorUnavailableError) throw err;
    // Embed-step failure (network/timeout/bad upstream response). The config
    // already resolved as ENABLED above, so this is transient unavailability,
    // not "vector search is not configured" — msgvault's engine.go wraps it
    // as ErrEmbeddingTimeout the same way. The reason string is a frozen
    // contract with the MCP error mapper (mcp/vectorErrors.js). REST behavior
    // is unchanged: isLexicalFallback still matches, so the route silently
    // falls back to lexical with fellBack:true.
    throw new VectorUnavailableError('embedding_timeout');
  }

  const subjectTerms = freeText.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  // The subject boost is a lexical-signal nudge — msgvault's vector-only path
  // never applies it, and it "has no meaning without a BM25
  // leg to nudge against". `wantBoost` only decides whether to fetch a WIDENED
  // pool (so the boost can reorder without the SQL LIMIT pre-cutting
  // candidates); whether the boost actually runs is gated below on the BM25
  // leg having contributed a hit.
  const wantBoost = mode === 'hybrid' && SUBJECT_BOOST > 1.0 && subjectTerms.length > 0;
  const sqlLimit = wantBoost ? Math.max(2 * K_PER_SIGNAL, limit) : limit;

  const { hits, poolSaturated, generation: gen } = await d.fusedSearch({
    ftsQuery: mode === 'vector' ? null : freeText,
    queryVec,
    generation,
    accountIds,
    buildFilters,
    rrfK: RRF_K,
    kPerSignal: K_PER_SIGNAL,
    limit: sqlLimit,
  });

  // Gate the boost on the BM25 leg actually contributing (any hit with a
  // non-null bm25_score). When the FTS AND-leg is empty — no message contains
  // ALL query terms, the common case for paraphrase / natural-language queries
  // — the fused ranking IS the pure-ANN ranking, so a subject-substring rerank
  // over the widened pool would only EVICT keyword-free-subject hits that
  // vector correctly surfaced. Real-corpus eval (2026-07-16) measured hybrid
  // losing to pure vector on paraphrase R@5/R@20/MRR for exactly this reason.
  // Gating makes hybrid ranking == vector ranking when there is no lexical
  // signal, while keyword queries (BM25 leg live) keep the nudge that made
  // hybrid win there. Documented divergence from msgvault (boosts uncondition-
  // ally); see specs/search-overhaul/README.md "Semantic excerpt seam".
  const bm25Contributed = hits.some(h => h.bm25_score != null);
  let ranked = wantBoost && bm25Contributed ? applySubjectBoost(hits, subjectTerms, SUBJECT_BOOST) : hits;
  if (ranked.length > limit) ranked = ranked.slice(0, limit);
  return { hits: ranked, poolSaturated, generation: gen };
}

export function isLexicalFallback(err) {
  return err instanceof VectorUnavailableError || err instanceof MissingFreeTextError;
}

// hybrid.js is the module's public face: re-export the vector-unavailability types so
// searchService and the MCP handlers pull them from one place.
// Definition stays in the leaf modules — no vectorStore → hybrid import cycle.
export { VectorUnavailableError } from './vectorErrors.js';
export { resolveActiveGeneration, resolveActiveGenerationFromConfig } from './activeGeneration.js';

// Case-insensitive UUID-ascending tie-break, matching the SQL ORDER BY.
function byScoreThenId(a, b) {
  if (b.rrf_score !== a.rrf_score) return b.rrf_score - a.rrf_score;
  return a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0;
}

// JS subject-boost rerank (port of fused.go:429-469 + rrf.go boost logic).
// Multiplies rrf_score for any hit whose subject contains one of the
// lowercased free-text terms as a case-insensitive substring, then re-sorts.
// No-op when boost <= 1 or subjectTerms is empty.
export function applySubjectBoost(hits, subjectTerms, boost) {
  // Only "boost disabled" skips the whole pass (including the tie-break
  // sort) — a boost-enabled call with no terms still re-sorts deterministically,
  // it just boosts nothing.
  if (!(boost > 1.0)) return hits;
  const terms = (subjectTerms || []).map(t => (t || '').toLowerCase()).filter(Boolean);
  for (const hit of hits) {
    const subj = (hit.subject || '').toLowerCase();
    if (subj && terms.length && terms.some(t => subj.includes(t))) {
      hit.rrf_score *= boost;
      hit.subject_boosted = true;
    }
  }
  hits.sort(byScoreThenId);
  return hits;
}
