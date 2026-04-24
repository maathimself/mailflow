import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { q, accountId, limit = 50 } = req.query;
  if (!q || q.trim().length < 2) return res.json({ messages: [] });
  if (q.length > 500) return res.status(400).json({ error: 'Search query too long' });

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ messages: [] });

  const targetIds = accountId && userAccountIds.includes(accountId)
    ? [accountId]
    : userAccountIds;

  const result = await query(`
    SELECT
      m.id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
      m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
      a.name as account_name, a.email_address as account_email, a.color as account_color,
      ts_rank(
        to_tsvector('english', coalesce(m.subject,'') || ' ' || coalesce(m.from_name,'') || ' ' || coalesce(m.from_email,'') || ' ' || coalesce(m.snippet,'')),
        plainto_tsquery('english', $1)
      ) as rank
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.account_id = ANY($2)
      AND m.is_deleted = false
      AND to_tsvector('english', coalesce(m.subject,'') || ' ' || coalesce(m.from_name,'') || ' ' || coalesce(m.from_email,'') || ' ' || coalesce(m.snippet,''))
          @@ plainto_tsquery('english', $1)
    ORDER BY rank DESC, m.date DESC
    LIMIT $3
  `, [q.trim(), targetIds, Math.min(parseInt(limit) || 50, 200)]);

  res.json({ messages: result.rows, query: q });
});

export default router;
