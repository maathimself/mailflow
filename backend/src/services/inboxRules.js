import { query } from './db.js';
import { resolveArchiveFolder, resolveTrashFolder, resolveAllTrashPaths, getDeleteStrategy, adjustFolderCounts } from '../utils/mailUtils.js';

async function getRulesForAccount(userId, accountId) {
  const result = await query(
    `SELECT * FROM inbox_rules
     WHERE user_id = $1 AND enabled = true
       AND (account_id IS NULL OR account_id = $2)
     ORDER BY priority ASC, created_at ASC`,
    [userId, accountId]
  );
  return result.rows;
}

function normalizeStr(val) {
  return (val || '').toLowerCase().trim();
}

// Returns true if a user-supplied regex is unsafe to run: too long, uncompilable,
// or a catastrophic-backtracking shape. User regexes run synchronously on the event
// loop for every incoming message, so a single bad pattern can freeze the whole
// server (ReDoS). Exported so rules can be rejected at creation time too.
export function isDangerousRegex(src) {
  if (!src || typeof src !== 'string' || src.length > 200) return true;
  // Quantified alternation / quantifier-then-quantifier, e.g. (a|a)+, (a+).*+ .
  if (/\(.*[+*]\).*[+*]|\(.*\|.*\).*[+*]/.test(src)) return true;
  // Nested quantifiers of any form, incl. bounded {n,m}: (a+)+, (a{1,9}){1,9}, (a*)? .
  // Linear scan tracking whether the current group already contains a quantifier;
  // a quantifier applied to such a group is the classic exponential shape.
  const groupHasQuant = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }                                   // escaped literal
    if (c === '[') { i++; while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } continue; } // char class
    if (c === '(') { groupHasQuant.push(false); continue; }
    if (c === '*' || c === '+' || c === '{' || c === '?') { if (groupHasQuant.length) groupHasQuant[groupHasQuant.length - 1] = true; continue; }
    if (c === ')') {
      const inner = groupHasQuant.pop();
      const next = src[i + 1];
      if (inner && (next === '*' || next === '+' || next === '{' || next === '?')) return true;
    }
  }
  try { new RegExp(src); } catch { return true; }
  return false;
}

