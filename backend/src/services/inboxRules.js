import { query } from './db.js';
import { resolveArchiveFolder, isAllMailFolder, resolveTrashFolder, resolveAllTrashPaths, getDeleteStrategy } from '../utils/mailUtils.js';
import { materializeArchiveReceipt } from './archiveInbox.js';

function bulkMoveObserved(
  imapManager, account, uids, fromFolder, toFolder, observationContext, operationKey,
  sourceMessages = [], allMail = false,
) {
  const rows = new Map(sourceMessages.map(msg => {
    const token = observationContext?.tokens?.find(candidate => candidate.folder === msg.folder);
    return [Number(msg.uid), {
      ...msg, account_id: msg.account_id || account.id,
      folder_uid_validity: token?.uidValidity ?? msg.folder_uid_validity,
      folder_observation_generation: token?.generation ?? msg.folder_observation_generation,
    }];
  }));
  return imapManager.bulkMoveMessages(account, uids, fromFolder, toFolder, {
    ...(observationContext ? { observationContext } : {}),
    operationKey,
    sourceRows: rows,
    sourceSnapshots: new Map([...rows].map(([uid, row]) => [uid, desiredSnapshot(row, account, observationContext)])),
    materialize: (row, receipt, operation, tx, providerResource) => materializeArchiveReceipt(tx, {
      accountId: account.id, sourceSnapshot: row, destinationFolder: toFolder,
      receipt, operation, allMail,
      providerResource,
    }),
  });
}

function applyMoveReceipt(msg, result, sourceUid, destinationFolder) {
  const receipt = result.receiptMap?.get(Number(sourceUid));
  msg.uid = receipt?.uid ?? result.uidMap?.get(Number(sourceUid)) ?? msg.uid;
  msg.folder = destinationFolder;
  if (receipt?.uidValidity != null) msg.folder_uid_validity = receipt.uidValidity;
  if (receipt?.destinationToken?.generation != null) {
    msg.folder_observation_generation = receipt.destinationToken.generation;
  }
}

function desiredSnapshot(msg, account, observationContext) {
  const token = observationContext?.tokens?.find(candidate => candidate.folder === msg.folder);
  const uidValidity = token?.uidValidity ?? msg.folder_uid_validity;
  const generation = token?.generation ?? msg.folder_observation_generation;
  if (uidValidity == null || generation == null || !msg.id) return null;
  return {
    id: msg.id,
    accountId: account.id,
    uid: Number(msg.uid),
    folder: msg.folder,
    uidValidity: String(uidValidity),
    folderGeneration: String(generation),
    readRevision: Number(msg.read_revision || 0),
    starRevision: Number(msg.star_revision || 0),
  };
}

async function setDesiredFlagObserved(
  imapManager, account, msg, flag, value, observationContext,
) {
  if (typeof imapManager.setDesiredFlag !== 'function') {
    const err = new Error('Durable desired-flag capability is unavailable');
    err.code = 'INBOX_RULE_DESIRED_FLAG_UNAVAILABLE';
    throw err;
  }
  const snapshot = desiredSnapshot(msg, account, observationContext);
  const outcome = await imapManager.setDesiredFlag(
    account, msg.id, flag, value, snapshot ? { snapshot } : {},
  );
  if (outcome?.delivery?.state !== 'confirmed') {
    const err = new Error(`Desired ${flag} delivery is not confirmed`);
    err.code = 'INBOX_RULE_DESIRED_FLAG_NOT_CONFIRMED';
    err.retryable = true;
    err.uncertain = true;
    err.desiredFlagAcceptance = outcome?.acceptance;
    throw err;
  }
  return outcome;
}

