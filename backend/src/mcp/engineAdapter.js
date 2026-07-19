// The query.Engine port: all message/aggregate/deletion SQL lives here, scoped by
// accountIds, so MCP handlers never touch db.js (the no-SQL-in-handlers invariant).
// Row → msgvault-shape mappers pin the wire-casing split: MessageSummary/Detail carry
// snake_case json keys, but Address/AttachmentInfo/AccountInfo/AggregateRow/TotalStats
// have NO Go json tags → Go-default CAPITALIZED keys. D6: ids are UUID strings,
// conversation_id = thread_id.
import { query, withTransaction } from '../services/db.js';
import { buildOperatorClauses, freeTextTermClause, hasSearchableToken } from '../services/search/lexicalRepo.js';

const SUMMARY_COLUMNS = `
  m.id, m.account_id, m.message_id, m.thread_id, m.subject, m.snippet,
  m.from_email, m.from_name, m.to_addresses, m.cc_addresses, m.date,
  m.has_attachments, m.attachments, m.flags, m.folder`;

const DETAIL_COLUMNS = SUMMARY_COLUMNS + `, m.body_text, m.body_html`;

export function mapAddrs(jsonb) {
  return (jsonb || []).map((a) => ({ Email: a.email || '', Name: a.name || '' }));
}

// msgvault labels ≈ Gmail labels; Mailflow's closest analogue is the folder plus IMAP flags.
export function mapLabels(row) {
  const flags = Array.isArray(row.flags) ? row.flags : [];
  return [row.folder, ...flags].filter(Boolean);
}

function toISO(d) {
  return d instanceof Date ? d.toISOString() : (d || '');
}

export function rowToMessageSummary(row) {
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  const s = {
    id: row.id,
    source_id: row.account_id,
    source_message_id: row.message_id || '',
    conversation_id: row.thread_id || '',
    source_conversation_id: row.thread_id || '',
    subject: row.subject || '',
    snippet: row.snippet || '',
    from_email: row.from_email || '',
    from_name: row.from_name || '',
    sent_at: toISO(row.date),
    size_estimate: 0, // divergence: Mailflow stores no byte size
    has_attachments: !!row.has_attachments,
    attachment_count: atts.length,
    labels: mapLabels(row),
    message_type: 'email',
  };
  const to = mapAddrs(row.to_addresses);
  const cc = mapAddrs(row.cc_addresses);
  if (to.length) s.to = to;   // omitempty parity
  if (cc.length) s.cc = cc;
  return s;
}

function mapAttachments(atts) {
  return (Array.isArray(atts) ? atts : []).map((a, i) => ({
    ID: i, Filename: a.filename || '', MimeType: a.type || '', Size: a.size || 0,
    ContentHash: '', URL: '', StoragePath: '', // content tools are non-goals; synthetic index id
  }));
}

export function rowToMessageDetail(row) {
  const base = rowToMessageSummary(row);
  return {
    ...base,
    from: row.from_email ? [{ Email: row.from_email, Name: row.from_name || '' }] : [],
    to: mapAddrs(row.to_addresses),
    cc: mapAddrs(row.cc_addresses),
    bcc: [],
    body_text: row.body_text || '',
    body_html: row.body_html || '',
    attachments: mapAttachments(row.attachments),
  };
}

// Raw detail row (not yet mapped) for one message, scoped. Handlers map/page it.
export async function getMessage(id, accountIds) {
  if (!accountIds || !accountIds.length) return null;
  const { rows } = await query(
    `SELECT ${DETAIL_COLUMNS} FROM messages m WHERE m.id = $1 AND m.account_id = ANY($2)`,
    [id, accountIds],
  );
  return rows[0] || null;
}

export async function getMessageSummariesByIDs(ids, accountIds) {
  if (!ids || !ids.length) return [];
  const { rows } = await query(
    `SELECT ${SUMMARY_COLUMNS} FROM messages m WHERE m.id = ANY($1) AND m.account_id = ANY($2)`,
    [ids, accountIds],
  );
  const byId = new Map(rows.map((r) => [r.id, rowToMessageSummary(r)]));
  return ids.map((id) => byId.get(id)).filter(Boolean); // preserve input order
}

