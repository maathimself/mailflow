import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Simple in-memory rate limiter: 20 searches per minute per user.
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
  if (b.count >= 20) {
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

router.get('/', searchLimiter, async (req, res) => {
  const { q, accountId, limit = 50, offset = 0 } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed) return res.json({ messages: [] });
  if (trimmed.length > 500) return res.status(400).json({ error: 'Search query too long' });

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ messages: [] });

  const targetIds = accountId && userAccountIds.includes(accountId)
    ? [accountId] : userAccountIds;

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
  let folderScope;
  let folderFuzzy = false; // in:<name> matches loosely; the folder param is exact

  // ── Operator filters ──────────────────────────────────────────────────────

  for (const f of filters) {
    // in: controls scope rather than adding a row condition; negation is
    // meaningless here so it's ignored.
    if (f.key === 'in') {
      if (f.value === 'all') { folderScope = null; }
      else { folderScope = f.value; folderFuzzy = true; }
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

    const cond = `(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR m.search_vector @@ plainto_tsquery('english', $${ftsIdx})
        OR to_tsvector('english', coalesce(m.body_text,'')) @@ plainto_tsquery('english', $${ftsIdx})
      )`;
    conditions.push(term.negate ? negateCond(cond) : cond);
  }

  // Require at least one real search condition before applying folder scope, so a
  // bare `in:inbox` (or a lone folder param) never dumps an entire folder.
  if (!conditions.length) return res.json({ messages: [], query: q });

  // Resolve folder scope: in: operator already set it; otherwise use the param.
  if (folderScope === undefined) {
    folderScope = (req.query.folder || '').trim() || null;
    folderFuzzy = false;
  }
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
  }

  const off = Math.max(0, parseInt(offset) || 0);
  params.push(cap);
  params.push(off);

  try {
    const result = await query(`
      SELECT
        m.id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
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
