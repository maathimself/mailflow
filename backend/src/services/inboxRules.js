import { query } from './db.js';
import { resolveArchiveFolder, resolveTrashFolder, resolveAllTrashPaths, getDeleteStrategy } from '../utils/mailUtils.js';

async function getRulesForAccount(userId, accountId) {
  const result = await query(
    `SELECT * FROM inbox_rules
     WHERE user_id = $1 AND enabled = true
       AND (account_id IS NULL OR account_id = $2)
     ORDER BY priority ASC`,
    [userId, accountId]
  );
  return result.rows;
}

function normalizeStr(val) {
  return (val || '').toLowerCase().trim();
}

function matchOperator(operator, fieldVal, ruleVal) {
  const f = normalizeStr(fieldVal);
  const r = normalizeStr(ruleVal);
  switch (operator) {
    case 'contains':     return f.includes(r);
    case 'not_contains': return !f.includes(r);
    case 'equals':       return f === r;
    case 'starts_with':  return f.startsWith(r);
    case 'ends_with':    return f.endsWith(r);
    default:             return false;
  }
}

function evaluateCondition(cond, msg) {
  const { field, operator, value } = cond;
  switch (field) {
    case 'from': {
      return matchOperator(operator, msg.fromEmail, value) ||
             matchOperator(operator, msg.fromName, value);
    }
    case 'to': {
      const addrs = Array.isArray(msg.to) ? msg.to : [];
      return addrs.some(a =>
        matchOperator(operator, a.email, value) ||
        matchOperator(operator, a.name, value)
      );
    }
    case 'subject': {
      return matchOperator(operator, msg.subject, value);
    }
    case 'has_attachment': {
      return !!msg.hasAttachments;
    }
    default:
      return false;
  }
}

function evaluateRule(rule, msg) {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (conditions.length === 0) return false;
  if (rule.condition_logic === 'OR') {
    return conditions.some(c => evaluateCondition(c, msg));
  }
  return conditions.every(c => evaluateCondition(c, msg));
}

// Returns the subset of messages that remain in INBOX after rules have been applied.
// Messages that were moved, archived, or deleted are removed from the returned array
// so the new_messages broadcast only covers messages still in INBOX.
export async function applyInboxRules(messages, account, imapManager) {
  if (!messages.length) return messages;

  let rules;
  try {
    rules = await getRulesForAccount(account.user_id, account.id);
  } catch (err) {
    console.error('inboxRules: failed to load rules:', err.message);
    return messages;
  }
  if (!rules.length) return messages;

  const remaining = [...messages];
  const removedIds = new Set();

  for (const msg of messages) {
    for (const rule of rules) {
      if (!evaluateRule(rule, msg)) continue;

      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      for (const action of actions) {
        try {
          await applyAction(action, msg, account, imapManager);
          if (action.type === 'move' || action.type === 'archive' || action.type === 'delete') {
            removedIds.add(msg.id);
          }
        } catch (err) {
          console.error(`inboxRules: action ${action.type} failed for msg ${msg.id}:`, err.message);
        }
      }

      if (rule.stop_processing) break;
    }
  }

  return remaining.filter(m => !removedIds.has(m.id));
}

async function applyAction(action, msg, account, imapManager) {
  switch (action.type) {
    case 'mark_read': {
      await query(
        'UPDATE messages SET is_read = true, read_changed_at = NOW() WHERE id = $1',
        [msg.id]
      );
      imapManager.setFlag(account, msg.uid, msg.folder, '\\Seen', true).catch(err => {
        console.error('inboxRules: setFlag \\Seen failed:', err.message);
      });
      break;
    }

    case 'star': {
      await query(
        'UPDATE messages SET is_starred = true, star_changed_at = NOW() WHERE id = $1',
        [msg.id]
      );
      imapManager.setFlag(account, msg.uid, msg.folder, '\\Flagged', true).catch(err => {
        console.error('inboxRules: setFlag \\Flagged failed:', err.message);
      });
      break;
    }

    case 'move': {
      const destFolder = action.value;
      if (!destFolder) break;
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [destFolder, msg.id]);
      imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, destFolder).catch(err => {
        console.error('inboxRules: bulkMoveMessages failed:', err.message);
      });
      break;
    }

    case 'archive': {
      const archiveFolder = await resolveArchiveFolder(account.id, account.folder_mappings);
      if (!archiveFolder) break;
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [archiveFolder, msg.id]);
      imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, archiveFolder).catch(err => {
        console.error('inboxRules: archive bulkMoveMessages failed:', err.message);
      });
      break;
    }

    case 'delete': {
      const trashFolder = await resolveTrashFolder(account.id, account.folder_mappings);
      const allTrashPaths = await resolveAllTrashPaths(account.id, account.folder_mappings);
      const strategy = getDeleteStrategy(msg.folder, trashFolder, allTrashPaths);
      if (strategy.action === 'no_trash') break;
      if (strategy.action === 'move') {
        await query('UPDATE messages SET folder = $1 WHERE id = $2', [strategy.destination, msg.id]);
        imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, strategy.destination).catch(err => {
          console.error('inboxRules: delete move failed:', err.message);
        });
      } else if (strategy.action === 'expunge') {
        await query('UPDATE messages SET is_deleted = true WHERE id = $1', [msg.id]);
        imapManager.setFlag(account, msg.uid, msg.folder, '\\Deleted', true).catch(err => {
          console.error('inboxRules: setFlag \\Deleted failed:', err.message);
        });
      }
      break;
    }
  }
}