export async function getMessageBodiesByIDs(ids, accountIds) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const { rows } = await query(
    `SELECT m.id, m.body_text, m.body_html FROM messages m WHERE m.id = ANY($1) AND m.account_id = ANY($2)`,
    [ids, accountIds],
  );
  for (const r of rows) out.set(r.id, { body_text: r.body_text, body_html: r.body_html });
  return out;
}

export async function listAccounts(accountIds) {
  if (!accountIds || !accountIds.length) return [];
  const { rows } = await query(
    `SELECT id, protocol, email_address, name FROM email_accounts WHERE id = ANY($1) ORDER BY sort_order`,
    [accountIds],
  );
  return rows.map((a) => ({ ID: a.id, SourceType: a.protocol || 'imap', Identifier: a.email_address, DisplayName: a.name || '' }));
}

// Resolve an optional `account` email to a single scoped id (msgvault getAccountID).
// Returns { accountIds } narrowed to the match, or { error } when unknown (msgvault
// errors rather than silently widening). Empty account = no narrowing (all of the
// token's accounts). Shared by the search AND message/aggregate/deletion handlers so
// the `account` argument narrows scope everywhere it is advertised.
export async function resolveAccountScope(account, accountIds) {
  if (!account) return { accountIds };
  const accounts = await listAccounts(accountIds);
  const match = accounts.find((a) => a.Identifier === account);
  if (!match) return { error: `account not found: ${account}` };
  return { accountIds: [match.ID] };
}

// Cheap owner-scope membership check for a single message id (find_similar seed).
export async function messageInScope(id, accountIds) {
  if (!accountIds || !accountIds.length) return false;
  const { rows } = await query('SELECT 1 FROM messages WHERE id = $1 AND account_id = ANY($2) LIMIT 1', [id, accountIds]);
  return rows.length > 0;
}

