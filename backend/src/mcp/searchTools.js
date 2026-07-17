import { parseQuery } from '../services/search/queryParser.js';
import { search } from '../services/search/searchService.js';
import { jsonResult, errorResult } from './result.js';
import { newPaginatedResponse, newPaginatedResponseNoTotal, wireSummary } from './envelope.js';
import { extractContextChar } from './bodyMatch.js';
import { translateVectorError } from './vectorErrors.js';
import { matchFromChunk } from '../services/embeddings/chunkmatch.js';
import { getMessageSummariesByIDs, resolveAccountScope } from './engineAdapter.js';

// The search seam returns raw REST-shaped rows (subject/from/date/snippet/… under a
// column set REST froze); MCP must emit msgvault MessageSummary. We hydrate the hit
// ids through engineAdapter (recipients, thread_id, attachments — data the ranked row
// set doesn't carry) so every search tool speaks the same wire shape as the message
// tools. Order is preserved by getMessageSummariesByIDs; ids are already in scope.
// wireSummary re-formats sent_at to Go RFC3339 (no millis) at the wire.
async function hydrateSummaries(messages, accountIds) {
  const ids = (messages || []).map((m) => m.id);
  const summaries = await getMessageSummariesByIDs(ids, accountIds);
  return new Map(summaries.map((s) => [s.id, wireSummary(s)]));
}

// msgvault front doors reject queries whose known operators carry unparseable
// values (q.Err(), internal/search/parser.go:45-52; returned verbatim at
// handlers.go:373-375) instead of silently dropping the filter and returning
// wider-than-requested results. parsed.errors carries the verbatim messages;
// errors.Join separates with newlines.
export function queryParseErrorMessage(parsed) {
  const errs = (parsed && parsed.errors) || [];
  return errs.length ? errs.join('\n') : '';
}

// Port of unsupportedSearchOperatorMessage (msgvault handlers.go:408-428) with
// per-operator reasons. msgvault's parser-level unsupported set is only
// list:/list-id: (Gmail-only, parser.go:270-273); Mailflow additionally cannot
// serve label:/l:, bcc:, larger:, smaller: — msgvault supports those four, but
// Mailflow's messages schema stores no labels, BCC recipients, or byte sizes
// (documented divergence). The taxonomy prefix is verbatim.
const UNSUPPORTED_OPERATOR_REASONS = {
  list: 'is Gmail-only syntax (this server does not index List-ID); use supported operators instead',
  'list-id': 'is Gmail-only syntax (this server does not index List-ID); use supported operators instead',
  label: 'is not supported on this server (Mailflow stores no Gmail labels)',
  bcc: 'is not supported on this server (Mailflow does not store BCC recipients)',
  larger: 'is not supported on this server (Mailflow does not store message sizes)',
  smaller: 'is not supported on this server (Mailflow does not store message sizes)',
};

