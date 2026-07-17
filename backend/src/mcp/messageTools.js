// The msgvault message/aggregate/deletion tool handlers. Every read goes through
// engineAdapter (all SQL lives there); handlers only shape and page. Byte offsets
// throughout are UTF-8 bytes into the raw body (msgvault wire contract).
import {
  getMessage, rowToMessageDetail, listMessages, listAccounts, getTotalStats, aggregate, searchByDomains,
  getMessageSummariesByIDs, stageDeletion, resolveAccountScope, messageInScope, countEnforceableQueryPredicates,
} from './engineAdapter.js';
import { parseQuery } from '../services/search/queryParser.js';
import { bodyByteSliceRange, contextWindow, findTermMatches } from './bodyMatch.js';
import { jsonResult, errorResult } from './result.js';
import { newPaginatedResponse, newPaginatedResponseNoTotal, toRFC3339, wireSummary } from './envelope.js';
import {
  searchLimitArg, offsetArg,
  queryParseErrorMessage, unsupportedSearchOperatorMessage, HYBRID_RANKING_WINDOW,
} from './searchTools.js';
import { collectStats } from './vectorStats.js';
import { translateVectorError } from './vectorErrors.js';
import { resolveActiveGenerationFromConfig } from '../services/embeddings/hybrid.js'; // phase-4 public face
import { loadVector, annSearch } from '../services/embeddings/vectorStore.js'; // phase 3
import { matchesInMessage } from '../services/embeddings/chunkmatch.js'; // phase-5-owned

const DEFAULT_BODY_CHARS = 2000;
const MAX_BODY_CHARS = 4000;
const MAX_LIMIT = 1000;

// msgvault limitArg: absent/non-number → default; negative/NaN → 0; clamp to 1000.
// (Distinct from searchLimitArg's 20/50 search clamp.)
function limitArg(args, key, def) {
  const raw = args[key];
  if (typeof raw !== 'number') return def;
  if (Number.isNaN(raw) || raw < 0) return 0;
  if (raw > MAX_LIMIT) return MAX_LIMIT;
  return Math.trunc(raw);
}

// msgvault getDateArg (handlers.go:264-275): an optional after/before arg is a
// strict YYYY-MM-DD; anything else errors at the handler instead of leaking a
// raw Postgres cast error to the wire. Non-strings/empty are "no filter", and
// JS Date rollover (2024-02-31 → Mar 1) is rejected via the Y/M/D round-trip
// (Go time.Parse errors "day out of range"). Returns { value } or { error }.
function dateArg(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || v === '') return { value: undefined };
  const err = { error: `invalid ${key} date "${v}": expected YYYY-MM-DD` };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return err;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return err;
  return { value: v };
}

export const getMessageDef = {
  name: 'get_message',
  description:
    'Get message details including recipients, labels, attachments, and a slice of the message body. ' +
    'Returns plain text when available; HTML-only messages return a body_html slice with body_format=html. ' +
    'Body paging mirrors search pagination: body_length=total bytes, offset=where this chunk starts, body_returned=bytes in this chunk, has_more=more body follows. ' +
    'To read sequentially: call again with offset += body_returned. ' +
    'To jump to a known match location: use center_at=<byte offset> to center the window on that location. ' +
    'Note: snippet is pre-stored source metadata (may be empty for non-Gmail sources).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Message ID' },
      offset: { type: 'number', description: 'Byte offset from the start of the selected body to begin reading (default 0). Ignored when center_at is provided.' },
      center_at: { type: 'number', description: 'Byte offset from the start of the selected body to center the window on. Takes precedence over offset.' },
      max_chars: { type: 'number', description: 'Maximum selected-body bytes to return (default 2000, max 4000). Values above 4000 are clamped to 4000; zero or negative values use the default.' },
      body_format: { type: 'string', enum: ['auto', 'text', 'html'], description: 'Which body representation to page: auto (default, plain text when available, HTML fallback), text, or html.' },
      full_body: { type: 'boolean', description: 'Return the complete selected body in one response, ignoring offset, center_at, and max_chars. Use only when the full content is explicitly needed.' },
    },
    required: ['id'],
  },
};