// Port of msgvault getDateArg (internal/mcp/handlers.go): structured after/before
// tool args are strict YYYY-MM-DD (the format every tool schema advertises). An
// unparseable value throws msgvault's exact error message instead of surfacing a
// raw Postgres timestamptz cast failure; a valid one binds as midnight UTC — the
// same instant lexicalRepo's buildOperatorClauses gives query-string dates — so
// structured args and before:/after: operators sit on one clock. Callers apply
// `before` EXCLUSIVELY (<): msgvault uses < and lexicalRepo already does; the
// list/aggregate/domain paths here had drifted to <=.
function parseDateArg(key, value) {
  if (!value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  // Round-trip guard: Date.parse ROLLS an out-of-range day over ("2025-02-31"
  // → Mar 2) instead of rejecting it; msgvault's time.Parse rejects.
  if (!d || isNaN(d) || !d.toISOString().startsWith(value)) {
    throw new Error(`invalid ${key} date "${value}": expected YYYY-MM-DD`);
  }
  return d.toISOString();
}

// Shared by every structured-arg path below: validate both bounds up front,
// then push the >= / < clauses through the caller's bind.
function pushDateClauses(where, bind, after, before) {
  const afterISO = parseDateArg('after', after);
  const beforeISO = parseDateArg('before', before);
  if (afterISO) where.push(`m.date >= ${bind(afterISO)}`);
  if (beforeISO) where.push(`m.date < ${bind(beforeISO)}`);
}

// Newest-first message list, scoped and filtered. Returns MessageSummary[] (mapped
// here so the handler only pages). `from` filters from_email when it looks like an
// address, else from_name (msgvault list_messages semantics).
export async function listMessages({ accountIds, from, to, label, hasAttachment, after, before, conversationId, limit, offset }) {
  if (!accountIds || !accountIds.length) return [];
  const args = [accountIds];
  const where = ['m.account_id = ANY($1)', 'm.is_deleted = false'];
  const bind = (v) => { args.push(v); return `$${args.length}`; };

  if (from) {
    where.push(from.includes('@')
      ? `m.from_email ILIKE ${bind('%' + from + '%')}`
      : `m.from_name ILIKE ${bind('%' + from + '%')}`);
  }
  if (to) where.push(`m.to_addresses::text ILIKE ${bind('%' + to + '%')}`);
  if (label) where.push(`(m.folder = ${bind(label)} OR m.flags @> ${bind(JSON.stringify([label]))}::jsonb)`);
  if (hasAttachment) where.push('m.has_attachments = true');
  pushDateClauses(where, bind, after, before);
  if (conversationId) where.push(`m.thread_id = ${bind(conversationId)}`);

  const sql = `SELECT ${SUMMARY_COLUMNS} FROM messages m WHERE ${where.join(' AND ')}
    ORDER BY m.date DESC NULLS LAST LIMIT ${bind(limit)} OFFSET ${bind(offset)}`;
  const { rows } = await query(sql, args);
  return rows.map(rowToMessageSummary);
}

const MAX_STAGE_DELETION = 100000; // msgvault maxStageDeletionResults

// A free-text term contributes a staging predicate only when it is positive,
// ≥2 chars, and carries a searchable token — the same hygiene the lexical and
// semantic paths apply. Negated terms are deliberately NOT enforced on the
// staging path (unlike lexical search's FTS exclusion), so a negation-only
// query yields zero predicates; countEnforceableQueryPredicates below is what
// lets the handler refuse that rather than stage every live message.
function usablePositiveTerm(t) {
  return !t.negate && t.value.length >= 2 && hasSearchableToken(t.value);
}

// Count the enforceable row predicates a parsed query would contribute to a
// staging WHERE: supported structured filters (buildOperatorClauses; in:/
// unsupported operators contribute nothing) plus usable positive free-text
// terms. Mirrors resolveStageDeletionIds' predicate construction exactly (same
// builder, same term hygiene) so the two can never disagree about whether a
// query is enforceable. Zero here means the WHERE would carry only account +
// liveness — i.e. the query would soft-delete the whole (capped) mailbox — so
// the stage_deletion handler refuses it. This is the final safety net, reached
// only for queries that carry no unsupported operator yet still yield no
// predicate (e.g. all stopwords or punctuation): the handler already rejects any
// unsupported operator up front via unsupportedSearchOperatorMessage (msgvault
// parity, internal/mcp/handlers.go — so a mixed query like `invoice
// label:promotions` is refused, not silently widened to every "invoice" match).
export function countEnforceableQueryPredicates(parsed) {
  if (!parsed) return 0;
  let n = buildOperatorClauses(parsed.filters, () => '$0').length;
  for (const t of parsed.terms || []) if (usablePositiveTerm(t)) n++;
  return n;
}

// Resolve candidate message ids for staging, scoped to accountIds. Query path builds
// its free-text predicates from lexicalRepo's freeTextTermClause — the EXACT builder
// the search path uses (ranked search_fts match + un-backfilled fallback + stopword
// vacuity) — so the search preview and the staged set can never diverge: `the invoice`
// stages the invoice matches the preview showed, not the zero rows the legacy
// ILIKE/plainto fork produced once "the" normalized to an empty tsquery. Structured
// operators share buildOperatorClauses the same way; the structured-filter path
// builds from the discrete filter args.
async function resolveStageDeletionIds({ accountIds, parsed, from, domain, label, hasAttachment, after, before }) {
  const params = [accountIds];
  const where = ['m.account_id = ANY($1)', 'm.is_deleted = false'];
  const bind = (v) => { params.push(v); return `$${params.length}`; };

  if (parsed) {
    for (const cond of buildOperatorClauses(parsed.filters, bind)) where.push(cond);
    for (const t of parsed.terms || []) {
      if (!usablePositiveTerm(t)) continue;
      where.push(freeTextTermClause(t.value, false, bind));
    }
  } else {
    if (from) { const p = bind('%' + from + '%'); where.push(`(m.from_email ILIKE ${p} OR m.from_name ILIKE ${p})`); }
    if (domain) where.push(`m.from_email ILIKE ${bind('%@' + domain)}`);
    if (label) where.push(`(m.folder = ${bind(label)} OR m.flags @> ${bind(JSON.stringify([label]))}::jsonb)`);
    if (hasAttachment) where.push('m.has_attachments = true');
    pushDateClauses(where, bind, after, before);
  }

  const sql = `SELECT m.id FROM messages m WHERE ${where.join(' AND ')} LIMIT ${bind(MAX_STAGE_DELETION)}`;
  const { rows } = await query(sql, params);
  return rows.map((r) => r.id);
}

// Record a STAGED batch + its members scoped to the token user. NEVER flips
// is_deleted — execution is a separate, session-authed step.
export async function stageDeletion(opts) {
  const ids = await resolveStageDeletionIds(opts);
  if (!ids.length) return { batchId: null, messageCount: 0 };
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO mcp_deletion_batches (user_id, description, status, message_count) VALUES ($1, $2, 'staged', $3) RETURNING id",
      [opts.userId, opts.description || '', ids.length],
    );
    const batchId = rows[0].id;
    await client.query(
      'INSERT INTO mcp_deletion_batch_messages (batch_id, message_id) SELECT $1, unnest($2::uuid[])',
      [batchId, ids],
    );
    return { batchId, messageCount: ids.length };
  });
}

