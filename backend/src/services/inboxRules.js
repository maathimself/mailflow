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
    case 'regex': {
      // Guard against ReDoS: reject overly long patterns and known catastrophic
      // backtracking constructs (nested quantifiers like (a+)+, (a|a)+, etc.)
      // before compiling, since user-supplied patterns run on every incoming message.
      if (!ruleVal || ruleVal.length > 200) return false;
      if (/(\(.*[+*]\).*[+*]|\(.*\|.*\).*[+*])/.test(ruleVal)) return false;
      try {
        return new RegExp(ruleVal, 'i').test(fieldVal || '');
      } catch {
        return false;
      }
    }
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
    case 'body': {
      return matchOperator(operator, msg._bodyText || '', value);
    }
    case 'header': {
      const headerName = (cond.headerName || '').toLowerCase().trim();
      if (!headerName) return false;
      const headers = msg.parsedHeaders || {};
      const headerVal = headers[headerName] || '';
      return matchOperator(operator, headerVal, value);
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

  // If any rule matches on body, batch-fetch body_text from DB (it's not on the
  // parsed message object — it was stored to DB during processMsg).
  const needsBody = rules.some(r =>
    Array.isArray(r.conditions) && r.conditions.some(c => c.field === 'body')
  );

  if (needsBody) {
    const ids = messages.map(m => m.id);
    try {
      const res = await query(
        'SELECT id, body_text FROM messages WHERE id = ANY($1::uuid[])',
        [ids]
      );
      const byId = {};
      for (const row of res.rows) byId[row.id] = row;
      for (const msg of messages) {
        msg._bodyText = byId[msg.id]?.body_text || '';
        if (!msg._bodyText) {
          console.warn(`inboxRules: body_text not yet available for message ${msg.id} — body rules will not match (account uses lazy body fetch)`);
        }
      }
    } catch (err) {
      console.error('inboxRules: failed to fetch body_text for rules:', err.message);
    }
  }

  // parsedHeaders is already present on each msg from messageParser.js — no DB
  // fetch needed; header conditions can use msg.parsedHeaders directly.

  const remaining = [...messages];
  const removedIds = new Set();

  for (const msg of messages) {
    for (const rule of rules) {
      if (!evaluateRule(rule, msg)) continue;

      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      let destSeen = false;
      for (const action of actions) {
        const isDest = action.type === 'move' || action.type === 'archive' || action.type === 'delete';
        if (isDest && destSeen) continue;
        if (isDest) destSeen = true;
        try {
          const acted = await applyAction(action, msg, account, imapManager);
          if (isDest && acted) removedIds.add(msg.id);
        } catch (err) {
          console.error(`inboxRules: action ${action.type} failed for msg ${msg.id}:`, err.message);
        }
      }

      if (rule.stop_processing) break;
    }
  }

  return remaining.filter(m => !removedIds.has(m.id));
}

// Moves messages from blocked senders to trash before inbox rules run.
export async function applyBlockList(messages, account, imapManager) {
  if (!messages.length) return messages;

  let blockedRows;
  try {
    const res = await query(
      'SELECT email_address FROM block_list WHERE user_id = $1',
      [account.user_id]
    );
    blockedRows = res.rows;
  } catch (err) {
    console.error('blockList: failed to load:', err.message);
    return messages;
  }
  if (!blockedRows.length) return messages;

  const blockedSet = new Set(blockedRows.map(r => r.email_address.toLowerCase()));
  const remaining = [];
  for (const msg of messages) {
    if (!blockedSet.has((msg.fromEmail || '').toLowerCase())) {
      remaining.push(msg);
      continue;
    }
    try {
      const trashFolder = await resolveTrashFolder(account.id, account.folder_mappings);
      const allTrashPaths = await resolveAllTrashPaths(account.id, account.folder_mappings);
      const strategy = getDeleteStrategy(msg.folder, trashFolder, allTrashPaths);
      if (strategy.action === 'move') {
        const result = await imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, strategy.destination);
        if (!result.failed?.length) {
          await query('UPDATE messages SET folder = $1 WHERE id = $2', [strategy.destination, msg.id]);
        } else {
          remaining.push(msg);
        }
      } else if (strategy.action === 'expunge') {
        await imapManager.setFlag(account, msg.uid, msg.folder, '\\Deleted', true);
        await query('UPDATE messages SET is_deleted = true WHERE id = $1', [msg.id]);
      } else {
        remaining.push(msg);
      }
    } catch (err) {
      console.error(`blockList: failed to move msg ${msg.id}:`, err.message);
      remaining.push(msg);
    }
  }
  return remaining;
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
      if (!destFolder) return false;
      // IMAP first — if the server-side move fails (throws or returns failed UIDs),
      // the error propagates to the caller so the DB is never updated. This prevents
      // a DB/IMAP split where the DB shows the message in destFolder but IMAP still
      // has it in INBOX, which caused the next sync to bounce the message back via
      // the relocation logic.
      const moveResult = await imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, destFolder);
      if (moveResult.failed?.length) throw new Error(`IMAP move to ${destFolder} failed for uid ${msg.uid}`);
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [destFolder, msg.id]);
      return true;
    }

    case 'archive': {
      const archiveFolder = await resolveArchiveFolder(account.id, account.folder_mappings);
      if (!archiveFolder) return false;
      const archiveResult = await imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, archiveFolder);
      if (archiveResult.failed?.length) throw new Error(`IMAP archive failed for uid ${msg.uid}`);
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [archiveFolder, msg.id]);
      return true;
    }

    case 'delete': {
      const trashFolder = await resolveTrashFolder(account.id, account.folder_mappings);
      const allTrashPaths = await resolveAllTrashPaths(account.id, account.folder_mappings);
      const strategy = getDeleteStrategy(msg.folder, trashFolder, allTrashPaths);
      if (strategy.action === 'no_trash') return false;
      if (strategy.action === 'move') {
        const deleteResult = await imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, strategy.destination);
        if (deleteResult.failed?.length) throw new Error(`IMAP delete-move failed for uid ${msg.uid}`);
        await query('UPDATE messages SET folder = $1 WHERE id = $2', [strategy.destination, msg.id]);
      } else if (strategy.action === 'expunge') {
        await imapManager.setFlag(account, msg.uid, msg.folder, '\\Deleted', true);
        await query('UPDATE messages SET is_deleted = true WHERE id = $1', [msg.id]);
      }
      return true;
    }
  }
}
