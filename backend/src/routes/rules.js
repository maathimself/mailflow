import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { applyInboxRules, isDangerousRegex, RULE_CATEGORIES } from '../services/inboxRules.js';

const router = Router();
router.use(requireAuth);

const DESTINATION_ACTIONS = new Set(['move', 'archive', 'delete']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

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
    if (cond.field === 'read_status' && !['read', 'unread'].includes(String(cond.value))) {
      return 'Read status condition must be "read" or "unread"';
    }
    if (cond.operator === 'regex' && isDangerousRegex(String(cond.value || ''))) {
      return 'Regex pattern is invalid or too complex (possible catastrophic backtracking)';
    }
  }
  return null;
}

export function validateActions(actions) {
  for (const action of actions) {
    if (action.type === 'set_category' && !RULE_CATEGORIES.has(action.value)) {
      return 'Set category action requires one of: primary, newsletter, promotion, automated, social';
    }
    if (action.type !== 'forward') continue;
    const value = typeof action.value === 'string' ? action.value.trim() : '';
    if (!FORWARD_EMAIL_RE.test(value) || /[\r\n\0]/.test(value)) {
      return 'Forward action requires one valid email address';
    }
  }
  return null;
}

// Strip duplicate destination and forward actions (keeping the first) and trim
// move and forward values.
// Silently drops malformed entries (null, non-object, missing/non-string type).
export function normalizeActions(actions) {
  let destSeen = false;
  let forwardSeen = false;
  let categorySeen = false;
  return actions
    .filter(a => {
      if (!a || typeof a.type !== 'string') return false;
      if (DESTINATION_ACTIONS.has(a.type)) {
        if (destSeen) return false;
        destSeen = true;
      }
      if (a.type === 'forward') {
        if (forwardSeen) return false;
        forwardSeen = true;
      }
      // A message has one category, so a rule sets at most one.
      if (a.type === 'set_category') {
        if (categorySeen) return false;
        categorySeen = true;
      }
      return true;
    })
    .map(a => (
      ['move', 'forward'].includes(a.type) && typeof a.value === 'string'
        ? { ...a, value: a.value.trim() }
        : a
    ));
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

  // The sweep can take minutes on a large mailbox — well past any proxy
  // timeout, which used to surface as a 504 while the run kept going
  // server-side. Respond immediately and run in the background; the
  // rules_run_complete WebSocket event delivers the result. One run per user
  // at a time.
  const userId = req.session.userId;
  if (runInFlight.has(userId)) return res.status(409).json({ error: 'Rules are already running' });
  runInFlight.add(userId);
  res.status(202).json({ ok: true, started: true });

  (async () => {
    try {
      const { processed, matched } = await runRulesSweep(userId, accountIds, imapMgr);
      imapMgr?.broadcast?.({ type: 'rules_run_complete', ok: true, processed, matched }, userId);
    } catch (err) {
      console.error('POST /rules/run sweep error:', err.message);
      imapMgr?.broadcast?.({ type: 'rules_run_complete', ok: false }, userId);
    } finally {
      runInFlight.delete(userId);
    }
  })();
});