// Session-authed soft-delete of a STAGED batch, scoped to the owner's accounts.
// Returns the updated row count, or null when the batch is absent/not owned/not staged.
export async function executeDeletionBatch(batchId, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id FROM mcp_deletion_batches WHERE id = $1 AND user_id = $2 AND status = 'staged' FOR UPDATE",
      [batchId, userId],
    );
    if (!rows.length) return null;
    const upd = await client.query(
      `UPDATE messages SET is_deleted = true
        WHERE id IN (SELECT message_id FROM mcp_deletion_batch_messages WHERE batch_id = $1)
          AND account_id IN (SELECT id FROM email_accounts WHERE user_id = $2)`,
      [batchId, userId],
    );
    await client.query(
      "UPDATE mcp_deletion_batches SET status = 'executed', executed_at = NOW() WHERE id = $1",
      [batchId],
    );
    return upd.rowCount;
  });
}

// Discard a staged batch (owner-scoped). Cascades member rows; never touches messages.
export async function unstageDeletionBatch(batchId, userId) {
  const { rowCount } = await query(
    'DELETE FROM mcp_deletion_batches WHERE id = $1 AND user_id = $2',
    [batchId, userId],
  );
  return rowCount > 0;
}

// Archive overview scoped to accountIds. TotalStats has NO Go json tags → CAPITALIZED
// keys. TotalSize is a body-byte proxy and AttachmentSize is 0 (Mailflow stores no
// byte sizes — documented divergence).
export async function getTotalStats(accountIds) {
  const empty = {
    MessageCount: 0, ActiveMessageCount: 0, SourceDeletedMessageCount: 0,
    TotalSize: 0, AttachmentCount: 0, AttachmentSize: 0, LabelCount: 0,
    AccountCount: (accountIds && accountIds.length) || 0,
  };
  if (!accountIds || !accountIds.length) return empty;
  const { rows } = await query(
    `SELECT
       COUNT(*)::bigint AS message_count,
       COUNT(*) FILTER (WHERE is_deleted = false)::bigint AS active_count,
       COUNT(*) FILTER (WHERE is_deleted = true)::bigint AS deleted_count,
       COALESCE(SUM(octet_length(COALESCE(body_text, ''))), 0)::bigint AS total_size,
       COALESCE(SUM(jsonb_array_length(COALESCE(attachments, '[]'::jsonb))), 0)::bigint AS attachment_count,
       COUNT(DISTINCT folder)::bigint AS label_count
     FROM messages WHERE account_id = ANY($1)`,
    [accountIds],
  );
  const r = rows[0] || {};
  return {
    MessageCount: Number(r.message_count || 0),
    ActiveMessageCount: Number(r.active_count || 0),
    SourceDeletedMessageCount: Number(r.deleted_count || 0),
    TotalSize: Number(r.total_size || 0),
    AttachmentCount: Number(r.attachment_count || 0),
    AttachmentSize: 0,
    LabelCount: Number(r.label_count || 0),
    AccountCount: accountIds.length,
  };
}

