import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { recordDb } from '../services/performanceMetrics.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveAccountScope } from '../services/unifiedInbox.js';

const RECENT_PREFIX_ROWS = 256;

const router = Router();
router.use(requireAuth);

// Simple in-memory rate limiter: 60 searches per minute per user. Typed search
// fires a debounced request per pause, so a user exploring several queries can
// legitimately issue dozens of requests in a minute.
const searchBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of searchBuckets) {
    if (now > b.resetAt) searchBuckets.delete(k);
  }
}, 60_000);

function searchLimiter(req, res, next) {
  const key = req.session.userId;
  const now = Date.now();
  const b = searchBuckets.get(key);
  if (!b || now > b.resetAt) {
    searchBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (b.count >= 60) {
    res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many search requests. Try again shortly.' });
  }
  b.count++;
  next();
}

// Parses a raw search string into structured operator filters and free-text
// terms. Supports from: to: subject: has: is: after: before: in:, quoted values
// (from:"John Smith"), and a leading '-' that negates either an operator
// (-from:smith) or a bare word (-invoice). Filters are a list (not a map) so
// repeated/negated operators like `from:a -from:b` are all preserved.
export function parseSearchQuery(raw) {
  const filters = [];
  const terms = [];

  // The leading (-?) captures optional negation. \b sits between an optional '-'
  // and the operator name, so both `from:` and `-from:` match.
  const opPattern = /(-?)\b(from|to|subject|has|is|after|before|in):("([^"]*)"|([\S]+))/gi;
  const remaining = raw.replace(opPattern, (_, neg, key, _v, quoted, unquoted) => {
    const k = key.toLowerCase();
    const v = (quoted !== undefined ? quoted : (unquoted || '')).toLowerCase().trim();
    if (v) filters.push({ key: k, value: v, negate: neg === '-' });
    return ' ';
  }).trim();

  for (const word of remaining.split(/\s+/)) {
    let w = word.trim();
    if (!w || w === '-') continue; // skip blanks and a lone '-' (nothing to negate)
    let negate = false;
    if (w[0] === '-' && w.length > 1) { negate = true; w = w.slice(1); }
    terms.push({ value: w, negate });
  }

  return { filters, terms };
}

// Wraps a positive condition so that when negated it also matches rows where the
// underlying columns are NULL (COALESCE(..., false) treats NULL as "not a match",
// which NOT then flips to a match — the intuitive meaning of exclusion).
function negateCond(sql) {
  return `NOT COALESCE((${sql}), false)`;
}

export function resolveSearchFolderScope(filters, folderParam = '') {
  let folderScope;
  let folderFuzzy = false; // in:<name> matches loosely; the folder param is exact

  for (const f of filters) {
    if (f.key !== 'in') continue;
    if (f.value === 'all') { folderScope = null; }
    else { folderScope = f.value; folderFuzzy = true; }
  }

  if (folderScope === undefined) {
    folderScope = (folderParam || '').trim() || null;
    folderFuzzy = false;
  }

  return { folderScope, folderFuzzy };
}

export function shouldExcludeTrashFromSearch(folderScope) {
  return folderScope === null;
}

export function trashFolderExclusionCondition() {
  return `NOT EXISTS (
        SELECT 1
        FROM folders f
        WHERE f.account_id = m.account_id
          AND f.path = m.folder
          AND (f.special_use = '\\Trash'
               OR lower(f.name) LIKE '%trash%'
               OR lower(f.name) LIKE '%deleted%')
      )`;
}

// Materialize body IDs separately: date-ordered scans must not re-tokenize every
// body while looking for a rare term. This uses the baseline idx_messages_body
// expression, so searches add no index-maintenance or migration cost.
export function freeTextTermCondition(likeIdx, ftsIdx, directBody = false) {
  return `(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR m.search_vector @@ plainto_tsquery('english', $${ftsIdx})
        OR ${directBody
          ? `CASE WHEN numnode(plainto_tsquery('english', $${ftsIdx})) > 0
              THEN to_tsvector('english', coalesce(m.body_text,'')) @@ plainto_tsquery('english', $${ftsIdx})
              ELSE false END`
          : `body_matches_${ftsIdx}.id IS NOT NULL`}
      )`;
}

