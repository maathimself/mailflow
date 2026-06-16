import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { applyInboxRules } from '../services/inboxRules.js';

const router = Router();
router.use(requireAuth);

const DESTINATION_ACTIONS = new Set(['move', 'archive', 'delete']);

// Fields where the condition value must be a non-empty string.
// has_attachment has no value; all others are string-match conditions.
const FIELDS_REQUIRING_VALUE = new Set(['from', 'to', 'subject', 'body', 'header']);

// Validates condition shapes. Returns an error string on the first problem,
// or null when all conditions are valid. Exported for unit testing.
export function validateConditions(conditions) {
  for (const cond of conditions) {
    if (!cond || typeof cond.field !== 'string') {
      return 'Each condition must have a valid field';
    }
    if (FIELDS_REQUIRING_VALUE.has(cond.field) && !String(cond.value || '').trim()) {
      return 'Condition value cannot be empty';
    }
    if (cond.field === 'header' && !String(cond.headerName || '').trim()) {
      return 'Header name is required for header conditions';
    }
  }
  return null;
}

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

router.post('/run', async (req, res) => {
  const imapMgr = req.app.get('imapManager');
  const { accountId } = req.body;

  let accountIds;
  try {
    if (accountId) {
      const owned = await query(
        'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
        [accountId, req.session.userId]
      );
      if (!owned.rows.length) return res.status(404).json({ error: 'Account not found' });
      accountIds = [accountId];
    } else {
      const accts = await query(
        'SELECT id FROM email_accounts WHERE user_id = $1',
        [req.session.userId]
      );
      accountIds = accts.rows.map(r => r.id);
    }
  } catch (err) {
    console.error('POST /rules/run account lookup error:', err.message);
    return res.status(500).json({ error: 'Failed to run rules' });
  }

  let processed = 0;
  let matched = 0;

  for (const acctId of accountIds) {
    try {
      const rulesCheck = await query(
        'SELECT COUNT(*) AS cnt FROM inbox_rules WHERE user_id = $1 AND enabled = true AND (account_id IS NULL OR account_id = $2)',
        [req.session.userId, acctId]
      );
      if (parseInt(rulesCheck.rows[0].cnt, 10) === 0) continue;

      const acctResult = await query(
        'SELECT id, user_id, folder_mappings FROM email_accounts WHERE id = $1',
        [acctId]
      );
      const account = acctResult.rows[0];
      if (!account) continue;

      const msgResult = await query(
        `SELECT id, uid, folder, from_email, from_name, to_addresses, subject, has_attachments, is_read
         FROM messages
         WHERE account_id = $1 AND lower(folder) = 'inbox'
         LIMIT 1000`,
        [acctId]
      );
      if (!msgResult.rows.length) continue;

      const messages = msgResult.rows.map(row => {
        let toArr = [];
        try {
          const raw = typeof row.to_addresses === 'string'
            ? JSON.parse(row.to_addresses)
            : row.to_addresses;
          if (Array.isArray(raw)) {
            toArr = raw.map(a => ({ email: a.address || a.email || '', name: a.name || '' }));
          }
        } catch {}
        return {
          id: row.id,
          uid: row.uid,
          folder: row.folder,
          fromEmail: row.from_email || '',
          fromName: row.from_name || '',
          to: toArr,
          subject: row.subject || '',
          hasAttachments: !!row.has_attachments,
          isRead: !!row.is_read,
          is_read: !!row.is_read,
          parsedHeaders: {},
        };
      });

      const before = messages.length;
      const { remaining } = await applyInboxRules(messages, account, imapMgr);
      processed += before;
      matched += before - remaining.length;
    } catch (err) {
      console.error(`POST /rules/run error for account ${acctId}:`, err.message);
    }
  }

  res.json({ processed, matched });
});

router.post('/', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError) return res.status(400).json({ error: conditionError });
  try {
    if (accountId) {
      const owned = await query(
        'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
        [accountId, req.session.userId]
      );
      if (!owned.rows.length) return res.status(403).json({ error: 'Account not found' });
    }
    // Strip move actions for all-account rules — a move needs a known account to
    // resolve folder paths. The UI enforces this but a direct API call could bypass it.
    const normalizedActions = normalizeActions(actions)
      .filter(a => accountId || a.type !== 'move');
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
  const conditionError = validateConditions(conditions);
  if (conditionError) return res.status(400).json({ error: conditionError });
  try {
    if (accountId) {
      const owned = await query(
        'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
        [accountId, req.session.userId]
      );
      if (!owned.rows.length) return res.status(403).json({ error: 'Account not found' });
    }
    const normalizedActions = normalizeActions(actions)
      .filter(a => accountId || a.type !== 'move');
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