function matchOperator(operator, fieldVal, ruleVal) {
  const f = normalizeStr(fieldVal);
  const r = normalizeStr(ruleVal);
  // A blank rule value with contains/starts_with/ends_with matches every string
  // in JavaScript (e.g. 'anything'.includes('') === true). Treat it as no-match
  // so a rule whose condition value was accidentally left empty never becomes a
  // silent match-all that deletes or moves every incoming message.
  if (!r) return false;
  switch (operator) {
    case 'contains':     return f.includes(r);
    case 'not_contains': return !f.includes(r);
    case 'equals':       return f === r;
    case 'starts_with':  return f.startsWith(r);
    case 'ends_with':    return f.endsWith(r);
    case 'regex': {
      // Reject catastrophic-backtracking patterns before compiling (ReDoS guard);
      // user patterns run synchronously on every incoming message.
      if (isDangerousRegex(ruleVal)) return false;
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
  if (!cond || typeof cond.field !== 'string') return false;
  const { field, operator, value } = cond;
  switch (field) {
    case 'from': {
      // not_contains must require BOTH email and name to not contain the value.
      // A sender "Alice <alice@example.com>" would wrongly escape a not_contains filter
      // using OR because the display name "Alice" doesn't contain the domain.
      if (operator === 'not_contains') {
        return matchOperator('not_contains', msg.fromEmail, value) &&
               matchOperator('not_contains', msg.fromName, value);
      }
      return matchOperator(operator, msg.fromEmail, value) ||
             matchOperator(operator, msg.fromName, value);
    }
    case 'to': {
      const addrs = Array.isArray(msg.to) ? msg.to : [];
      if (!addrs.length) return false;
      // not_contains must mean none of the recipients contain the value.
      // Using some() for not_contains would fire whenever any single address or name
      // field does not contain the value — almost always true for multi-recipient messages.
      if (operator === 'not_contains') {
        return addrs.every(a =>
          matchOperator('not_contains', a.email, value) &&
          matchOperator('not_contains', a.name, value)
        );
      }
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
    case 'read_status': {
      // value is 'read' or 'unread'. Mirror the msg.isRead ?? msg.is_read fallback
      // used by the action handlers so both the real-time and run-rules message
      // shapes are covered. Any non-'read' value is treated as 'unread'.
      const isRead = !!(msg.isRead ?? msg.is_read);
      return value === 'read' ? isRead : !isRead;
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

// Applies inbox rules to a batch of new INBOX messages. Returns { remaining, mutedIds }:
//   remaining — messages still in INBOX after rules ran (moved/archived/deleted excluded)
//   mutedIds  — IDs of remaining messages that had mark_read applied by a rule;
//               the caller uses this to suppress sound/toast/push for silenced mail
export async function applyInboxRules(messages, account, imapManager) {
  if (!messages.length) return { remaining: messages, mutedIds: new Set() };

  let rules;
  try {
    rules = await getRulesForAccount(account.user_id, account.id);
  } catch (err) {
    console.error('inboxRules: failed to load rules:', err.message);
    return { remaining: messages, mutedIds: new Set() };
  }
  if (!rules.length) return { remaining: messages, mutedIds: new Set() };

  // If any rule matches on body, batch-fetch body_text from DB (it's not on the
  // parsed message object — it was stored to DB during processMsg).
  const needsBody = rules.some(r =>
    Array.isArray(r.conditions) && r.conditions.some(c => c?.field === 'body')
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

  // Lazy resolver cache shared across the message loop. Populated on first actual use
  // inside applyAction so resolvers are never called for actions that are deduped or
  // skipped, but results are reused across messages to avoid N+1 DB queries.
  const resolverCache = {};

  const remaining = [...messages];
  const removedIds = new Set();
  // IDs of remaining-in-INBOX messages that had mark_read applied by a rule.
  // Used by the caller to skip sound/toast/push for mail the user chose to silence.
  const mutedIds = new Set();

  for (const msg of messages) {
    for (const rule of rules) {
      let matches;
      try {
        matches = evaluateRule(rule, msg);
      } catch (err) {
        console.error(`inboxRules: rule ${rule.id} evaluation error for msg ${msg.id}:`, err.message);
        continue;
      }
      if (!matches) continue;

      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      let destSeen = false;
      for (const action of actions) {
        const isDest = action.type === 'move' || action.type === 'archive' || action.type === 'delete';
        if (isDest && destSeen) continue;
        // Skip destination actions for already-relocated messages — the source UID no
        // longer exists in its original folder. Non-destination actions (mark_read, star)
        // are allowed to continue: they use msg.id for the DB update and msg.folder/uid
        // is kept current after each move so setFlag and adjustFolderCounts target the
        // correct destination folder.
        if (isDest && removedIds.has(msg.id)) continue;
        if (isDest) destSeen = true;
        try {
          const acted = await applyAction(action, msg, account, imapManager, resolverCache);
          if (isDest && acted) removedIds.add(msg.id);
          // mark_read: add to mutedIds so caller suppresses sound/push.
          // star: intentionally NOT muted — a star-only rule should still alert.
          if (action.type === 'mark_read') mutedIds.add(msg.id);
        } catch (err) {
          console.error(`inboxRules: action ${action.type} failed for msg ${msg.id}:`, err.message);
        }
      }

      if (rule.stop_processing) break;
    }
  }

  return {
    remaining: remaining.filter(m => !removedIds.has(m.id)),
    mutedIds,
  };
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

  // Resolve trash folders once before iterating — avoids N+1 DB queries when many messages
  // are blocked in the same sync batch.
  let trashFolder, allTrashPaths;
  try {
    [trashFolder, allTrashPaths] = await Promise.all([
      resolveTrashFolder(account.id, account.folder_mappings),
      resolveAllTrashPaths(account.id, account.folder_mappings),
    ]);
  } catch (err) {
    console.error('blockList: failed to resolve trash folders:', err.message);
    return messages;
  }

  const remaining = [];
  for (const msg of messages) {
    if (!blockedSet.has((msg.fromEmail || '').toLowerCase())) {
      remaining.push(msg);
      continue;
    }
    try {
      const strategy = getDeleteStrategy(msg.folder, trashFolder, allTrashPaths);
      if (strategy.action === 'move') {
        imapManager._guardMoveUid(account.id, msg.folder, msg.uid);
        try {
          const result = await imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, strategy.destination);
          if (!result.failed?.length) {
            const newUid = result.uidMap?.get(Number(msg.uid));
            if (newUid) {
              await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [strategy.destination, newUid, msg.id]);
            } else {
              imapManager._guardMoveUid(account.id, strategy.destination, msg.uid);
              await query('UPDATE messages SET folder = $1 WHERE id = $2', [strategy.destination, msg.id]);
              setTimeout(() => imapManager._unguardMoveUid(account.id, strategy.destination, msg.uid), 10_000);
            }
            const wasUnread = !(msg.isRead ?? msg.is_read);
            adjustFolderCounts(account.id, msg.folder, -1, wasUnread ? -1 : 0);
            adjustFolderCounts(account.id, strategy.destination, 1, wasUnread ? 1 : 0);
          } else {
            remaining.push(msg);
          }
        } finally {
          imapManager._unguardMoveUid(account.id, msg.folder, msg.uid);
        }
      } else if (strategy.action === 'expunge') {
        await imapManager.setFlag(account, msg.uid, msg.folder, '\\Deleted', true);
        await query('UPDATE messages SET is_deleted = true WHERE id = $1', [msg.id]);
        const wasUnread = !(msg.isRead ?? msg.is_read);
        adjustFolderCounts(account.id, msg.folder, -1, wasUnread ? -1 : 0);
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

async function applyAction(action, msg, account, imapManager, resolverCache = {}) {
  switch (action.type) {
    case 'mark_read': {
      await query(
        'UPDATE messages SET is_read = true, read_changed_at = NOW() WHERE id = $1',
        [msg.id]
      );
      imapManager.setFlag(account, msg.uid, msg.folder, '\\Seen', true).catch(err => {
        console.error('inboxRules: setFlag \\Seen failed:', err.message);
      });
      // msg.isRead (camelCase from parseMessage) and msg.is_read (snake_case in test
      // fixtures) both represent the pre-action read state; use whichever is present.
      const wasUnread = !(msg.isRead ?? msg.is_read);
      if (wasUnread) adjustFolderCounts(account.id, msg.folder, 0, -1);
      // Update in-memory state so subsequent actions in later rules (e.g. a move rule
      // at lower priority) see the correct read state and don't double-decrement the
      // unread count.
      msg.isRead = true;
      msg.is_read = true;
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
      // Save source coordinates before the move so the finally block can unguard the
      // correct slot even after we update msg.folder/uid for subsequent rules.
      const srcFolder = msg.folder;
      const srcUid = msg.uid;
      // Guard the source UID before the IMAP move so reconcileDeletes cannot delete
      // the DB row if an EXPUNGE notification arrives while the move is in flight.
      imapManager._guardMoveUid(account.id, srcFolder, srcUid);
      try {
        // IMAP first — if the server-side move fails (throws or returns failed UIDs),
        // the error propagates to the caller so the DB is never updated. This prevents
        // a DB/IMAP split where the DB shows the message in destFolder but IMAP still
        // has it in INBOX, which caused the next sync to bounce the message back.
        const moveResult = await imapManager.bulkMoveMessages(account, [srcUid], srcFolder, destFolder);
        if (moveResult.failed?.length) throw new Error(`IMAP move to ${destFolder} failed for uid ${srcUid}`);
        // Update UID alongside folder. The IMAP MOVE assigns the message a new UID in
        // the destination folder. Without this, reconcileDeletes fires ~1.5 s later
        // (triggered by the EXPUNGE IDLE event), sees the old source UID absent from
        // the destination's server UID set, and deletes the DB row — silently losing
        // the message.
        const newUid = moveResult.uidMap?.get(Number(srcUid));
        if (newUid) {
          await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [destFolder, newUid, msg.id]);
        } else {
          // Non-UIDPLUS server: DB will hold the stale source UID in the destination
          // folder until the next sync corrects it. Guard the stale UID in the
          // destination so reconcileDeletes does not treat it as an orphan in the
          // meantime. The guard auto-expires after 10 s — well beyond the 1.5 s
          // EXPUNGE debounce; a regular sync (~60 s) will update the UID before the
          // next periodic reconcile (every 10 sync ticks, ~10 min).
          imapManager._guardMoveUid(account.id, destFolder, srcUid);
          await query('UPDATE messages SET folder = $1 WHERE id = $2', [destFolder, msg.id]);
          setTimeout(() => imapManager._unguardMoveUid(account.id, destFolder, srcUid), 10_000);
        }
        const wasUnread = !(msg.isRead ?? msg.is_read);
        adjustFolderCounts(account.id, srcFolder, -1, wasUnread ? -1 : 0);
        adjustFolderCounts(account.id, destFolder, 1, wasUnread ? 1 : 0);
        // Update the in-memory msg so subsequent non-destination actions in later rules
        // (e.g. mark_read) target the correct destination folder and uid rather than
        // the now-stale INBOX values.
        msg.folder = destFolder;
        msg.uid = newUid || srcUid;
      } finally {
        imapManager._unguardMoveUid(account.id, srcFolder, srcUid);
      }
      return true;
    }

    case 'archive': {
      if (!resolverCache._archiveResolved) {
        resolverCache._archiveResolved = true;
        resolverCache.archiveFolder = await resolveArchiveFolder(account.id, account.folder_mappings);
      }
      const archiveFolder = resolverCache.archiveFolder;
      if (!archiveFolder) return false;
      const srcFolder = msg.folder;
      const srcUid = msg.uid;
      imapManager._guardMoveUid(account.id, srcFolder, srcUid);
      try {
        const archiveResult = await imapManager.bulkMoveMessages(account, [srcUid], srcFolder, archiveFolder);
        if (archiveResult.failed?.length) throw new Error(`IMAP archive failed for uid ${srcUid}`);
        const newArchiveUid = archiveResult.uidMap?.get(Number(srcUid));
        if (newArchiveUid) {
          await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [archiveFolder, newArchiveUid, msg.id]);
        } else {
          imapManager._guardMoveUid(account.id, archiveFolder, srcUid);
          await query('UPDATE messages SET folder = $1 WHERE id = $2', [archiveFolder, msg.id]);
          setTimeout(() => imapManager._unguardMoveUid(account.id, archiveFolder, srcUid), 10_000);
        }
        const wasUnread = !(msg.isRead ?? msg.is_read);
        adjustFolderCounts(account.id, srcFolder, -1, wasUnread ? -1 : 0);
        adjustFolderCounts(account.id, archiveFolder, 1, wasUnread ? 1 : 0);
        msg.folder = archiveFolder;
        msg.uid = newArchiveUid || srcUid;
      } finally {
        imapManager._unguardMoveUid(account.id, srcFolder, srcUid);
      }
      return true;
    }

    case 'delete': {
      if (!resolverCache._trashResolved) {
        resolverCache._trashResolved = true;
        [resolverCache.trashFolder, resolverCache.allTrashPaths] = await Promise.all([
          resolveTrashFolder(account.id, account.folder_mappings),
          resolveAllTrashPaths(account.id, account.folder_mappings),
        ]);
      }
      const trashFolder = resolverCache.trashFolder;
      const allTrashPaths = resolverCache.allTrashPaths;
      const strategy = getDeleteStrategy(msg.folder, trashFolder, allTrashPaths);
      if (strategy.action === 'no_trash') return false;
      if (strategy.action === 'move') {
        imapManager._guardMoveUid(account.id, msg.folder, msg.uid);
        try {
          const deleteResult = await imapManager.bulkMoveMessages(account, [msg.uid], msg.folder, strategy.destination);
          if (deleteResult.failed?.length) throw new Error(`IMAP delete-move failed for uid ${msg.uid}`);
          const newDeleteUid = deleteResult.uidMap?.get(Number(msg.uid));
          if (newDeleteUid) {
            await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [strategy.destination, newDeleteUid, msg.id]);
          } else {
            imapManager._guardMoveUid(account.id, strategy.destination, msg.uid);
            await query('UPDATE messages SET folder = $1 WHERE id = $2', [strategy.destination, msg.id]);
            setTimeout(() => imapManager._unguardMoveUid(account.id, strategy.destination, msg.uid), 10_000);
          }
          const wasUnread = !(msg.isRead ?? msg.is_read);
          adjustFolderCounts(account.id, msg.folder, -1, wasUnread ? -1 : 0);
          adjustFolderCounts(account.id, strategy.destination, 1, wasUnread ? 1 : 0);
        } finally {
          imapManager._unguardMoveUid(account.id, msg.folder, msg.uid);
        }
      } else if (strategy.action === 'expunge') {
        await imapManager.setFlag(account, msg.uid, msg.folder, '\\Deleted', true);
        await query('UPDATE messages SET is_deleted = true WHERE id = $1', [msg.id]);
        const wasUnread = !(msg.isRead ?? msg.is_read);
        adjustFolderCounts(account.id, msg.folder, -1, wasUnread ? -1 : 0);
      }
      return true;
    }
  }
}
