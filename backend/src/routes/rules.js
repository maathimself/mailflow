import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const DESTINATION_ACTIONS = new Set(['move', 'archive', 'delete']);

// Strip duplicate destination actions (keeping the first) and trim move values.
// Silently drops malformed entries (null, non-object, missing/non-string type).
export function normalizeActions(actions) {
  let destSeen = false;
  return actions
    .filter(a => {
      if (!a || typeof a.type !== 'string') return false;
      if (DESTINATION_ACTIONS.has(a.type)) {
        if (destSeen) return false;
        destSeen = true;
      }
      return true;
    })
    .map(a => (a.type === 'move' && typeof a.value === 'string' ? { ...a, value: a.value.trim() } : a));
}

router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM inbox_rules WHERE user_id = $1 ORDER BY priority ASC, created_at ASC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /rules error:', err.message);
    res.status(500).json({ error: 'Failed to load rules' });
  }
});

router.post('/', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  try {
    if (accountId) {
      const owned = await query(
        'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
        [accountId, req.session.userId]
      );
      if (!owned.rows.length) return res.status(403).json({ error: 'Account not found' });
    }
    const normalizedActions = normalizeActions(actions);
    const moveAction = normalizedActions.find(a => a.type === 'move' && a.value?.trim());
    if (moveAction && accountId) {
      const folderResult = await query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
         FROM folders WHERE account_id = $1`,
        [accountId, moveAction.value.trim()]
      );
      const { total, match } = folderResult.rows[0];
      if (parseInt(total) > 0 && parseInt(match) === 0) {
        return res.status(400).json({ error: 'Move destination folder not found for this account' });
      }
    }
    const countResult = await query(
      'SELECT COUNT(*) AS cnt FROM inbox_rules WHERE user_id = $1',
      [req.session.userId]
    );
    const priority = parseInt(countResult.rows[0].cnt);
    const result = await query(
      `INSERT INTO inbox_rules
         (user_id, account_id, name, enabled, stop_processing, priority, condition_logic, conditions, actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.session.userId,
        accountId || null,
        name || '',
        enabled !== false,
        !!stopProcessing,
        priority,
        conditionLogic === 'OR' ? 'OR' : 'AND',
        JSON.stringify(conditions),
        JSON.stringify(normalizedActions),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /rules error:', err.message);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

router.put('/:id', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  try {
    if (accountId) {
      const owned = await query(
        'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
        [accountId, req.session.userId]
      );
      if (!owned.rows.length) return res.status(403).json({ error: 'Account not found' });
    }
    const normalizedActions = normalizeActions(actions);
    const moveAction = normalizedActions.find(a => a.type === 'move' && a.value?.trim());
    if (moveAction && accountId) {
      const folderResult = await query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE path = $2) AS match
         FROM folders WHERE account_id = $1`,
        [accountId, moveAction.value.trim()]
      );
      const { total, match } = folderResult.rows[0];
      if (parseInt(total) > 0 && parseInt(match) === 0) {
        return res.status(400).json({ error: 'Move destination folder not found for this account' });
      }
    }
    const result = await query(
      `UPDATE inbox_rules
       SET name = $1, account_id = $2, enabled = $3, stop_processing = $4,
           condition_logic = $5, conditions = $6, actions = $7, updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [
        name || '',
        accountId || null,
        enabled !== false,
        !!stopProcessing,
        conditionLogic === 'OR' ? 'OR' : 'AND',
        JSON.stringify(conditions),
        JSON.stringify(normalizedActions),
        req.params.id,
        req.session.userId,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /rules/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM inbox_rules WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.session.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /rules/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

router.patch('/reorder', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
  try {
    // Verify all ids belong to this user before updating
    const owned = await query(
      'SELECT id FROM inbox_rules WHERE id = ANY($1::uuid[]) AND user_id = $2',
      [ids, req.session.userId]
    );
    if (owned.rows.length !== ids.length) {
      return res.status(403).json({ error: 'One or more rules not found' });
    }
    for (let i = 0; i < ids.length; i++) {
      await query('UPDATE inbox_rules SET priority = $1 WHERE id = $2', [i, ids[i]]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /rules/reorder error:', err.message);
    res.status(500).json({ error: 'Failed to reorder rules' });
  }
});

export default router;
