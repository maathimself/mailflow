import {
  countUntriagedUnread,
  listTriageCandidates,
  markTriaged,
  senderHistory,
  sentFolderForAccount,
  triageActionsForMessages,
} from './triageAdapter.js';
import {
  getMessage,
  getMessageSummariesByIDs,
  listMessages,
  resolveAccountScope,
} from './engineAdapter.js';
import { findSimilarSummaries } from './messageTools.js';
import { errorResult, jsonResult } from './result.js';
import { toRFC3339, wireSummary } from './envelope.js';
import { translateVectorError } from './vectorErrors.js';
import { resolveActiveGenerationFromConfig } from '../services/embeddings/hybrid.js';
import { annSearch, loadVector } from '../services/embeddings/vectorStore.js';
import { runInBatches } from '../services/mailbox/batch.js';
import {
  getTriageProbeVectors,
  scoreTriageProbes,
} from './triageProbes.js';
import {
  resolveAllSpamPaths,
  resolveAllTrashPaths,
  resolveArchiveFolder,
} from '../utils/mailUtils.js';
import { getGtdFolderSet } from '../services/gtdConfig.js';
import { matchingRules, toRuleMessage } from '../services/inboxRules.js';
import { areValidUUIDs } from '../utils/validation.js';

function annotations({
  readOnlyHint = false,
  destructiveHint = false,
  idempotentHint = false,
} = {}) {
  return Object.freeze({
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint: false,
  });
}

const IDEMPOTENT_WRITE_ANNOTATIONS = annotations({ idempotentHint: true });
const READ_ONLY_ANNOTATIONS = annotations({
  readOnlyHint: true,
  idempotentHint: true,
});

const messageIdsSchema = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: 500,
};

function messageIdsArg(args) {
  const ids = args.message_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'message_ids must contain at least one id' };
  }
  if (ids.length > 500) return { error: 'Too many ids — maximum 500 per request' };
  if (!areValidUUIDs(ids)) return { error: 'Invalid message id format' };
  return { value: ids };
}

export const markTriagedDef = {
  name: 'mark_triaged',
  description:
    'Checkpoint messages as triaged so future triage_inbox runs skip them. Idempotent: re-marking updates the timestamp and action rather than erroring. ' +
    "Call mark_triaged before a move/archive, or use the move receipt's new_id, because marking after a move with the stale id silently resolves to skipped.",
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['message_ids'],
    properties: {
      message_ids: messageIdsSchema,
      action: { type: 'string' },
      note: { type: 'string', maxLength: 500 },
    },
  },
};

export const triageInboxDef = {
  name: 'triage_inbox',
  description:
    'One-call inbox triage feed across scoped accounts, oldest first, enriched with category, sender history, and thread state. ' +
    'The cursor is for paging only; the message_triage table (via NOT EXISTS) guarantees correctness and prevents duplicate skipping, so re-running with no cursor is safe and cheap. ' +
    'Call mark_triaged after acting so later no-cursor runs skip checkpointed messages. ' +
    'Optional similar-message and fixed v1 urgency-probe signals are included only at limit 25 or below. Raw cosine scores are not calibrated: rank within this response, not threshold across responses.',
  annotations: READ_ONLY_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 50, default: 25 },
      unread_only: { type: 'boolean', default: true },
      include_triaged: { type: 'boolean', default: false },
      categories: { type: 'array', items: { type: 'string' } },
      since: { type: 'string' },
      include_signals: { type: 'boolean', default: true },
    },
  },
};

export const getTriageContextDef = {
  name: 'get_triage_context',
  description:
    'Get independently degradable thread, sender-history, similar-message, and matched-rule context for one scoped message. ' +
    'Matched rules are report only: this tool never executes rule actions, and body/header rules are reported as unevaluated when those fields are not loaded.',
  annotations: READ_ONLY_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    required: ['message_id'],
    properties: {
      message_id: { type: 'string' },
      thread_limit: { type: 'number', minimum: 1, maximum: 50 },
      similar_limit: { type: 'number', minimum: 1, maximum: 50 },
    },
  },
};