// list:/list-id: live in msgvault's parser-level unsupported set; Mailflow's
// queryParser (Wave D's file) currently leaves them as literal free-text
// terms, so recognize them here at the handler seam.
// TODO(seam): consolidate into queryParser's unsupported set with Wave D.
function unsupportedListOperators(parsed) {
  const out = [];
  for (const t of (parsed && parsed.terms) || []) {
    const m = /^(list|list-id):/i.exec(t.value || '');
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

export function unsupportedSearchOperatorMessage(parsed) {
  const names = [];
  const seen = new Set();
  const push = (name) => { if (name && !seen.has(name)) { seen.add(name); names.push(name); } };
  for (const u of (parsed && parsed.unsupported) || []) push(u.key);
  for (const n of unsupportedListOperators(parsed)) push(n);
  if (!names.length) return '';
  // Group operators sharing a reason, msgvault-style ("name:, name2: <reason>"),
  // preserving first-appearance order.
  const groups = [];
  const byReason = new Map();
  for (const n of names) {
    const reason = UNSUPPORTED_OPERATOR_REASONS[n] || 'is not supported on this server';
    let g = byReason.get(reason);
    if (!g) { g = { reason, ops: [] }; byReason.set(reason, g); groups.push(g); }
    g.ops.push(`${n}:`);
  }
  return 'unsupported_search_operator: ' +
    groups.map((g) => `${g.ops.join(', ')} ${g.reason}`).join('; ');
}

// msgvault clamps hybrid paging to [vector.search].max_page_size_hybrid
// (default 50; vector/config.go:196-205,339-342, enforced at handlers.go:651-668).
// Mailflow has no config knob; its effective ranking window is the fused
// per-signal candidate cap (hybrid.js K_PER_SIGNAL = 100) — offsets past it
// can only return silently-empty pages, so reject them the msgvault way.
// TODO(seam): read this from hybrid.js if Wave D exports the per-signal cap.
export const HYBRID_RANKING_WINDOW = 100;

// Tool descriptions/schemas follow msgvault internal/mcp/server.go, with the
// Mailflow divergences spelled out in the text: no label:/bcc:/larger:/smaller:
// (schema lacks the data — msgvault supports them), negation IS supported
// (msgvault does not), free-text ordering is relevance-ranked (D5), and
// semantic hits carry at most 1 excerpt. README D6: only id-bearing fields
// diverge to UUID strings — search tools have none.
const SEARCH_METADATA_OPERATOR_DOC =
  'Supported operators: from:, to:, cc:, subject:, has:attachment, ' +
  'before:/after: (YYYY-MM-DD), older_than:/newer_than: (e.g. 7d, 2w, 1m, 1y). ' +
  'Bare domains on from:/to: match any address at that domain. Multiple terms are ANDed. ' +
  'Rejected as unsupported on this server (divergence from msgvault, which supports them): ' +
  'label: (or l:), bcc:, larger:, smaller: — Mailflow stores no labels, BCC recipients, or message sizes; ' +
  'list:/list-id: are Gmail-only and also rejected. ' +
  'Negation with a leading - (e.g. -from:alice, -invoice) IS supported (divergence from msgvault); ' +
  'OR and parentheses grouping are not.';
const SEARCH_METADATA_FREETEXT_DOC =
  'Free text matches subject, snippet, and sender/recipient metadata only (not bodies). ' +
  'Use search_message_bodies for body keywords or semantic_search_messages for vector/hybrid search.';
const SEARCH_METADATA_PAGINATION_DOC =
  'Free-text results are relevance-ranked (divergence from msgvault); filter-only queries ' +
  'are ordered newest-first (by sent date). There is no sort parameter — ' +
  'use before:/after: to scope a date range. ' +
  'Paginate with offset/limit (default limit 20, max 50). ' +
  'Response: data, total, returned, offset, has_more.';

export const searchMetadataDef = {
  name: 'search_metadata',
  description:
    'Search message metadata using a subset of Gmail query syntax (not full Gmail compatibility). ' +
    SEARCH_METADATA_OPERATOR_DOC + ' ' + SEARCH_METADATA_FREETEXT_DOC + ' ' +
    SEARCH_METADATA_PAGINATION_DOC +
    'For body keywords use search_message_bodies; for vector/hybrid search use semantic_search_messages.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Search query (e.g. 'from:alice subject:meeting after:2024-01-01'). See tool description for supported operators and limitations." },
      account: { type: 'string', description: 'Filter by account email address (use get_stats to list available accounts)' },
      limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
    },
    required: ['query'],
  },
};

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
export function searchLimitArg(args) {
  const v = Number(args.limit);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.trunc(v), MAX_SEARCH_LIMIT);
}
export function offsetArg(args) {
  const v = Number(args.offset);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.trunc(v);
}

export async function handleSearchMetadata(args, scope) {
  const query = (args.query || '').trim();
  if (!query) return errorResult('query parameter is required');
  const parsed = parseQuery(query);
  // msgvault ordering (handlers.go:372-378): parse-value errors verbatim,
  // then unsupported operators — never silently widen the result set.
  const parseErr = queryParseErrorMessage(parsed);
  if (parseErr) return errorResult(parseErr);
  const unsupportedMsg = unsupportedSearchOperatorMessage(parsed);
  if (unsupportedMsg) return errorResult(unsupportedMsg);
  const limit = searchLimitArg(args);
  const offset = offsetArg(args);
  // Narrow to a single account when `account` is given (msgvault getAccountID) —
  // searchService trusts a pre-resolved accountIds as-is, so the narrowing must
  // happen here (it never re-reads the `account` email).
  const acc = await resolveAccountScope(args.account, scope.accountIds);
  if (acc.error) return errorResult(acc.error);
  const result = await search({
    mode: 'lexical', scope: 'metadata',
    rawQuery: query, parsed,
    accountIds: acc.accountIds,
    limit, offset,
  });
  const byId = await hydrateSummaries(result.messages, acc.accountIds);
  const data = (result.messages || []).map((m) => byId.get(m.id)).filter(Boolean);
  // total is ALWAYS present on this envelope (msgvault SearchFastCount is a
  // real count, handlers.go:400-405). The seam omits it on degenerate queries
  // whose terms were all dropped — those return zero rows, so total is 0.
  const total = Number.isFinite(result.total) ? result.total : 0;
  return jsonResult(newPaginatedResponse(data, total, offset));
}

