import { query } from '../db.js';
import { searchLexical, buildOperatorClauses, hasSearchableToken, buildFolderScopeClauses, negatedFreeTextClause } from './lexicalRepo.js';
import { resolveSearchFolderScope } from './queryParser.js';
import { hybridSearch, isLexicalFallback, MissingFreeTextError } from '../embeddings/hybrid.js';

function clampLimit(limit) {
  return Math.max(1, Math.min(parseInt(limit) || 50, 200));
}

// MCP-facing envelope helpers, applied only when the caller opts in
// (REST never sets `explain`/`scope:'body'`, so its response is unaffected).
function withExplainScores(hits) {
  for (const h of hits) {
    h.score = {
      rrf: h.rrf_score,
      ...(h.bm25_score != null ? { bm25: h.bm25_score } : {}),
      ...(h.vector_score != null ? { vector: h.vector_score } : {}),
      subject_boosted: !!h.subject_boosted,
    };
  }
}
function attachBestChunk(hits) {
  for (const h of hits) {
    h.best_chunk = h.best_char_start == null ? null
      : { chunk_index: h.best_chunk_index, char_start: h.best_char_start, char_end: h.best_char_end, score: h.vector_score };
  }
}

// The vector/hybrid SQL projects the message id as `message_id`
// (vectorStore.fusedSearch DISPLAY_COLS), but every hit consumer — REST
// serialization and MCP hydration alike — keys on `id`. Additively alias `id`
// onto each vector/hybrid hit so the shape is mode-invariant with lexical, leaving
// `message_id` untouched (the REST response is a superset — additive, never
// renamed). searchService.search() is the one seam both modes flow through, so
// this is the single place the alias is applied.
function aliasIdFromMessageId(hits) {
  for (const h of hits) h.id = h.message_id;
}

async function resolveAccountIds(request) {
  const { userId, accountId } = request;
  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  let accountIds = accountsResult.rows.map(r => r.id);
  if (!accountIds.length) return [];
  // Optional single-account narrowing, only within the authenticated user's scope.
  if (accountId && accountIds.includes(accountId)) accountIds = [accountId];
  return accountIds;
}

// Phase 1's original lexical search, extracted verbatim so the mode dispatch
// below can reuse it both as the default path and as the fallback target when
// a semantic search degrades. Returns the pre-Phase-4 shape (no `mode` field —
// the caller adds that uniformly).
async function runLexical(request, resolvedAccountIds) {
  const { parsed, folderParam = '', limit = 50, offset = 0 } = request;

  const cap = clampLimit(limit);
  const off = Math.max(0, parseInt(offset) || 0);
  const emptyPage = { offset: off, limit: cap, hasMore: false };

  const accountIds = resolvedAccountIds || await resolveAccountIds(request);
  if (!accountIds.length) return { messages: [], page: emptyPage };

  const { folderScope, folderFuzzy } = resolveSearchFolderScope(parsed.filters, folderParam);

  // D5: a free-text search (≥1 positive, non-trivial term) ranks by relevance;
  // a filter-only search stays date-ordered.
  const hasPositiveText = parsed.terms.some(t => !t.negate && t.value.length >= 2);
  const ordering = hasPositiveText ? 'relevance' : 'date';

  const { rows, total, hasCondition } = await searchLexical(query, {
    parsed, accountIds, folderScope, folderFuzzy, ordering, limit: cap, offset: off,
  });
  if (!hasCondition) return { messages: [], page: emptyPage };

  return {
    messages: rows,
    ...(total !== undefined ? { total } : {}),
    page: { offset: off, limit: cap, hasMore: rows.length === cap },
  };
}

// The single search entry point shared by REST and MCP. Owns account scoping,
// mode dispatch (lexical/vector/hybrid), the D5 ordering decision (lexical),
// and result shaping. No HTTP framing here.
export async function search(request) {
  const mode = request.mode === 'vector' || request.mode === 'hybrid' ? request.mode : 'lexical';
  if (mode === 'lexical') {
    return { ...(await runLexical(request)), mode: 'lexical' };
  }

  const limit = clampLimit(request.limit);
  const offset = Math.max(0, parseInt(request.offset) || 0);
  // Resolve once, up front, and thread it into a lexical fallback below — a
  // fallback must not re-resolve accounts via a second DB round-trip.
  const accountIds = await resolveAccountIds(request);
  try {
    if (accountIds.length === 0) {
      return { messages: [], mode, pool_saturated: false, generation: null,
               page: { offset, limit, hasMore: false } };
    }
    const { parsed } = request;           // already parsed by the caller — never re-parse
    const { folderScope, folderFuzzy } = resolveSearchFolderScope(parsed.filters, request.folderParam || '');
    // One buildFilters owner threads the SAME predicates the lexical path applies
    // into BOTH fused legs (fusedSearch applies it to the FTS pool and the ANN
    // EXISTS alike, on the joined messages table): structured operators, the
    // folder scope (so semantic search can't leak Sent/Archive/Trash into an
    // Inbox search and an explicit in:sent applies), and negated free-text terms
    // as NOT-conditions (so `invoice -draft` excludes drafts in semantic mode
    // just as FTS exclusion does in lexical mode). Same term hygiene throughout:
    // drop sub-2-char / punctuation-only tokens.
    const buildFilters = (bind) => [
      ...buildOperatorClauses(parsed.filters, bind),
      ...buildFolderScopeClauses(folderScope, folderFuzzy, bind),
      ...parsed.terms
        .filter(t => t.negate && t.value.length >= 2 && hasSearchableToken(t.value))
        .map(t => negatedFreeTextClause(t.value, bind)),
    ];
    // Only non-negated terms drive the embedding + BM25 leg; negated terms are
    // enforced via buildFilters above, never fed to the embedder.
    const freeText = parsed.terms
      .filter(t => !t.negate && t.value.length >= 2 && hasSearchableToken(t.value))
      .map(t => t.value).join(' ');

    // Ranked pools are bounded (D3); fetch one past the page window so a full
    // page can observe whether more hits exist, then slice the page.
    const window = offset + limit;
    const { hits, poolSaturated, generation } = await hybridSearch({
      mode, freeText, accountIds, buildFilters, limit: window + 1,
    });
    const page = hits.slice(offset, offset + limit);
    aliasIdFromMessageId(page);          // mode-invariant `id` alias (seam contract)
    if (request.explain) withExplainScores(page);
    if (request.scope === 'body') attachBestChunk(page);
    return {
      messages: page,
      mode,
      pool_saturated: poolSaturated,
      generation: generation || null,     // rich {id,model,dimension,fingerprint,state} object
      page: { offset, limit, hasMore: hits.length > window },
    };
  } catch (err) {
    if (isLexicalFallback(err)) {
      const lexical = { ...(await runLexical(request, accountIds)), mode: 'lexical' };
      // A filter-only query in semantic mode (MissingFreeTextError) is not a
      // degradation — there is nothing to embed and the lexical result IS the
      // answer, so no fellBack (the UI keys its amber "index building" hint on
      // it). Real unavailability (unconfigured/building/stale/
      // embedding_timeout) keeps the flag.
      return err instanceof MissingFreeTextError ? lexical : { ...lexical, fellBack: true };
    }
    throw err;
  }
}