export async function handleGetMessage(args, scope) {
  const id = args.id;
  if (!id || typeof id !== 'string') return errorResult('id parameter is required');
  const row = await getMessage(id, scope.accountIds);
  if (!row) return errorResult('message not found');
  const detail = rowToMessageDetail(row);

  let maxChars = Number(args.max_chars);
  if (!Number.isFinite(maxChars) || maxChars <= 0) maxChars = DEFAULT_BODY_CHARS;
  else if (maxChars > MAX_BODY_CHARS) maxChars = MAX_BODY_CHARS;

  const requested = args.body_format || 'auto';
  let full = detail.body_text;
  let bodyFormat = 'text';
  if (requested === 'auto') {
    if (!full && detail.body_html) { full = detail.body_html; bodyFormat = 'html'; }
  } else if (requested === 'html') {
    full = detail.body_html; bodyFormat = 'html';
  } else if (requested !== 'text') {
    return errorResult('body_format must be one of auto, text, html');
  }

  const buf = Buffer.from(full || '', 'utf8');
  const bodyLen = buf.length;

  let start, end;
  if (args.full_body === true) {
    start = 0; end = bodyLen;
  } else if (Number.isFinite(Number(args.center_at)) && Number(args.center_at) >= 0) {
    [start, end] = contextWindow(bodyLen, Math.trunc(Number(args.center_at)), 0, maxChars);
  } else {
    start = Math.min(Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0, bodyLen);
    end = Math.min(start + maxChars, bodyLen);
  }

  const { text: slice, adjStart, adjEnd } = bodyByteSliceRange(buf, start, end);
  const returnedBytes = Buffer.byteLength(slice, 'utf8');

  return jsonResult({
    id: detail.id,
    source_message_id: detail.source_message_id,
    conversation_id: detail.conversation_id,
    source_conversation_id: detail.source_conversation_id,
    subject: detail.subject,
    message_type: detail.message_type,
    snippet: detail.snippet,
    sent_at: toRFC3339(detail.sent_at),
    size_estimate: detail.size_estimate,
    has_attachments: detail.has_attachments,
    from: detail.from,
    to: detail.to,
    cc: detail.cc,
    bcc: detail.bcc,
    body_text: bodyFormat === 'html' ? '' : slice,
    body_html: bodyFormat === 'html' ? slice : '',
    body_format: bodyFormat,
    body_length: bodyLen,
    body_returned: returnedBytes,
    offset: adjStart,
    has_more: adjEnd < bodyLen,
    labels: detail.labels,
    attachments: detail.attachments,
  });
}

export const listMessagesDef = {
  name: 'list_messages',
  description:
    'List messages with optional filters, newest-first. ' +
    "Pass conversation_id to enumerate a thread's messages, then call get_message(id) per message to read bodies — " +
    'there is deliberately no bulk body fetch, to avoid loading huge threads into the context window. ' +
    'Paginate with offset/limit (default limit 20, max 50). Response: data, total, returned, offset, has_more. ' +
    'total=-1 because the full count is not computed; use has_more for paging.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Filter by account email address (use get_stats to list available accounts)' },
      from: { type: 'string', description: 'Filter by sender email address' },
      to: { type: 'string', description: 'Filter by recipient email address' },
      label: { type: 'string', description: 'Filter by Gmail label' },
      after: { type: 'string', description: 'Only messages after this date (YYYY-MM-DD)' },
      before: { type: 'string', description: 'Only messages before this date (YYYY-MM-DD)' },
      has_attachment: { type: 'boolean', description: 'Only messages with attachments' },
      conversation_id: { type: 'string', description: 'Filter by conversation/thread ID' },
      limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
    },
  },
};

export async function handleListMessages(args, scope) {
  const acc = await resolveAccountScope(args.account, scope.accountIds);
  if (acc.error) return errorResult(acc.error);
  const after = dateArg(args, 'after');
  if (after.error) return errorResult(after.error);
  const before = dateArg(args, 'before');
  if (before.error) return errorResult(before.error);
  const limit = searchLimitArg(args);
  const offset = offsetArg(args);
  // Over-fetch one to compute has_more without a count query (msgvault limit+1).
  let rows = await listMessages({
    accountIds: acc.accountIds,
    from: args.from, to: args.to, label: args.label,
    hasAttachment: args.has_attachment === true,
    after: after.value, before: before.value,
    conversationId: args.conversation_id,
    limit: limit + 1, offset,
  });
  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);
  return jsonResult(newPaginatedResponseNoTotal(rows.map(wireSummary), offset, hasMore));
}

export const getStatsDef = {
  name: 'get_stats',
  description: 'Get archive overview: total messages, size, attachment count, and accounts.',
  inputSchema: { type: 'object', properties: {} },
};

// A broken vector sub-query must never blank the whole stats response (msgvault
// best-effort semantics); on any failure the vector_search field is simply omitted.
async function safeCollectStats(accountIds) {
  try { return await collectStats(accountIds); } catch { return null; }
}