function dateArg(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value === '') return { value: undefined };
  const error = { error: `invalid ${key} date "${value}": expected YYYY-MM-DD` };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return error;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return error;
  }
  return { value };
}

function triageLimit(args) {
  const raw = args.limit;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 25;
  return Math.min(Math.trunc(raw), 50);
}

function wireDate(value) {
  const iso = value instanceof Date ? value.toISOString() : value;
  return toRFC3339(iso);
}

function wireCandidate(row, includeSignals) {
  const item = {
    id: row.id,
    message_id: row.message_id,
    account: row.account,
    conversation_id: row.conversation_id,
    subject: row.subject,
    snippet: row.snippet,
    from_email: row.from_email,
    from_name: row.from_name,
    date: wireDate(row.date),
    is_read: !!row.is_read,
    is_starred: !!row.is_starred,
    has_attachments: !!row.has_attachments,
    category: row.category,
    is_bulk: !!row.is_bulk,
    has_unsubscribe: !!row.has_unsubscribe,
    spam_verdict: row.spam_verdict ?? null,
    thread: {
      message_count: Number(row.thread_message_count || 0),
      last_activity: wireDate(row.thread_last_activity),
      i_replied: !!row.i_replied,
    },
    contact: {
      known: !!row.contact_known,
      send_count: Number(row.send_count || 0),
      last_sent: wireDate(row.last_sent),
      received_count: Number(row.received_count || 0),
      first_received: wireDate(row.first_received),
      last_received: wireDate(row.last_received),
    },
  };
  if (includeSignals) item.signals = { similar: [], probes: {} };
  return item;
}

const SIMILAR_SIGNAL_LIMIT = 5;

function emptySignals(reason) {
  const signals = { similar: [], probes: {} };
  if (reason) signals.reason = reason;
  return signals;
}

function messageFolder(summary) {
  return Array.isArray(summary?.labels) && typeof summary.labels[0] === 'string'
    ? summary.labels[0]
    : '';
}

function hasFlag(summary, flag) {
  const wanted = flag.toLowerCase();
  return (Array.isArray(summary?.labels) ? summary.labels : [])
    .some(label => typeof label === 'string' && label.toLowerCase() === wanted);
}

// Name-based fallback only — used when the account has neither a sent mapping
// nor a \Sent special-use folder for sentFolderForAccount to resolve.
function isSentFolder(folder) {
  return /(^|[./ ])sent($|[./ ])/i.test(folder || '');
}

async function resolvedFolderClasses(accountId, cache) {
  if (!accountId) {
    return {
      archive: null,
      trash: new Set(),
      spam: new Set(),
      gtd: new Set(),
    };
  }
  if (!cache.has(accountId)) {
    const pending = (async () => {
      const [archive, trash, spam, gtd, sent] = await Promise.allSettled([
        resolveArchiveFolder(accountId),
        resolveAllTrashPaths(accountId),
        resolveAllSpamPaths(accountId),
        getGtdFolderSet(accountId),
        sentFolderForAccount(accountId),
      ]);
      return {
        archive: archive.status === 'fulfilled' ? archive.value : null,
        trash: trash.status === 'fulfilled' ? trash.value : new Set(),
        spam: spam.status === 'fulfilled' ? spam.value : new Set(),
        gtd: gtd.status === 'fulfilled' ? gtd.value : new Set(),
        sent: sent.status === 'fulfilled' ? sent.value : null,
      };
    })();
    cache.set(accountId, pending);
  }
  return cache.get(accountId);
}

function folderClass(folder, resolved) {
  if (!folder) return 'unknown';
  if (folder.toLowerCase() === 'inbox') return 'inbox';
  if (resolved.trash?.has(folder)) return 'trashed';
  if (resolved.spam?.has(folder)) return 'spam';
  if (resolved.sent ? folder === resolved.sent : isSentFolder(folder)) return 'sent';
  if (resolved.archive && folder === resolved.archive) return 'archived';
  if (resolved.gtd?.has(folder)) return 'labelled';
  return 'labelled';
}