export const searchMessageBodiesDef = {
  name: 'search_message_bodies',
  description:
    'Keyword full-text search over message bodies. ' +
    'Returns messages whose body text contains the query terms, relevance-ranked, ' +
    'each with matches — up to 5 excerpt snippets centered on matched terms. ' +
    'Backend excerpts may omit char_offset and line when efficient source locations are unavailable; use search_in_message when exact locations are needed. ' +
    'When matches_truncated is true on a hit, more than 5 excerpts matched — use search_in_message or get_message to read the full body. ' +
    'Known Gmail operators (from:, subject:, etc.) apply as metadata filters only and do not satisfy the free-text requirement. ' +
    'Filter-only queries such as from:alice are rejected — use search_metadata for filter-only queries. ' +
    'Unrecognized word:value tokens (e.g. RXD2:V2) are treated as literal body text, not filters. ' +
    'Query syntax: space-separated words are ANDed (each must appear somewhere in the body); ' +
    'a double-quoted phrase is one exact phrase (e.g. "RXD2 V2"); negation with a leading - excludes a term ' +
    '(divergence from msgvault); OR is not supported. ' +
    SEARCH_METADATA_OPERATOR_DOC + ' ' +
    'Results are relevance-ranked, best lexical match first (divergence from msgvault, which orders newest-first). ' +
    'Paginate with offset/limit (default limit 20, max 50). Response: data, returned, offset, has_more. ' +
    'Body search does not return a total; use has_more to detect more pages.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Body search query with at least one free-text term (bare word or quoted phrase). Gmail operators (from:, subject:, etc.) are metadata filters, not body search — subject:test alone is rejected; combine with body terms (from:alice budget) or use search_metadata for filter-only queries. Unrecognized word:value tokens (RXD2:V2) are literal text. Space-separated words are ANDed; double quotes match an exact phrase; a leading - negates a term; OR unsupported.' },
      account: { type: 'string', description: 'Filter by account email address (use get_stats to list available accounts)' },
      limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
    },
    required: ['query'],
  },
};

const EMPTY_GENERATION = { id: 0, model: '', dimension: 0, fingerprint: '', state: '' };
const MAX_CONTEXT_SNIPPETS = 5;
const SEARCH_CONTEXT_CHARS = 300;

function freeTextTerms(parsed) {
  return (parsed.terms || []).filter((t) => !t.negate).map((t) => t.value);
}

// hybridScoreBreakdown omitempty parity (msgvault handlers.go:563-572): all
// signal fields are pointer-typed with omitempty — rrf is omitted in
// mode=vector (one signal, nothing to fuse) and subject_boosted when false.
// The seam's explain object always carries rrf + a boolean subject_boosted.
function wireScore(score, mode) {
  const out = {};
  if (mode === 'hybrid' && score.rrf != null) out.rrf = score.rrf;
  if (score.bm25 != null) out.bm25 = score.bm25;
  if (score.vector != null) out.vector = score.vector;
  if (score.subject_boosted) out.subject_boosted = true;
  return out;
}

