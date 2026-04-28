import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Parse "from:amazon subject:invoice hello world" into structured operators + free-text terms.
// Supports: from: to: subject: has: is: after: before:
// Quoted values: from:"John Smith"
function parseSearchQuery(raw) {
  const ops = {};
  const terms = [];

  const opPattern = /\b(from|to|subject|has|is|after|before):("([^"]*)"|([\S]+))/gi;
  const remaining = raw.replace(opPattern, (_, key, _v, quoted, unquoted) => {
    const k = key.toLowerCase();
    const v = (quoted !== undefined ? quoted : (unquoted || '')).toLowerCase().trim();
    if (v) ops[k] = v;
    return ' ';
  }).trim();

  for (const word of remaining.split(/\s+/)) {
    const w = word.trim();
    if (w) terms.push(w);
  }

  return { ops, terms };
}

router.get('/', async (req, res) => {
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

  const cap = Math.min(parseInt(limit) || 50, 200);
  const { ops, terms } = parseSearchQuery(trimmed);

  const conditions = [];
  const params = [targetIds];
  let p = 2;

  // ── Operator filters ──────────────────────────────────────────────────────

  if (ops.from) {
    params.push(`%${ops.from}%`);
    conditions.push(`(m.from_email ILIKE $${p} OR m.from_name ILIKE $${p})`);
    p++;
  }

  if (ops.subject) {
    params.push(`%${ops.subject}%`);
    conditions.push(`m.subject ILIKE $${p++}`);
  }

  // to: searches the to/cc address JSON — cast to text covers name and email fields
  if (ops.to) {
    params.push(`%${ops.to}%`);
    conditions.push(`(m.to_addresses::text ILIKE $${p} OR m.cc_addresses::text ILIKE $${p})`);
    p++;
  }

  if (ops.has === 'attachment' || ops.has === 'attachments') {
    conditions.push(`m.has_attachments = true`);
  }

  if (ops.is === 'unread')  conditions.push(`m.is_read = false`);
  if (ops.is === 'read')    conditions.push(`m.is_read = true`);
  if (ops.is === 'starred') conditions.push(`m.is_starred = true`);

  if (ops.after) {
    const d = new Date(ops.after);
    if (!isNaN(d)) { params.push(d.toISOString()); conditions.push(`m.date >= $${p++}`); }
  }
  if (ops.before) {
    const d = new Date(ops.before);
    if (!isNaN(d)) { params.push(d.toISOString()); conditions.push(`m.date < $${p++}`); }
  }

  // ── Free-text terms ───────────────────────────────────────────────────────
  // Each term must match at least one of: from, subject (ILIKE — good for names
  // and partial words), or body content (FTS — good for large text with stemming).
  // AND between all terms: every word must appear somewhere in the email.

  for (const term of terms.slice(0, 10)) {
    params.push(`%${term}%`); // ILIKE pattern
    const likeIdx = p++;

    params.push(term); // raw term for plainto_tsquery
    const ftsIdx = p++;

    conditions.push(`(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR to_tsvector('english', coalesce(m.subject,'') || ' ' || coalesce(m.from_name,'') || ' ' || coalesce(m.from_email,'') || ' ' || coalesce(m.snippet,''))
             @@ plainto_tsquery('english', $${ftsIdx})
        OR to_tsvector('english', coalesce(m.body_text,'')) @@ plainto_tsquery('english', $${ftsIdx})
      )`);
  }

  if (!conditions.length) return res.json({ messages: [], query: q });

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

export default router;