// "Always for this sender / domain" from a message's Categorize menu (#490). Saves the choice as an
// ordinary all-account rule (From equals the address, or ends with @domain, then set_category) so
// it shows and is edited in the rules list, and applies the category to that sender's existing
// INBOX mail directly. It does not run the user's other rules over the backlog, as POST /run would.
// A rule this created earlier for the same sender is updated rather than duplicated.
router.post('/sender-category', async (req, res) => {
  const { messageId, scope, category, name } = req.body || {};
  if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });
  if (scope !== 'sender' && scope !== 'domain') return res.status(400).json({ error: 'scope must be sender or domain' });
  if (!RULE_CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid category' });
  const userId = req.session.userId;
  try {
    const msgResult = await query(
      `SELECT m.from_email FROM messages m JOIN email_accounts a ON a.id = m.account_id
       WHERE m.id = $1 AND a.user_id = $2`,
      [messageId, userId]
    );
    if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found' });
    const email = String(msgResult.rows[0].from_email || '').trim().toLowerCase();
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1 || /\s/.test(email)) {
      return res.status(422).json({ error: 'This message has no sender address to match' });
    }
    const condition = scope === 'sender'
      ? { field: 'from', operator: 'equals', value: email }
      : { field: 'from', operator: 'ends_with', value: email.slice(at) };
    const actions = [{ type: 'set_category', value: category }];
    const ruleName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : `${condition.value} → ${category}`;

    // The same all-account sender rule, made here before: one From condition, only set_category.
    const existing = await query(
      `SELECT id FROM inbox_rules
       WHERE user_id = $1 AND account_id IS NULL
         AND conditions = $2::jsonb
         AND jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) = 1
         AND actions->0->>'type' = 'set_category'
       ORDER BY priority ASC LIMIT 1`,
      [userId, JSON.stringify([condition])]
    );
    let ruleId;
    let created = false;
    if (existing.rows.length) {
      ruleId = existing.rows[0].id;
      await query(
        'UPDATE inbox_rules SET actions = $1, name = $2, enabled = true, updated_at = NOW() WHERE id = $3 AND user_id = $4',
        [JSON.stringify(actions), ruleName, ruleId, userId]
      );
    } else {
      // An exact address wins over its domain. Rules run in priority order and a later
      // set_category overwrites an earlier one, so a domain rule goes in before every rule and a
      // sender rule after every rule. Reordering the list by hand afterwards still decides.
      const bounds = await query(
        'SELECT COALESCE(MIN(priority), 0) AS lo, COALESCE(MAX(priority), -1) AS hi FROM inbox_rules WHERE user_id = $1',
        [userId]
      );
      const priority = scope === 'domain'
        ? parseInt(bounds.rows[0].lo, 10) - 1
        : parseInt(bounds.rows[0].hi, 10) + 1;
      const inserted = await query(
        `INSERT INTO inbox_rules
           (user_id, account_id, name, enabled, stop_processing, priority, condition_logic, conditions, actions)
         VALUES ($1, NULL, $2, true, false, $3, 'AND', $4, $5)
         RETURNING id`,
        [userId, ruleName, priority, JSON.stringify([condition]), JSON.stringify(actions)]
      );
      ruleId = inserted.rows[0].id;
      created = true;
    }

    // Matched as the rule matches: the whole address, or its ending, case-insensitively. right()
    // rather than LIKE, so a "_" or "%" in an address is not a wildcard. A domain leaves alone the
    // senders that have their own rule, as it does for new mail (see the priorities above).
    const updated = await query(
      `UPDATE messages m SET category = $1
       FROM email_accounts a
       WHERE m.account_id = a.id AND a.user_id = $2
         AND lower(m.folder) = 'inbox' AND m.is_deleted = false
         AND ${scope === 'sender' ? 'lower(trim(m.from_email)) = $3' : `right(lower(trim(m.from_email)), length($3)) = $3
         AND NOT EXISTS (
           SELECT 1 FROM inbox_rules r
           WHERE r.user_id = $2 AND r.account_id IS NULL AND r.enabled
             AND jsonb_typeof(r.conditions) = 'array' AND jsonb_array_length(r.conditions) = 1
             AND r.conditions->0->>'field' = 'from' AND r.conditions->0->>'operator' = 'equals'
             AND r.conditions->0->>'value' = lower(trim(m.from_email))
             AND jsonb_typeof(r.actions) = 'array' AND jsonb_array_length(r.actions) = 1
             AND r.actions->0->>'type' = 'set_category')`}`,
      [category, userId, condition.value]
    );
    res.json({ ok: true, ruleId, created, scope, value: condition.value, category, updated: updated.rowCount });
  } catch (err) {
    console.error('POST /rules/sender-category error:', err.message);
    res.status(500).json({ error: 'Failed to save the sender category' });
  }
});

// Users with a background "Run rules on inbox" sweep in flight.
const runInFlight = new Set();

// Applies the user's rules to every INBOX message of the given accounts, in
// batches. Per-account failures are logged and skipped so one bad account
// never aborts the rest. Returns the totals for the completion notice.
async function runRulesSweep(userId, accountIds, imapMgr) {
  let processed = 0;
  let matched = 0;

  for (const acctId of accountIds) {
    try {
      const rulesCheck = await query(
        'SELECT COUNT(*) AS cnt FROM inbox_rules WHERE user_id = $1 AND enabled = true AND (account_id IS NULL OR account_id = $2)',
        [userId, acctId]
      );
      if (parseInt(rulesCheck.rows[0].cnt, 10) === 0) continue;

      const acctResult = await query(
        'SELECT * FROM email_accounts WHERE id = $1',
        [acctId]
      );
      const account = acctResult.rows[0];
      if (!account) continue;

      const BATCH = 500;
      let lastId = null;
      while (true) {
        const msgResult = await query(
          `SELECT id, uid, folder, from_email, from_name, to_addresses, subject, has_attachments, is_read
           FROM messages
           WHERE account_id = $1 AND lower(folder) = 'inbox'
             ${lastId ? 'AND id > $3' : ''}
           ORDER BY id
           LIMIT $2`,
          lastId ? [acctId, BATCH, lastId] : [acctId, BATCH]
        );
        if (!msgResult.rows.length) break;

        lastId = msgResult.rows[msgResult.rows.length - 1].id;

        const messages = msgResult.rows.map(row => {
          let toArr = [];
          try {
            const raw = typeof row.to_addresses === 'string'
              ? JSON.parse(row.to_addresses)
              : row.to_addresses;
            if (Array.isArray(raw)) {
              toArr = raw.map(a => ({ email: a.address || a.email || '', name: a.name || '' }));
            }
          } catch { /* malformed to_addresses — leave toArr empty */ }
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

        if (msgResult.rows.length < BATCH) break;
      }
    } catch (err) {
      console.error(`Rules sweep error for account ${acctId}:`, err.message);
    }
  }

  return { processed, matched };
}

router.post('/', async (req, res) => {
  const { name, accountId, conditionLogic, conditions, actions, enabled, stopProcessing } = req.body;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'conditions and actions must be arrays' });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError) return res.status(400).json({ error: conditionError });
  let normalizedActions = normalizeActions(actions);
  const actionError = validateActions(normalizedActions);
  if (actionError) return res.status(400).json({ error: actionError });
  normalizedActions = normalizedActions
    .filter(a => accountId || a.type !== 'move');
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
  let normalizedActions = normalizeActions(actions);
  const actionError = validateActions(normalizedActions);
  if (actionError) return res.status(400).json({ error: actionError });
  normalizedActions = normalizedActions
    .filter(a => accountId || a.type !== 'move');
  try {
    if (accountId) {
      const owned = await query(
        'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
        [accountId, req.session.userId]
      );
      if (!owned.rows.length) return res.status(403).json({ error: 'Account not found' });
    }
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