export async function handleSearchMessageBodies(args, scope) {
  const query = (args.query || '').trim();
  if (!query) return errorResult('query parameter is required');
  // Keyword-only tool: an explicit vector/hybrid mode is rejected, not
  // ignored (msgvault handlers.go:442-457 — same two wordings).
  const mode = args.mode || 'keyword';
  if (mode === 'vector' || mode === 'hybrid') {
    return errorResult(
      `invalid mode "${mode}": search_message_bodies is keyword-only; use semantic_search_messages for vector or hybrid search`,
    );
  }
  if (mode !== 'keyword') {
    return errorResult(
      `invalid mode "${mode}": search_message_bodies only supports keyword search; use semantic_search_messages for vector or hybrid search`,
    );
  }
  const parsed = parseQuery(query);
  // msgvault ordering (handlers.go:459-465): parse errors, then unsupported
  // operators, before the free-text requirement.
  const parseErr = queryParseErrorMessage(parsed);
  if (parseErr) return errorResult(parseErr);
  const unsupportedMsg = unsupportedSearchOperatorMessage(parsed);
  if (unsupportedMsg) return errorResult(unsupportedMsg);
  const terms = freeTextTerms(parsed);
  if (!terms.length) {
    return errorResult(
      'search_message_bodies requires at least one free-text term (bare word or quoted phrase); ' +
      'Gmail operators such as from: or subject: are metadata filters and do not count — ' +
      'use search_metadata for filter-only queries',
    );
  }
  const limit = searchLimitArg(args);
  const offset = offsetArg(args);
  const acc = await resolveAccountScope(args.account, scope.accountIds);
  if (acc.error) return errorResult(acc.error);
  // Over-fetch one to compute has_more without a count query (msgvault limit+1).
  const result = await search({
    mode: 'lexical', scope: 'body',
    rawQuery: query, parsed,
    accountIds: acc.accountIds,
    limit: limit + 1, offset,
  });
  let hits = result.messages || [];
  const hasMore = hits.length > limit;
  if (hasMore) hits = hits.slice(0, limit);

  const byId = await hydrateSummaries(hits, acc.accountIds);
  const data = hits.map((m) => {
    const summary = byId.get(m.id);
    if (!summary) return null;
    const snippets = extractContextChar(m.body_text || '', terms, SEARCH_CONTEXT_CHARS) || [];
    const capped = snippets.slice(0, MAX_CONTEXT_SNIPPETS);
    // Go omitempty parity (msgvault handlers.go:339-341): matches is omitted
    // when empty and matches_truncated when false — never emitted as []/false.
    const item = { ...summary };
    if (capped.length) item.matches = capped.map((snippet) => ({ snippet }));
    if (snippets.length > MAX_CONTEXT_SNIPPETS) item.matches_truncated = true;
    return item;
  }).filter(Boolean);

  return jsonResult({
    ...newPaginatedResponseNoTotal(data, offset, hasMore),
    mode: 'keyword',
    pool_saturated: false,
    generation: EMPTY_GENERATION,
  });
}

export const semanticSearchMessagesDef = {
  name: 'semantic_search_messages',
  description:
    'Semantic (embedding) search over each preprocessed message subject and body. ' +
    'Returns messages ranked by similarity to the query — there is no exact total, so page on has_more. ' +
    'Each hit includes matches — at most 1 best-matching embedded subject/body chunk excerpt with a score (divergence from msgvault, which returns up to 5). ' +
    'Vector char_offset and line locations may be omitted because preprocessing usually prevents exact raw-body mapping; use snippet terms with search_in_message keyword mode when navigation is needed. ' +
    'min_score filters chunk excerpts only; it does not remove or reorder ranked messages. ' +
    'Requires at least one free-text term (used to embed); filter-only queries must use search_metadata. ' +
    'Known Gmail operators (from:, subject:, etc.) apply as metadata filters only. ' +
    SEARCH_METADATA_OPERATOR_DOC + ' ' +
    'mode=vector for pure semantic search or mode=hybrid to fuse BM25 and vector ranking via RRF. ' +
    'Paginate with offset/limit (default limit 20, max 50). Response: data, returned, offset, has_more, mode, pool_saturated, generation. ' +
    'total is not available; use has_more to page.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text query to embed (requires at least one free-text term). Gmail operators are metadata filters, not body search; combine with body terms or use search_metadata for filter-only queries.' },
      account: { type: 'string', description: 'Filter by account email address (use get_stats to list available accounts)' },
      limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
      mode: { type: 'string', enum: ['vector', 'hybrid'], description: 'Search mode: vector (semantic only) or hybrid (BM25 + vector fused via RRF). Defaults to hybrid when omitted.' },
      explain: { type: 'boolean', description: 'Include per-signal scores in the response (for debugging or ranking inspection)' },
      min_score: { type: 'number', description: 'Minimum chunk similarity score for included match excerpts (default 0); does not filter ranked messages' },
    },
    required: ['query'],
  },
};