function applyAcceptedDesiredFlagToMessage(err, action, msg) {
  const accepted = err?.desiredFlagAcceptance?.delivery;
  if (!accepted || accepted.desiredValue !== true) return false;
  if (action.type === 'mark_read' && accepted.flag === 'read') {
    msg.isRead = true;
    msg.is_read = true;
    return true;
  }
  if (action.type === 'star' && accepted.flag === 'star') {
    msg.isStarred = true;
    msg.is_starred = true;
    return true;
  }
  return false;
}

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
export async function applyInboxRules(messages, account, imapManager, observationContext = null) {
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
  // A failed forward leaves the source in place for an intentional retry or
  // manual recovery. Keep every destination action blocked so nothing moves,
  // archives, or deletes that source out from under recovery.
  const destinationBlockedIds = new Set();
  const actionBlockedIds = new Set();
  // IDs of remaining-in-INBOX messages that had mark_read applied by a rule.
  // Used by the caller to skip sound/toast/push for mail the user chose to silence.
  const mutedIds = new Set();
  const lastForwardRuleIndex = rules.reduce(
    (lastIndex, rule, index) =>
      Array.isArray(rule.actions) &&
      rule.actions.some(action => action?.type === 'forward')
        ? index
        : lastIndex,
    -1
  );

  for (const msg of messages) {
    const deferredDestinations = [];
    let forwardBarrierPassed = lastForwardRuleIndex === -1;

    const executeNonForwardAction = async (action, ruleId, isDest) => {
      try {
        const acted = await applyAction(
          action,
          msg,
          account,
          imapManager,
          ruleId,
          resolverCache,
          observationContext
        );
        if (isDest && acted) removedIds.add(msg.id);
        // mark_read: add to mutedIds so caller suppresses sound/push.
        // star: intentionally NOT muted — a star-only rule should still alert.
        if (action.type === 'mark_read') mutedIds.add(msg.id);
      } catch (err) {
        if (err?.code === 'INBOX_RULE_DESIRED_FLAG_NOT_CONFIRMED' ||
            err?.code === 'INBOX_RULE_DESIRED_FLAG_UNAVAILABLE' ||
            err?.code === 'INBOX_RULE_DESIRED_FLAG_FAILED') {
          actionBlockedIds.add(msg.id);
          const accepted = applyAcceptedDesiredFlagToMessage(err, action, msg);
          if (accepted && action.type === 'mark_read') mutedIds.add(msg.id);
        }
        console.error(`inboxRules: action ${action.type} failed for msg ${msg.id}:`, err.message);
      }
    };

    const flushDeferredDestinations = async () => {
      while (deferredDestinations.length) {
        const { action, ruleId } = deferredDestinations.shift();
        if (removedIds.has(msg.id) || destinationBlockedIds.has(msg.id) ||
            actionBlockedIds.has(msg.id)) continue;
        await executeNonForwardAction(action, ruleId, true);
      }
    };

    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
      if (actionBlockedIds.has(msg.id)) break;
      const rule = rules[ruleIndex];
      let matches;
      try {
        matches = evaluateRule(rule, msg);
      } catch (err) {
        console.error(`inboxRules: rule ${rule.id} evaluation error for msg ${msg.id}:`, err.message);
        if (!forwardBarrierPassed && ruleIndex === lastForwardRuleIndex) {
          forwardBarrierPassed = true;
          await flushDeferredDestinations();
        }
        continue;
      }
      if (!matches) {
        if (!forwardBarrierPassed && ruleIndex === lastForwardRuleIndex) {
          forwardBarrierPassed = true;
          await flushDeferredDestinations();
        }
        continue;
      }

      const actions = Array.isArray(rule.actions) ? rule.actions : [];

      // Forward first within the matching rule. A failed attempt does not stop
      // independent forwards or non-destination actions, but it permanently
      // blocks relocation of this source for the remainder of the batch.
      for (const action of actions.filter(action => action.type === 'forward')) {
        try {
          await applyAction(
            action,
            msg,
            account,
            imapManager,
            rule.id,
            resolverCache,
            observationContext
          );
        } catch {
          destinationBlockedIds.add(msg.id);
          console.error('inboxRules: forward action failed; destination actions suppressed');
        }
      }

      // Once no later rule can run a forward, release destinations queued by
      // higher-priority rules before continuing this rule's ordinary actions.
      // A matching stop_processing rule also makes all later rules unreachable.
      if (
        !forwardBarrierPassed &&
        (ruleIndex === lastForwardRuleIndex || rule.stop_processing)
      ) {
        forwardBarrierPassed = true;
        await flushDeferredDestinations();
      }

      let destSeen = false;
      for (const action of actions.filter(action => action.type !== 'forward')) {
        if (actionBlockedIds.has(msg.id)) break;
        const isDest = action.type === 'move' || action.type === 'archive' || action.type === 'delete';
        if (isDest && destSeen) continue;
        // Skip destination actions for already-relocated messages — the source UID no
        // longer exists in its original folder. Non-destination actions (mark_read, star)
        // are allowed to continue: they use msg.id for the DB update and msg.folder/uid
        // is kept current after each move so setFlag and adjustFolderCounts target the
        // correct destination folder.
        if (isDest && removedIds.has(msg.id)) continue;
        if (isDest && destinationBlockedIds.has(msg.id)) continue;
        if (isDest) destSeen = true;
        if (isDest && !forwardBarrierPassed) {
          deferredDestinations.push({ action, ruleId: rule.id });
          continue;
        }
        await executeNonForwardAction(action, rule.id, isDest);
      }

      if (rule.stop_processing) break;
    }

    await flushDeferredDestinations();
  }

  return {
    remaining: remaining.filter(m => !removedIds.has(m.id)),
    mutedIds,
  };
}