async function similarWithDisposition(
  candidate,
  vector,
  generation,
  accountIds,
  folderCache,
) {
  const hits = await annSearch(
    generation.id,
    vector,
    SIMILAR_SIGNAL_LIMIT + 1,
    {
      filter: {
        accountIds,
        before: candidate.date,
      },
    },
  );
  const keptHits = hits
    .filter(hit => hit.messageId !== candidate.id)
    .slice(0, SIMILAR_SIGNAL_LIMIT);
  const hitIds = keptHits.map(hit => hit.messageId);
  const summaries = await getMessageSummariesByIDs(hitIds, accountIds);
  const scoreById = new Map(keptHits.map(hit => [hit.messageId, hit.score]));
  const classified = await Promise.all(summaries.map(async summary => {
    const resolved = await resolvedFolderClasses(summary.source_id, folderCache);
    return {
      summary,
      folderClass: folderClass(messageFolder(summary), resolved),
    };
  }));
  const repliedThreads = new Set(
    classified
      .filter(entry => entry.folderClass === 'sent')
      .map(entry => entry.summary.conversation_id)
      .filter(Boolean),
  );

  return classified.map(({ summary, folderClass: classification }) => ({
    ...wireSummary(summary),
    score: scoreById.get(summary.id),
    disposition: {
      folder_class: classification,
      was_read: hasFlag(summary, '\\Seen'),
      was_starred: hasFlag(summary, '\\Flagged'),
      was_replied: !!(
        summary.conversation_id
        && repliedThreads.has(summary.conversation_id)
      ),
    },
  }));
}