export async function handleSemanticSearchMessages(args, scope) {
  const query = (args.query || '').trim();
  if (!query) return errorResult('query parameter is required');

  const mode = args.mode || 'hybrid';
  if (mode !== 'vector' && mode !== 'hybrid') {
    return errorResult(
      `invalid mode "${mode}": must be vector or hybrid (default hybrid); use search_message_bodies for keyword search`,
    );
  }

  const parsed = parseQuery(query);
  // msgvault ordering (handlers.go:552-558): parse errors, then unsupported
  // operators, before the free-text requirement.
  const parseErr = queryParseErrorMessage(parsed);
  if (parseErr) return errorResult(parseErr);
  const unsupportedMsg = unsupportedSearchOperatorMessage(parsed);
  if (unsupportedMsg) return errorResult(unsupportedMsg);
  const terms = freeTextTerms(parsed);
  if (!terms.length) {
    return errorResult(
      `missing_free_text: mode=${mode} requires at least one free-text term; use search_metadata for filter-only queries`,
    );
  }

  const limit = searchLimitArg(args);
  const offset = offsetArg(args);
  // Offsets past the ranked window cannot be served — reject them instead of
  // returning silently-empty pages (msgvault handlers.go:656-663 wording).
  if (offset >= HYBRID_RANKING_WINDOW) {
    return errorResult(
      `pagination_limit: offset ${offset} exceeds hybrid ranking window (max ${HYBRID_RANKING_WINDOW}); ` +
      'use search_metadata or search_message_bodies for deeper pagination',
    );
  }
  const explain = args.explain === true;
  const minScore = Number.isFinite(Number(args.min_score)) ? Number(args.min_score) : 0;

  const acc = await resolveAccountScope(args.account, scope.accountIds);
  if (acc.error) return errorResult(acc.error);

  // strictVector: the seam rethrows VectorUnavailableError (msgvault taxonomy)
  // instead of the REST silent-lexical fallback.
  let result;
  try {
    result = await search({
      mode, scope: 'body', strictVector: true,
      rawQuery: query, parsed,
      accountIds: acc.accountIds,
      limit, offset, explain, minScore,
    });
  } catch (err) {
    if (err.name === 'VectorUnavailableError') return errorResult(translateVectorError(err.reason));
    if (err.name === 'MissingFreeTextError') {
      // The seam applies stricter term hygiene (sub-2-char / punctuation-only
      // tokens never embed) than the raw-terms pre-check above; surface the
      // same msgvault wording (handlers.go:631-635) instead of letting it
      // escape the tool call as `internal error: missing_free_text`.
      return errorResult(
        `missing_free_text: mode=${mode} requires at least one free-text term; use search_metadata for filter-only queries`,
      );
    }
    throw err;
  }

  // Phase 4 surfaces best_chunk per hit (chunk_index + code-point char_start/char_end
  // into preprocessed text + score). Phase 5 owns the snippet + raw-body byte offsets:
  // build the wire matches[] (≤1 excerpt — documented divergence from msgvault's ≤5)
  // from best_chunk via chunkmatch.matchFromChunk.
  const byId = await hydrateSummaries(result.messages, acc.accountIds);
  const data = (await Promise.all((result.messages || []).map(async (m) => {
    const summary = byId.get(m.id);
    if (!summary) return null;
    const item = { ...summary };
    if (m.best_chunk) {
      const match = await matchFromChunk(m.id, m.best_chunk, { accountIds: acc.accountIds });
      if (match && match.score >= minScore) item.matches = [match];
    }
    if (explain && m.score) item.score = wireScore(m.score, mode);
    return item;
  }))).filter(Boolean);

  return jsonResult({
    ...newPaginatedResponseNoTotal(data, offset, result.page?.hasMore || false),
    mode,
    pool_saturated: result.pool_saturated || false,
    generation: result.generation || EMPTY_GENERATION,
  });
}