// Moves messages from blocked senders to trash before inbox rules run.
export async function applyBlockList(messages, account, imapManager, observationContext = null) {
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
        const sourceFolder = msg.folder;
        const sourceUid = msg.uid;
        imapManager._guardMoveUid(account.id, msg.folder, msg.uid);
        try {
          const result = await bulkMoveObserved(
            imapManager, account, [msg.uid], msg.folder, strategy.destination,
            observationContext, `block-list:${msg.id}:${strategy.destination}`,
            [msg],
          );
          if (!result.failed?.length) {
            applyMoveReceipt(msg, result, sourceUid, strategy.destination);
          } else {
            remaining.push(msg);
          }
        } finally {
          imapManager._unguardMoveUid(account.id, sourceFolder, sourceUid);
        }
      } else if (strategy.action === 'expunge') {
        const snapshot = desiredSnapshot(msg, account, observationContext);
        if (!snapshot) throw new Error('Exact block-list delete snapshot is unavailable');
        await imapManager.removeMessageCopy(account.id, msg.uid, msg.folder, {
          expectedId: msg.id, expectedUidValidity: snapshot.uidValidity, snapshot,
          operationKey: `block-list-expunge:${msg.id}`, notify: false,
        });
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

async function applyAction(
  action, msg, account, imapManager, ruleId, resolverCache = {}, observationContext = null
) {
  switch (action.type) {
    case 'forward': {
      // Load this path only when a forward action actually runs. ruleForwarder
      // reaches SMTP/OAuth setup, which should not initialize for ordinary rule
      // evaluation or route validation.
      const { forwardRuleMessage } = await import('./ruleForwarder.js');
      return forwardRuleMessage({
        ruleId,
        message: msg,
        account,
        imapManager,
        recipient: action.value,
      });
    }

    case 'mark_read': {
      try {
        await setDesiredFlagObserved(
          imapManager, account, msg, '\\Seen', true, observationContext,
        );
      } catch (err) {
        if (!err?.code?.startsWith?.('INBOX_RULE_DESIRED_FLAG_')) {
          err.code = 'INBOX_RULE_DESIRED_FLAG_FAILED';
        }
        throw err;
      }
      // Update in-memory state so subsequent actions in later rules (e.g. a move rule
      // at lower priority) see the correct read state and don't double-decrement the
      // unread count.
      msg.isRead = true;
      msg.is_read = true;
      break;
    }

    case 'star': {
      try {
        await setDesiredFlagObserved(
          imapManager, account, msg, '\\Flagged', true, observationContext,
        );
      } catch (err) {
        if (!err?.code?.startsWith?.('INBOX_RULE_DESIRED_FLAG_')) {
          err.code = 'INBOX_RULE_DESIRED_FLAG_FAILED';
        }
        throw err;
      }
      msg.isStarred = true;
      msg.is_starred = true;
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
        const moveResult = await bulkMoveObserved(
          imapManager, account, [srcUid], srcFolder, destFolder, observationContext,
          `rule-move:${msg.id}:${srcFolder}:${destFolder}`,
          [msg],
        );
        if (moveResult.failed?.length) throw new Error(`IMAP move to ${destFolder} failed for uid ${srcUid}`);
        // Update the in-memory msg so subsequent non-destination actions in later rules
        // (e.g. mark_read) target the correct destination folder and uid rather than
        // the now-stale INBOX values.
        applyMoveReceipt(msg, moveResult, srcUid, destFolder);
      } finally {
        imapManager._unguardMoveUid(account.id, srcFolder, srcUid);
      }
      return true;
    }

    case 'archive': {
      if (!resolverCache._archiveResolved) {
        resolverCache._archiveResolved = true;
        resolverCache.archiveFolder = await resolveArchiveFolder(account.id, account.folder_mappings);
        // Gmail's All Mail (special_use '\All') is excluded from sync/backfill and the
        // relocate guard (imapManager.js) — see mailUtils.js resolveArchiveFolder/isAllMailFolder.
        resolverCache.archiveIsAllMail = resolverCache.archiveFolder
          ? await isAllMailFolder(account.id, resolverCache.archiveFolder)
          : false;
      }
      const archiveFolder = resolverCache.archiveFolder;
      if (!archiveFolder) return false;
      const srcFolder = msg.folder;
      const srcUid = msg.uid;
      imapManager._guardMoveUid(account.id, srcFolder, srcUid);
      try {
        const archiveResult = await bulkMoveObserved(
          imapManager, account, [srcUid], srcFolder, archiveFolder, observationContext,
          `rule-archive:${msg.id}:${srcFolder}:${archiveFolder}`,
          [msg], resolverCache.archiveIsAllMail,
        );
        if (archiveResult.failed?.length) throw new Error(`IMAP archive failed for uid ${srcUid}`);
        applyMoveReceipt(msg, archiveResult, srcUid, archiveFolder);
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
        const sourceFolder = msg.folder;
        const sourceUid = msg.uid;
        imapManager._guardMoveUid(account.id, sourceFolder, sourceUid);
        try {
          const deleteResult = await bulkMoveObserved(
            imapManager, account, [msg.uid], msg.folder, strategy.destination,
            observationContext, `rule-delete:${msg.id}:${msg.folder}:${strategy.destination}`,
            [msg],
          );
          if (deleteResult.failed?.length) throw new Error(`IMAP delete-move failed for uid ${msg.uid}`);
          applyMoveReceipt(msg, deleteResult, sourceUid, strategy.destination);
        } finally {
          imapManager._unguardMoveUid(account.id, sourceFolder, sourceUid);
        }
      } else if (strategy.action === 'expunge') {
        const snapshot = desiredSnapshot(msg, account, observationContext);
        if (!snapshot) throw new Error('Exact rule delete snapshot is unavailable');
        await imapManager.removeMessageCopy(account.id, msg.uid, msg.folder, {
          expectedId: msg.id, expectedUidValidity: snapshot.uidValidity, snapshot,
          operationKey: `rule-expunge:${msg.id}`, notify: false,
        });
      }
      return true;
    }
  }
}