// group_by → grouping SQL. `recipient` needs a lateral unnest of to_addresses;
// the rest are scalar expressions over messages. `time` buckets by calendar year.
const AGG_KEY_EXPR = {
  sender: 'm.from_email',
  domain: "split_part(m.from_email, '@', 2)",
  label: 'm.folder',
  time: "to_char(m.date, 'YYYY')",
};

// Grouped statistics (top senders/recipients/domains/labels, or volume by year).
// Returns AggregateRow[] — capitalized keys (no Go json tags). AttachmentSize is 0
// (Mailflow stores no per-attachment byte totals — documented divergence).
export async function aggregate(groupBy, { accountIds, after, before, limit }) {
  if (!accountIds || !accountIds.length) return [];
  const args = [accountIds];
  const where = ['m.account_id = ANY($1)', 'm.is_deleted = false'];
  const bind = (v) => { args.push(v); return `$${args.length}`; };
  pushDateClauses(where, bind, after, before);

  const measures = `
    COUNT(*)::bigint AS count,
    COALESCE(SUM(octet_length(COALESCE(m.body_text, ''))), 0)::bigint AS total_size,
    COALESCE(SUM(jsonb_array_length(COALESCE(m.attachments, '[]'::jsonb))), 0)::bigint AS attachment_count,
    COUNT(*) OVER ()::bigint AS total_unique`;

  let sql;
  if (groupBy === 'recipient') {
    sql = `SELECT (ra->>'email') AS key, ${measures}
      FROM messages m, LATERAL jsonb_array_elements(COALESCE(m.to_addresses, '[]'::jsonb)) AS ra
      WHERE ${where.join(' AND ')}
      GROUP BY key ORDER BY count DESC LIMIT ${bind(limit)}`;
  } else {
    const expr = AGG_KEY_EXPR[groupBy];
    sql = `SELECT ${expr} AS key, ${measures}
      FROM messages m
      WHERE ${where.join(' AND ')}
      GROUP BY key ORDER BY count DESC LIMIT ${bind(limit)}`;
  }
  const { rows } = await query(sql, args);
  return rows.map((r) => ({
    Key: r.key == null ? '' : String(r.key),
    Count: Number(r.count || 0),
    TotalSize: Number(r.total_size || 0),
    AttachmentSize: 0,
    AttachmentCount: Number(r.attachment_count || 0),
    TotalUnique: Number(r.total_unique || 0),
  }));
}

// Messages where any participant (from/to/cc) belongs to one of the domains.
// Returns MessageSummary[], newest-first, scoped to accountIds.
export async function searchByDomains(domains, after, before, limit, offset, accountIds) {
  if (!accountIds || !accountIds.length || !domains.length) return [];
  const args = [accountIds];
  const where = ['m.account_id = ANY($1)', 'm.is_deleted = false'];
  const bind = (v) => { args.push(v); return `$${args.length}`; };

  const domainConds = domains.map((d) => {
    const from = bind('%@' + d);
    const to = bind('%' + d + '%');
    const cc = bind('%' + d + '%');
    return `(m.from_email ILIKE ${from} OR m.to_addresses::text ILIKE ${to} OR m.cc_addresses::text ILIKE ${cc})`;
  });
  where.push('(' + domainConds.join(' OR ') + ')');
  pushDateClauses(where, bind, after, before);

  const sql = `SELECT ${SUMMARY_COLUMNS} FROM messages m WHERE ${where.join(' AND ')}
    ORDER BY m.date DESC NULLS LAST LIMIT ${bind(limit)} OFFSET ${bind(offset)}`;
  const { rows } = await query(sql, args);
  return rows.map(rowToMessageSummary);
}