export async function handleGetStats(_args, scope) {
  const stats = await getTotalStats(scope.accountIds);
  const accounts = await listAccounts(scope.accountIds);
  const resp = { stats, accounts };
  const vs = await safeCollectStats(scope.accountIds);
  if (vs) resp.vector_search = vs; // omitempty: present only when vector search is enabled
  return jsonResult(resp);
}

const AGGREGATE_GROUP_BY = ['sender', 'recipient', 'domain', 'label', 'time'];

export const aggregateDef = {
  name: 'aggregate',
  description:
    'Get grouped statistics (top senders, recipients, domains, labels, or message volume by calendar year). ' +
    'Returns a JSON array of objects with fields Key, Count, TotalSize, AttachmentSize, AttachmentCount, and TotalUnique.',
  inputSchema: {
    type: 'object',
    properties: {
      group_by: { type: 'string', enum: ['sender', 'recipient', 'domain', 'label', 'time'], description: 'Dimension to group by. When \'time\', buckets are by calendar year only (Key is a year string like "2024").' },
      account: { type: 'string', description: 'Filter by account email address (use get_stats to list available accounts)' },
      limit: { type: 'number', description: 'Maximum results to return (default 50)' },
      after: { type: 'string', description: 'Only messages after this date (YYYY-MM-DD)' },
      before: { type: 'string', description: 'Only messages before this date (YYYY-MM-DD)' },
    },
    required: ['group_by'],
  },
};

export async function handleAggregate(args, scope) {
  const groupBy = args.group_by || '';
  if (!groupBy) return errorResult('group_by parameter is required');
  if (!AGGREGATE_GROUP_BY.includes(groupBy)) return errorResult('invalid group_by: ' + groupBy);
  const acc = await resolveAccountScope(args.account, scope.accountIds);
  if (acc.error) return errorResult(acc.error);
  const after = dateArg(args, 'after');
  if (after.error) return errorResult(after.error);
  const before = dateArg(args, 'before');
  if (before.error) return errorResult(before.error);
  const rows = await aggregate(groupBy, {
    accountIds: acc.accountIds,
    after: after.value, before: before.value,
    limit: limitArg(args, 'limit', 50),
  });
  return jsonResult(rows); // raw array, no envelope (msgvault parity)
}

export const searchByDomainsDef = {
  name: 'search_by_domains',
  description: 'Find emails where any participant (from, to, or cc) belongs to one of the given domains. Useful for finding all communication with a company regardless of direction.',
  inputSchema: {
    type: 'object',
    properties: {
      domains: { type: 'string', description: "Comma-separated domain names (e.g. 'gobright.com,ascentae.com')" },
      limit: { type: 'number', description: 'Maximum results to return (default 100)' },
      offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
      after: { type: 'string', description: 'Only messages after this date (YYYY-MM-DD)' },
      before: { type: 'string', description: 'Only messages before this date (YYYY-MM-DD)' },
    },
    required: ['domains'],
  },
};

export async function handleSearchByDomains(args, scope) {
  const domainsStr = (args.domains || '').trim();
  if (!domainsStr) return errorResult('domains is required');
  const domains = domainsStr.split(',').map((d) => d.trim()).filter(Boolean);
  if (!domains.length) return errorResult('at least one domain is required');
  const limit = limitArg(args, 'limit', 100);
  const offset = limitArg(args, 'offset', 0);
  const after = dateArg(args, 'after');
  if (after.error) return errorResult(after.error);
  const before = dateArg(args, 'before');
  if (before.error) return errorResult(before.error);
  const results = await searchByDomains(domains, after.value, before.value, limit, offset, scope.accountIds);
  return jsonResult(results.map(wireSummary)); // raw array (msgvault parity)
}

export const findSimilarMessagesDef = {
  name: 'find_similar_messages',
  description: 'Find messages whose embeddings are closest to the given message. Requires vector search to be configured and an active index generation.',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Seed message ID; its embedding is used as the query vector' },
      limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      account: { type: 'string', description: 'Filter by account email address (use get_stats to list available accounts)' },
      message_type: { type: 'string', description: 'Restrict results to one message type, such as email, sms, mms, fbmessenger, or calendar_event' },
      after: { type: 'string', description: 'Only messages after this date (YYYY-MM-DD)' },
      before: { type: 'string', description: 'Only messages before this date (YYYY-MM-DD)' },
      has_attachment: { type: 'boolean', description: 'Only messages with attachments' },
    },
    required: ['message_id'],
  },
};