router.get('/', searchLimiter, async (req, res) => {
  const { q, accountId, limit = 50, offset = 0 } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed) return res.json({ messages: [] });
  if (trimmed.length > 500) return res.status(400).json({ error: 'Search query too long' });

  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const { accountIds: targetIds } = resolveAccountScope(accountsResult.rows, accountId);
  if (!targetIds.length) return res.json({ messages: [] });

  const cap = Math.max(1, Math.min(parseInt(limit) || 50, 200));
  const { filters, terms } = parseSearchQuery(trimmed);
  const off = Math.max(0, parseInt(offset) || 0);
  const probe = off + cap <= RECENT_PREFIX_ROWS;

  const conditions = [];
  const textConditions = [];
  const directConditions = [];
  const bodyMatches = [];
  const bodyJoins = [];
  const params = [targetIds];
  let p = 2;

  // Folder scope. `in:` in the query wins; otherwise the client-supplied `folder`
  // param (the folder the user is currently viewing) applies. `undefined` means
  // no in: operator was given, so we fall back to the param below.
  //   folderScope === null   → search all folders
  //   folderScope === string → restrict to that folder

  // ── Operator filters ──────────────────────────────────────────────────────

  for (const f of filters) {
    // in: controls scope rather than adding a row condition; negation is
    // meaningless here so it's ignored.
    if (f.key === 'in') {
      continue;
    }

    let cond = null;

    if (f.key === 'from') {
      params.push(`%${f.value}%`);
      cond = `(m.from_email ILIKE $${p} OR m.from_name ILIKE $${p})`;
      p++;
    } else if (f.key === 'subject') {
      params.push(`%${f.value}%`);
      cond = `m.subject ILIKE $${p++}`;
    } else if (f.key === 'to') {
      // to: searches the to/cc address JSON — cast to text covers name and email
      params.push(`%${f.value}%`);
      cond = `(m.to_addresses::text ILIKE $${p} OR m.cc_addresses::text ILIKE $${p})`;
      p++;
    } else if (f.key === 'has') {
      if (f.value === 'attachment' || f.value === 'attachments') cond = `m.has_attachments = true`;
    } else if (f.key === 'is') {
      if (f.value === 'unread')  cond = `m.is_read = false`;
      else if (f.value === 'read')    cond = `m.is_read = true`;
      else if (f.value === 'starred') cond = `m.is_starred = true`;
    } else if (f.key === 'after') {
      const d = new Date(f.value);
      if (!isNaN(d)) { params.push(d.toISOString()); cond = `m.date >= $${p++}`; }
    } else if (f.key === 'before') {
      const d = new Date(f.value);
      if (!isNaN(d)) { params.push(d.toISOString()); cond = `m.date < $${p++}`; }
    }

    if (cond) conditions.push(f.negate ? negateCond(cond) : cond);
  }

  // ── Free-text terms ───────────────────────────────────────────────────────
  // Each term must match at least one of: from, subject (ILIKE — good for names
  // and partial words), or body content (FTS — good for large text with stemming).
  // AND between all terms: every word must appear somewhere in the email.
  // A negated term (-word) must appear nowhere.

  for (const term of terms.slice(0, 10)) {
    if (term.value.length < 2) continue; // single-char terms are too broad and expensive
    params.push(`%${term.value}%`); // ILIKE pattern
    const likeIdx = p++;

    params.push(term.value); // raw term for plainto_tsquery
    const ftsIdx = p++;

    // LEFT JOIN allows hash/merge joins (including disk spill) for large match
    // sets; an IN subplan can repeatedly scan them when they exceed work_mem.
    // Initialize the tsquery once. Keeping it as an InitPlan also prevents
    // common-term statistics from choosing a full body-tokenizing scan.
    bodyMatches.push(`body_matches_${ftsIdx} AS MATERIALIZED (
        SELECT id FROM messages
        WHERE account_id = ANY($1) AND is_deleted = false
          ${probe ? 'AND NOT (SELECT enough FROM recent_page)' : ''}
          AND numnode(plainto_tsquery('english', $${ftsIdx})) > 0
          AND to_tsvector('english', coalesce(body_text,'')) @@ (SELECT plainto_tsquery('english', $${ftsIdx}))
      )`);
    bodyJoins.push(`LEFT JOIN body_matches_${ftsIdx} ON body_matches_${ftsIdx}.id = m.id`);
    const cond = freeTextTermCondition(likeIdx, ftsIdx);
    textConditions.push(term.negate ? negateCond(cond) : cond);
    const direct = freeTextTermCondition(likeIdx, ftsIdx, true);
    directConditions.push(term.negate ? negateCond(direct) : direct);
  }

  // Require at least one real search condition before applying folder scope, so a
  // bare `in:inbox` (or a lone folder param) never dumps an entire folder.
  if (!conditions.length && !textConditions.length) return res.json({ messages: [], query: q });

  // Resolve folder scope: in: operator wins; otherwise use the param.
  const { folderScope, folderFuzzy } = resolveSearchFolderScope(filters, req.query.folder || '');
  if (folderScope) {
    if (folderFuzzy) {
      // in:<name> — case-insensitive match on a folder named exactly that, or a
      // nested folder whose path ends in it (in:sent → "Sent" or "Personal/Sent").
      // A multi-word leaf like "[Gmail]/Sent Mail" needs the quoted form in:"sent mail".
      params.push(folderScope);
      params.push(`%/${folderScope}`);
      conditions.push(`(m.folder ILIKE $${p} OR m.folder ILIKE $${p + 1})`);
      p += 2;
    } else {
      params.push(folderScope);
      conditions.push(`m.folder = $${p++}`);
    }
  } else if (shouldExcludeTrashFromSearch(folderScope)) {
    // Deleting moves mail into Trash, where it remains searchable by explicit
    // folder queries like in:trash. Keep ordinary all-folder searches from
    // resurfacing freshly-deleted messages after the optimistic UI guard expires.
    conditions.push(trashFolderExclusionCondition());
  }

  params.push(cap);
  params.push(off);

  const messageColumns = `m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
        m.to_addresses, m.cc_addresses, m.in_reply_to, m.thread_references,
        m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id`;
  const columns = `${messageColumns},
        a.name as account_name, a.email_address as account_email, a.color as account_color`;
  const scope = `m.account_id = ANY($1) AND m.is_deleted = false
        ${conditions.length ? `AND ${conditions.join('\n        AND ')}` : ''}`;
  const useProbe = bodyMatches.length > 0 && probe;
  // A complete page from a bounded newest prefix is also a complete page of
  // the full result. Otherwise use the indexed fallback, in the same snapshot.
  const recent = useProbe ? `recent_messages AS MATERIALIZED (
        SELECT ${messageColumns}, m.body_text, m.search_vector FROM messages m WHERE ${scope}
        ORDER BY m.date DESC LIMIT ${RECENT_PREFIX_ROWS}
      ), fast_matches AS MATERIALIZED (
        SELECT ${columns}
        FROM recent_messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE ${directConditions.join(' AND ')}
      ), recent_page AS MATERIALIZED (
        SELECT count(*) >= $${p}::bigint + $${p + 1}::bigint AS enough FROM fast_matches
      ), ` : '';

  try {
    const sql = `
      ${bodyMatches.length ? `WITH ${recent}${bodyMatches.join(',\n      ')}, matched_messages AS MATERIALIZED (` : ''}
      SELECT
        ${columns}
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      ${bodyJoins.join('\n      ')}
      WHERE ${scope}
        ${useProbe ? 'AND NOT (SELECT enough FROM recent_page)' : ''}
        ${textConditions.length ? `AND ${textConditions.join('\n        AND ')}` : ''}
      ${bodyMatches.length ? `) ${useProbe ? 'SELECT * FROM fast_matches WHERE (SELECT enough FROM recent_page) UNION ALL ' : ''}SELECT * FROM matched_messages${useProbe ? ' WHERE NOT (SELECT enough FROM recent_page)' : ''}` : ''}
      ORDER BY ${bodyMatches.length ? 'date' : 'm.date'} DESC
      LIMIT $${p} OFFSET $${p + 1}
    `;
    const result = bodyMatches.length ? await withTransaction(async client => {
      // Keep the body bitmap exact for large match sets without changing the
      // pooled session's defaults. work_mem is per operation, not per request.
      await client.query("SET LOCAL work_mem='16MB'");
      const start = process.hrtime.bigint();
      try { return await client.query(sql, params); }
      finally { recordDb(Number(process.hrtime.bigint() - start) / 1e6); }
    }) : await query(sql, params);

    res.json({ messages: result.rows, query: q });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Contact autocomplete — returns up to 10 addresses matching the query.
// Priority: addresses the user has sent to (contacts table, ranked by send_count)
// come first; inbound-only senders from messages fill remaining slots, with
// obvious bulk/no-reply addresses filtered out.
router.get('/contacts', searchLimiter, async (req, res) => {
  const { q } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed || trimmed.length < 2) return res.json({ contacts: [] });
  if (trimmed.length > 100) return res.status(400).json({ error: 'Query too long' });

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ contacts: [] });

  const pattern = `%${trimmed}%`;

  try {
    const result = await query(`
      WITH known AS (
        -- Contacts the user explicitly sent to or manually created (is_auto = false)
        SELECT primary_email AS email, display_name AS name, send_count, last_sent
        FROM contacts
        WHERE user_id = $1
          AND is_auto = false
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $2 OR primary_email ILIKE $2)
      ),
      auto AS (
        -- Auto-discovered inbound contacts not already in known
        SELECT primary_email AS email, display_name AS name, 0 AS send_count, last_sent
        FROM contacts
        WHERE user_id = $1
          AND is_auto = true
          AND primary_email IS NOT NULL
          AND (display_name ILIKE $2 OR primary_email ILIKE $2)
          AND lower(primary_email) NOT IN (SELECT lower(email) FROM known)
      ),
      inbound AS (
        -- Fallback: senders not yet in contacts table, excluding bulk/robot
        SELECT email, name, send_count, last_sent
        FROM (
          SELECT DISTINCT ON (from_email)
            from_email AS email,
            from_name  AS name,
            0          AS send_count,
            date       AS last_sent,
            is_bulk
          FROM messages
          WHERE account_id = ANY($3)
            AND is_deleted = false
            AND from_email IS NOT NULL AND from_email != ''
            AND (from_email ILIKE $2 OR from_name ILIKE $2)
            AND lower(from_email) NOT IN (
              SELECT lower(primary_email) FROM contacts WHERE user_id = $1 AND primary_email IS NOT NULL
            )
            AND from_email !~* '^(noreply|no-reply|donotreply|mailer-daemon|notifications?|bounce[^@]*)@'
          ORDER BY from_email, date DESC
        ) latest
        WHERE is_bulk IS NOT TRUE
      )
      SELECT email, name
      FROM (
        SELECT email, name, 1 AS priority, send_count, last_sent FROM known
        UNION ALL
        SELECT email, name, 2 AS priority, 0, last_sent FROM auto
        UNION ALL
        SELECT email, name, 3 AS priority, 0, last_sent FROM inbound
      ) combined
      ORDER BY priority, send_count DESC, last_sent DESC NULLS LAST
      LIMIT 10
    `, [req.session.userId, pattern, userAccountIds]);

    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('Contact suggest error:', err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

export default router;