async function candidateSignals(
  candidate,
  {
    generation,
    probeVectors,
    accountIds,
    folderCache,
  },
) {
  let vector;
  try {
    vector = await loadVector(candidate.id);
  } catch {
    return emptySignals('not_embedded');
  }

  let probes = {};
  let probeFailed = false;
  if (probeVectors) {
    try {
      probes = scoreTriageProbes(vector, probeVectors);
    } catch {
      probeFailed = true;
    }
  }

  try {
    const similar = await similarWithDisposition(
      candidate,
      vector,
      generation,
      accountIds,
      folderCache,
    );
    const signals = { similar, probes };
    if (probeFailed) signals.reason = 'probe_error';
    return signals;
  } catch (error) {
    return {
      similar: [],
      probes,
      reason: error?.message || 'error',
    };
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function probeCalibration(signalsByCandidate) {
  const byProbe = new Map();
  for (const signals of signalsByCandidate) {
    for (const [name, score] of Object.entries(signals?.probes || {})) {
      if (!Number.isFinite(score)) continue;
      if (!byProbe.has(name)) byProbe.set(name, []);
      byProbe.get(name).push(score);
    }
  }
  return Object.fromEntries(
    [...byProbe].map(([name, values]) => [
      name,
      {
        min: Math.min(...values),
        median: median(values),
        max: Math.max(...values),
      },
    ]),
  );
}

function triageMessageKey(accountId, messageIdHeader) {
  return `${accountId}\0${messageIdHeader}`;
}

async function pageSignals(rows, accountIds) {
  if (!rows.length) {
    return {
      signals: [],
      available: true,
      reason: null,
      calibration: {},
    };
  }

  let cfg;
  let generation;
  try {
    ({ cfg, generation } = await resolveActiveGenerationFromConfig());
  } catch (error) {
    return {
      signals: rows.map(() => emptySignals()),
      available: false,
      reason: error?.name === 'VectorUnavailableError'
        ? translateVectorError(error.reason)
        : 'error',
      calibration: {},
    };
  }

  let probeVectors = null;
  try {
    probeVectors = await getTriageProbeVectors(cfg, generation);
  } catch {
    // Similar-message dispositions remain useful when only probe embedding fails.
  }

  const folderCache = new Map();
  const settled = await runInBatches(rows, 4, candidate => candidateSignals(
    candidate,
    {
      generation,
      probeVectors,
      accountIds,
      folderCache,
    },
  ));
  const signals = settled.map(result => (
    result.status === 'fulfilled'
      ? result.value
      : emptySignals(result.reason?.message || 'error')
  ));
  const pairsByKey = new Map();
  for (const signal of signals) {
    for (const summary of signal.similar) {
      if (!summary.source_message_id) continue;
      const pair = {
        accountId: summary.source_id,
        messageIdHeader: summary.source_message_id,
      };
      pairsByKey.set(triageMessageKey(pair.accountId, pair.messageIdHeader), pair);
    }
  }

  let actionRows = [];
  try {
    actionRows = await triageActionsForMessages([...pairsByKey.values()]);
  } catch {
    // Similar-message signals remain useful when checkpoint history is unavailable.
  }
  const actionByKey = new Map(actionRows.map(row => [
    triageMessageKey(row.account_id, row.message_id_header),
    row.action,
  ]));
  const enrichedSignals = signals.map(signal => ({
    ...signal,
    similar: signal.similar.map(summary => ({
      ...summary,
      disposition: {
        ...summary.disposition,
        triage_action: actionByKey.get(
          triageMessageKey(summary.source_id, summary.source_message_id),
        ) ?? null,
      },
    })),
  }));
  return {
    signals: enrichedSignals,
    available: true,
    reason: null,
    calibration: probeCalibration(enrichedSignals),
  };
}

function contextLimit(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 20;
  return Math.min(Math.trunc(raw), 50);
}

function sectionError(error) {
  return {
    available: false,
    reason: 'error',
    detail: error?.message || String(error),
  };
}

async function threadSection(seed, accountIds, limit) {
  try {
    if (!seed.thread_id) {
      return { available: false, reason: 'conversation_not_available' };
    }
    const messages = await listMessages({
      accountIds,
      conversationId: seed.thread_id,
      limit,
    });
    return {
      available: true,
      messages: messages.map(wireSummary),
    };
  } catch (error) {
    return sectionError(error);
  }
}

async function senderHistorySection(seed, accountIds) {
  try {
    const history = await senderHistory(seed.from_email, accountIds);
    return { available: true, history };
  } catch (error) {
    return sectionError(error);
  }
}

async function similarSection(seedId, accountIds, limit) {
  try {
    const result = await findSimilarSummaries(seedId, {
      accountIds,
      limit,
    });
    return {
      available: true,
      generation: result.generation,
      messages: result.messages.map(wireSummary),
    };
  } catch (error) {
    if (error?.name === 'VectorUnavailableError') {
      return {
        available: false,
        reason: translateVectorError(error.reason),
      };
    }
    return sectionError(error);
  }
}

function arrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizedRule(rule) {
  return {
    ...rule,
    conditions: arrayField(rule?.conditions),
    actions: arrayField(rule?.actions),
  };
}

function reportMatchingRules(rules, seed) {
  const message = toRuleMessage(seed);
  const reports = [];
  for (const rawRule of Array.isArray(rules) ? rules : []) {
    const rule = normalizedRule(rawRule);
    const needsUnavailableField = rule.conditions.some(
      condition => condition?.field === 'body' || condition?.field === 'header',
    );
    if (needsUnavailableField) {
      reports.push({
        id: rule.id,
        name: rule.name,
        evaluated: false,
        reason: 'body_not_loaded',
        actions: rule.actions,
      });
      continue;
    }
    const match = matchingRules([rule], message)[0];
    if (match) reports.push(match);
  }
  return reports;
}

async function matchedRulesSection(seed, scope, deps) {
  if (typeof deps?.loadInboxRules !== 'function') {
    return {
      available: false,
      reason: 'rules_loader_unavailable',
    };
  }
  try {
    const loaded = await deps.loadInboxRules({
      userId: scope.userId,
      accountId: seed.account_id,
      accountIds: scope.accountIds,
    });
    const rules = Array.isArray(loaded) ? loaded : loaded?.rows;
    return {
      available: true,
      rules: reportMatchingRules(rules, seed),
    };
  } catch (error) {
    return sectionError(error);
  }
}

export async function handleMarkTriaged(args, scope) {
  const ids = messageIdsArg(args);
  if (ids.error) return errorResult(ids.error);
  if (args.action !== undefined && typeof args.action !== 'string') {
    return errorResult('action must be a string');
  }
  if (args.note !== undefined && typeof args.note !== 'string') {
    return errorResult('note must be a string');
  }
  if (args.note?.length > 500) {
    return errorResult('note must be at most 500 characters');
  }

  const result = await markTriaged({
    userId: scope.userId,
    accountIds: scope.accountIds,
    messageIds: ids.value,
    action: args.action ?? null,
    note: args.note ?? null,
  });
  return jsonResult(result);
}

export async function handleTriageInbox(args, scope) {
  if (args.cursor !== undefined && typeof args.cursor !== 'string') {
    return errorResult('cursor must be a string');
  }
  if (
    args.categories !== undefined
    && (
      !Array.isArray(args.categories)
      || args.categories.some(category => typeof category !== 'string')
    )
  ) {
    return errorResult('categories must be an array of strings');
  }

  const since = dateArg(args, 'since');
  if (since.error) return errorResult(since.error);
  const account = await resolveAccountScope(args.account, scope.accountIds);
  if (account.error) return errorResult(account.error);

  const limit = triageLimit(args);
  const includeSignals = args.include_signals !== false;
  try {
    const [page, untriagedUnread] = await Promise.all([
      listTriageCandidates({
        accountIds: account.accountIds,
        cursor: args.cursor,
        limit,
        unreadOnly: args.unread_only !== false,
        includeTriaged: args.include_triaged === true,
        categories: args.categories,
        since: since.value,
      }),
      countUntriagedUnread(account.accountIds),
    ]);
    let signalState;
    if (!includeSignals) {
      signalState = {
        signals: [],
        available: false,
        reason: 'disabled',
        calibration: {},
      };
    } else if (limit > 25) {
      signalState = {
        signals: page.rows.map(() => emptySignals()),
        available: false,
        reason: 'limit_exceeds_25',
        calibration: {},
      };
    } else {
      signalState = await pageSignals(page.rows, account.accountIds);
    }

    const items = page.rows.map((row, index) => {
      const item = wireCandidate(row, includeSignals);
      if (includeSignals) {
        item.signals = signalState.signals[index] || emptySignals();
      }
      return item;
    });
    return jsonResult({
      items,
      cursor: page.cursor,
      has_more: page.hasMore,
      counts: {
        untriaged_unread: untriagedUnread,
        returned: items.length,
      },
      signals_available: signalState.available,
      signals_reason: signalState.reason,
      probe_calibration: signalState.calibration,
    });
  } catch (error) {
    if (error?.message === 'invalid triage cursor') {
      return errorResult(error.message);
    }
    throw error;
  }
}

export async function handleGetTriageContext(args, scope, deps = {}) {
  const seedId = args.message_id;
  if (!seedId || typeof seedId !== 'string') {
    return errorResult('message_id parameter is required');
  }

  let seed;
  try {
    seed = await getMessage(seedId, scope.accountIds);
  } catch (error) {
    const unavailable = {
      available: false,
      reason: 'seed_lookup_failed',
      detail: error?.message || String(error),
    };
    return jsonResult({
      message_id: seedId,
      thread: { ...unavailable },
      sender_history: { ...unavailable },
      similar: { ...unavailable },
      matched_rules: { ...unavailable },
    });
  }
  if (!seed) return errorResult('message not found');

  const [thread, senderHistoryResult, similar, matchedRules] = await Promise.all([
    threadSection(seed, scope.accountIds, contextLimit(args.thread_limit)),
    senderHistorySection(seed, scope.accountIds),
    similarSection(seedId, scope.accountIds, contextLimit(args.similar_limit)),
    matchedRulesSection(seed, scope, deps),
  ]);

  return jsonResult({
    message_id: seedId,
    thread,
    sender_history: senderHistoryResult,
    similar,
    matched_rules: matchedRules,
  });
}