export async function handleFindSimilarMessages(args, scope) {
  const seedId = args.message_id;
  if (!seedId || typeof seedId !== 'string') return errorResult('message_id parameter is required');
  let limit = Number(args.limit);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  // msgvault clamps to the hybrid page cap (handlers.go:885-888).
  if (limit > HYBRID_RANKING_WINDOW) limit = HYBRID_RANKING_WINDOW;

  const acc = await resolveAccountScope(args.account, scope.accountIds);
  if (acc.error) return errorResult(acc.error);
  const after = dateArg(args, 'after');
  if (after.error) return errorResult(after.error);
  const before = dateArg(args, 'before');
  if (before.error) return errorResult(before.error);
  const messageType = typeof args.message_type === 'string' ? args.message_type.trim().toLowerCase() : '';

  try {
    const { generation: gen } = await resolveActiveGenerationFromConfig();

    // Owner-scope the seed: loadVector is not account-aware, so a foreign/unknown
    // seed id must behave like get_message on a foreign id (contract: every tool
    // call is owner-scoped; also closes an embedding-existence oracle).
    if (!(await messageInScope(seedId, acc.accountIds))) return errorResult('message not found');

    let seed;
    try { seed = await loadVector(seedId); }
    catch (e) { return errorResult(`load seed vector: ${e.message}`); }

    const filter = { accountIds: acc.accountIds };
    if (after.value) filter.after = after.value;
    if (before.value) filter.before = before.value;
    if (args.has_attachment === true) filter.hasAttachment = true;
    // phase-3 annSearch takes the generation ID (not the object) and returns
    // [{messageId, score, rank}] rank-ordered. +1 to drop the seed without coming up short.
    const hits = await annSearch(gen.id, seed, limit + 1, { filter });

    const ids = [];
    for (const h of hits) {
      if (h.messageId === seedId) continue;
      if (ids.length >= limit) break;
      ids.push(h.messageId);
    }
    let messages = await getMessageSummariesByIDs(ids, acc.accountIds);
    // msgvault applies message_type inside the vector backend filter
    // (handlers.go:1042-1044); Mailflow's annSearch filter has no such leg, so
    // the advertised filter is applied on the hydrated summaries (every
    // Mailflow message is 'email' today — a non-email filter returns zero).
    if (messageType) messages = messages.filter((m) => m.message_type === messageType);
    return jsonResult({
      seed_message_id: seedId,
      returned: messages.length,
      generation: { id: gen.id, model: gen.model, dimension: gen.dimension, fingerprint: gen.fingerprint, state: gen.state },
      messages: messages.map(wireSummary),
    });
  } catch (err) {
    if (err.name === 'VectorUnavailableError') return errorResult(translateVectorError(err.reason));
    throw err;
  }
}

export const searchInMessageDef = {
  name: 'search_in_message',
  description:
    'Find matches within one message body. Default mode=keyword finds literal term occurrences. ' +
    'mode=vector scores each embedded chunk by semantic similarity to the query (best first, with score on each match). ' +
    'Keyword matches include raw-body char_offset and line. Vector matches always include snippet and score; char_offset and line may be omitted after preprocessing. ' +
    'Use a present char_offset with get_message center_at to read a larger window around the match.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Message ID' },
      query: { type: 'string', description: 'Search query (keyword term, or semantic query when mode=vector)' },
      limit: { type: 'number', description: 'Maximum matches to return (default 10)' },
      offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
      mode: { type: 'string', enum: ['keyword', 'vector'], description: 'Search mode: keyword (default, literal term) or vector (semantic chunk scoring)' },
      min_score: { type: 'number', description: 'Minimum chunk similarity score (0–1) when mode=vector (default 0)' },
    },
    required: ['id', 'query'],
  },
};

export async function handleSearchInMessage(args, scope) {
  const id = args.id;
  if (!id || typeof id !== 'string') return errorResult('id parameter is required');
  const q = (args.query || '').trim();
  if (!q) return errorResult('query parameter is required');
  const limit = limitArg(args, 'limit', 10);
  const offset = limitArg(args, 'offset', 0);
  const mode = args.mode || 'keyword';

  if (mode === 'vector') {
    try {
      const minScore = Number.isFinite(Number(args.min_score)) ? Number(args.min_score) : 0;
      // matchesInMessage is scope-aware: it resolves the message under
      // scope.accountIds and throws VectorUnavailableError on stock Postgres.
      const all = await matchesInMessage(id, q, minScore, { accountIds: scope.accountIds });
      const page = all.slice(offset, offset + limit);
      return jsonResult(newPaginatedResponse(page, all.length, offset));
    } catch (err) {
      if (err.name === 'VectorUnavailableError') return errorResult(translateVectorError(err.reason));
      throw err;
    }
  }
  if (mode !== 'keyword') return errorResult(`invalid mode "${mode}": must be keyword (default) or vector`);

  const row = await getMessage(id, scope.accountIds);
  if (!row) return errorResult('message not found');
  const all = findTermMatches(row.body_text || '', q); // byte-offset keyword matches (real total)
  const page = all.slice(offset, offset + limit);
  return jsonResult(newPaginatedResponse(page, all.length, offset));
}

