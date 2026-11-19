import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveAccountScope } from '../services/unifiedInbox.js';
import { gmailServerMatches } from '../services/gmailServerSearch.js';
import { draftMessageSql } from '../utils/mailUtils.js';

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

// A user's API tokens share one bucket of their own, so a tool cannot spend the searches the
// person is typing in the browser, and many tokens do not add up to many budgets.
function searchLimiter(req, res, next) {
  const key = req.apiToken ? `tokens:${req.session.userId}` : req.session.userId;
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

// Postgres refuses to build a tsvector larger than ~1MB of packed lexemes
// (SQLSTATE 54000), so an oversized body would 500 the whole search. Cap the
// text fed to to_tsvector at 600k chars — matching msgvault's maxFTSBodyChars
// (internal/store/dialect_pg.go) — so one huge email can't crash the query.
// mf_html_to_text (migration 0080) caps message_search.body_text the same way.
export const FTS_BODY_CHAR_CAP = 600000;

// The body text search reads: body_text, or for a message sent only as HTML, the text
// migration 0080 keeps in message_search. Without it only the 200-character snippet of
// an HTML-only body was searchable (D#320).
export const SEARCH_BODY_SQL = `coalesce(m.body_text,
          (SELECT ms.body_text FROM message_search ms WHERE ms.message_id = m.id), '')`;

// Builds the per-term free-text OR-condition: a term matches if it appears in
// the sender, the subject, the stored search_vector, or the length-capped body.
// Extracted so the body cap is a single, testable source of truth.
export function freeTextTermCondition(likeIdx, ftsIdx) {
  return `(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR m.search_vector @@ plainto_tsquery('english', $${ftsIdx})
        OR CASE WHEN numnode(plainto_tsquery('english', $${ftsIdx})) > 0
          THEN to_tsvector('english', LEFT(${SEARCH_BODY_SQL}, ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('english', $${ftsIdx})
          ELSE to_tsvector('simple', LEFT(${SEARCH_BODY_SQL}, ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('simple', $${ftsIdx})
        END
      )`;
}

router.get('/', searchLimiter, async (req, res) => {
  const { q, accountId, limit = 50, offset = 0, threaded } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed) return res.json({ messages: [] });
  if (trimmed.length > 500) return res.status(400).json({ error: 'Search query too long' });

  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox, imap_host FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const { accountIds: targetIds } = resolveAccountScope(accountsResult.rows, accountId);
  if (!targetIds.length) return res.json({ messages: [] });

  const cap = Math.max(1, Math.min(parseInt(limit) || 50, 200));
  const { filters, terms } = parseSearchQuery(trimmed);

  const conditions = [];
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

  const positiveTextConds = [];
  const positiveTerms = [];
  for (const term of terms.slice(0, 10)) {
    if (term.value.length < 2) continue; // single-char terms are too broad and expensive
    params.push(`%${term.value}%`); // ILIKE pattern
    const likeIdx = p++;

    params.push(term.value); // raw term for plainto_tsquery
    const ftsIdx = p++;

    const cond = freeTextTermCondition(likeIdx, ftsIdx);
    if (term.negate) conditions.push(negateCond(cond));
    else { positiveTextConds.push(cond); positiveTerms.push(term.value); }
  }

  // A Gmail body MailFlow never downloaded is searched on Gmail's side (D#320): a message Gmail
  // reports for the positive terms satisfies them as a group. Every other condition, including
  // -word exclusions, still applies here.
  if (positiveTextConds.length) {
    let textCond = positiveTextConds.join('\n        AND ');
    const gmail = await gmailServerMatches(
      accountsResult.rows.filter(account => targetIds.includes(account.id)),
      positiveTerms,
      { loadAccounts: async ids => (await query('SELECT * FROM email_accounts WHERE id = ANY($1)', [ids])).rows },
    );
    if (gmail) {
      params.push(gmail.accountIds, gmail.providerIds, gmail.messageIds);
      textCond = `((${textCond})
        OR (m.account_id = ANY($${p}) AND (m.provider_msgid = ANY($${p + 1}) OR m.message_id = ANY($${p + 2}))))`;
      p += 3;
    }
    conditions.push(textCond);
  }

  // Require at least one real search condition before applying folder scope, so a
  // bare `in:inbox` (or a lone folder param) never dumps an entire folder.
  if (!conditions.length) return res.json({ messages: [], query: q });

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

  const off = Math.max(0, parseInt(offset) || 0);
  params.push(cap);
  params.push(off);
  const isThreaded = threaded === 'true' || threaded === true;

  try {
    if (isThreaded) {
      const result = await query(`
        WITH matched AS (
          SELECT
            m.id, m.uid, m.folder, m.message_id, m.thread_key AS thread_id,
            m.subject, m.from_name, m.from_email,
            m.to_addresses, m.cc_addresses, m.reply_to, m.delivery_addresses,
            m.in_reply_to, m.thread_references,
            m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
            a.name AS account_name, a.email_address AS account_email, a.color AS account_color,
            (co.id IS NOT NULL) AS has_contact_photo,
            ${draftMessageSql('m')} AS is_draft
          FROM messages m
          JOIN email_accounts a ON m.account_id = a.id
          LEFT JOIN contacts co ON co.user_id = a.user_id
                                AND co.primary_email = lower(m.from_email)
                                AND co.photo_data IS NOT NULL
          WHERE m.account_id = ANY($1)
            AND m.is_deleted = false
            AND ${conditions.join('\n            AND ')}
        ),
        paged_threads AS (
          SELECT thread_id,
                 ROW_NUMBER() OVER (ORDER BY COALESCE(MAX(date) FILTER (WHERE NOT is_draft), MAX(date)) DESC, thread_id) AS pos
          FROM matched
          GROUP BY thread_id
          ORDER BY COALESCE(MAX(date) FILTER (WHERE NOT is_draft), MAX(date)) DESC, thread_id
          LIMIT $${p} OFFSET $${p + 1}
        ),
        deduped AS (
          SELECT DISTINCT ON (account_id, thread_id, COALESCE(message_id, id::text))
                 id, uid, folder, message_id, thread_id,
                 subject, from_name, from_email,
                 to_addresses, cc_addresses, reply_to, delivery_addresses,
                 in_reply_to, thread_references,
                 date, snippet, is_read, is_starred, has_attachments, account_id,
                 account_name, account_email, account_color, has_contact_photo, is_draft
          FROM matched
          WHERE thread_id IN (SELECT thread_id FROM paged_threads)
          ORDER BY account_id,
                   thread_id,
                   COALESCE(message_id, id::text),
                   CASE WHEN is_draft THEN 2 WHEN folder = 'INBOX' THEN 0 ELSE 1 END,
                   date ASC
        ),
        thread_totals AS (
          SELECT m.thread_key AS thread_id,
                 COUNT(DISTINCT (m.account_id, m.message_id))::int AS message_count
          FROM messages m
          WHERE m.account_id = ANY($1)
            AND m.is_deleted = false
            AND m.message_id IS NOT NULL
            AND NOT ${draftMessageSql('m')}
            AND m.thread_key IN (SELECT thread_id FROM paged_threads)
          GROUP BY m.thread_key
        ),
        ranked AS (
          SELECT d.*,
                 COALESCE(tt.message_count, 1) AS message_count,
                 COUNT(*) FILTER (WHERE NOT d.is_read AND (NOT d.is_draft OR tt.message_count IS NULL)) OVER (PARTITION BY d.thread_id)::int AS unread_count,
                 FIRST_VALUE(d.subject)           OVER (PARTITION BY d.thread_id ORDER BY d.is_draft ASC, d.date ASC, d.id ASC) AS thread_subject,
                 FIRST_VALUE(d.from_name)         OVER (PARTITION BY d.thread_id ORDER BY d.is_draft ASC, d.date ASC, d.id ASC) AS thread_from_name,
                 FIRST_VALUE(d.from_email)        OVER (PARTITION BY d.thread_id ORDER BY d.is_draft ASC, d.date ASC, d.id ASC) AS thread_from_email,
                 FIRST_VALUE(d.has_contact_photo) OVER (PARTITION BY d.thread_id ORDER BY d.is_draft ASC, d.date ASC, d.id ASC) AS thread_has_contact_photo,
                 FIRST_VALUE(d.to_addresses)      OVER (PARTITION BY d.thread_id ORDER BY d.is_draft ASC, d.date ASC, d.id ASC) AS thread_to_addresses,
                 FIRST_VALUE(d.folder)            OVER (PARTITION BY d.thread_id ORDER BY d.is_draft ASC, d.date ASC, d.id ASC) AS thread_folder,
                 ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.is_draft ASC, d.date DESC, d.is_read ASC, d.id) AS rn
          FROM deduped d
          LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
        )
        SELECT id, uid, folder, message_id, thread_id, thread_subject AS subject,
               thread_from_name AS from_name, thread_from_email AS from_email,
               from_name AS reply_from_name, from_email AS reply_from_email, subject AS reply_subject,
               thread_to_addresses, thread_folder,
               to_addresses, cc_addresses, reply_to, delivery_addresses, in_reply_to, thread_references,
               date, snippet, is_starred, is_read, has_attachments, account_id,
               account_name, account_email, account_color,
               message_count, unread_count,
               thread_has_contact_photo AS has_contact_photo
        FROM ranked
        JOIN paged_threads pt USING (thread_id)
        WHERE rn = 1
        ORDER BY pt.pos
      `, params);

      return res.json({ messages: result.rows, query: q, threaded: true });
    }

    const result = await query(`
      SELECT
        m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
        m.to_addresses, m.cc_addresses, m.reply_to, m.delivery_addresses, m.thread_id,
        m.in_reply_to, m.thread_references,
        m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
        a.name as account_name, a.email_address as account_email, a.color as account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.account_id = ANY($1)
        AND m.is_deleted = false
        AND ${conditions.join('\n        AND ')}
      ORDER BY m.date DESC
      LIMIT $${p} OFFSET $${p + 1}
    `, params);

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