export const stageDeletionDef = {
  name: 'stage_deletion',
  description: "Stage messages for deletion. Use EITHER 'query' (Gmail-style search) OR structured filters (from, domain, label, etc.), not both. Does NOT delete immediately - execution is a separate, explicitly-authorized step.",
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: 'Filter by account email address (use get_stats to list available accounts)' },
      query: { type: 'string', description: "Gmail-style search query (e.g. 'from:linkedin subject:job alert'). Cannot be combined with structured filters." },
      from: { type: 'string', description: 'Filter by sender email address' },
      domain: { type: 'string', description: "Filter by sender domain (e.g. 'linkedin.com')" },
      label: { type: 'string', description: "Filter by Gmail label (e.g. 'CATEGORY_PROMOTIONS')" },
      after: { type: 'string', description: 'Only messages after this date (YYYY-MM-DD)' },
      before: { type: 'string', description: 'Only messages before this date (YYYY-MM-DD)' },
      has_attachment: { type: 'boolean', description: 'Only messages with attachments' },
    },
  },
};

// A parsed query that survives validation but produces zero enforceable
// predicates would stage the entire (capped) mailbox — refuse it. Parse errors
// and unsupported operators are already rejected before this runs (msgvault
// ordering), so the only remaining cause is all-discarded terms.
function noEnforceableFiltersMessage() {
  return 'query produced no enforceable filters (all query terms were discarded as too short, ' +
    'punctuation-only, or negation-only); refusing to stage deletions';
}

export async function handleStageDeletion(args, scope) {
  const q = (args.query || '').trim();
  const hasQuery = q !== '';
  const structured = !!(args.from || args.domain || args.label || args.has_attachment || args.after || args.before);
  if (hasQuery && structured) return errorResult("use either 'query' or structured filters (from, domain, label, etc.), not both");
  if (!hasQuery && !structured) return errorResult("must provide either 'query' or at least one filter (from, domain, label, after, before, has_attachment)");
  const after = dateArg(args, 'after');
  if (after.error) return errorResult(after.error);
  const before = dateArg(args, 'before');
  if (before.error) return errorResult(before.error);

  const parsed = hasQuery ? parseQuery(q) : null;
  if (parsed) {
    // Parse-value errors and unsupported operators reject the staging query
    // outright (msgvault handlers.go:1818-1821). Deletion is where silent
    // widening bites hardest: dropping `label:promotions` from
    // `invoice label:promotions` would stage a SUPERSET of what was asked.
    const parseErr = queryParseErrorMessage(parsed);
    if (parseErr) return errorResult(parseErr);
    const unsupportedMsg = unsupportedSearchOperatorMessage(parsed);
    if (unsupportedMsg) return errorResult(unsupportedMsg);
    // Guard the "stage EVERYTHING" hazard: a query whose tokens are ALL
    // discarded (negation-only, sub-2-char/punctuation-only terms) leaves only
    // account+liveness in the WHERE. Refuse before staging.
    if (countEnforceableQueryPredicates(parsed) === 0) {
      return errorResult(noEnforceableFiltersMessage());
    }
  }

  const acc = await resolveAccountScope(args.account, scope.accountIds);
  if (acc.error) return errorResult(acc.error);

  const { batchId, messageCount } = await stageDeletion({
    userId: scope.userId, accountIds: acc.accountIds,
    parsed,
    from: args.from, domain: args.domain, label: args.label,
    hasAttachment: args.has_attachment === true, after: after.value, before: before.value,
    description: hasQuery ? `query: ${q}`.slice(0, 50) : 'filter',
  });
  if (!messageCount) return errorResult('no messages match the specified criteria');
  return jsonResult({
    batch_id: batchId,
    message_count: messageCount,
    // Wire literal is msgvault's manifest.StatusPending ("pending",
    // deletion/manifest.go:25, surfaced at handlers.go:1932). The DB row keeps
    // Mailflow's internal 'staged' state (engineAdapter.stageDeletion).
    status: 'pending',
    next_step: `POST /api/mcp-deletions/${batchId}/execute to soft-delete, or DELETE /api/mcp-deletions/${batchId} to cancel`,
  });
}
