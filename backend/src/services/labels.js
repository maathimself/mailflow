import { query } from './db.js';
import { fanOutReadToSiblings, readCopyTargets, pushSeen } from '../utils/mailUtils.js';

// Generic "labels" capability (v3.0 plugin platform).
//
// A label on a message physically means a COPY of that message living in the label's
// designated folder — a sibling row sharing the original's RFC Message-ID. Core owns the
// mechanics (ensure the folder, copy in, resolve the sibling, remove the copy) so features —
// and, once the boundary is finished, sandboxed plugins — apply/remove labels without ever
// touching IMAP or SQL directly. GTD is the first consumer; its states (Todo/Watch/…) are
// just labels whose folders come from its own config.
//
// imapManager is injected (callers pass their handle) so the DB/IMAP logic is unit-testable
// without a live connection pool — matching the pattern gtdTransitions/gtdSections already use.

// Resolve the uid of the message's copy that lives in `folder` for its account, or null. The
// acted row is used directly when it already lives there; otherwise the shared RFC Message-ID
// (an IMAP COPY duplicates it verbatim) joins to the sibling copy. A message with no
// Message-ID can only be resolved via the acted-row case.
export async function resolveLabelCopyUid(message, folder) {
  if (message.folder === folder) return message.uid;
  if (!message.message_id) return null;
  const { rows } = await query(
    'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false LIMIT 1',
    [message.account_id, folder, message.message_id]
  );
  return rows[0]?.uid ?? null;
}

// Apply a label: ensure the label folder exists, then COPY the message into it (leaving the
// original in place). imapManager.copyMessage also emits the section-refresh event. No-op when
// the message already lives in the label folder. `message` needs { uid, folder }.
export async function applyLabel(imapManager, account, message, labelFolder, { forceCopy = false } = {}) {
  if (message.folder === labelFolder) {
    return { applied: false, uid: message.uid, reason: 'already-there' };
  }
  const existingUid = forceCopy ? null : await resolveLabelCopyUid(message, labelFolder);
  if (existingUid != null) {
    return { applied: false, uid: existingUid, reason: 'already-labelled' };
  }
  await imapManager.ensureFolder(account, labelFolder);
  const uid = await imapManager.copyMessage(account.id, message.uid, message.folder, labelFolder);
  return { applied: true, uid: uid ?? null };
}

// Remove one exact label copy only when it still carries the source message's RFC Message-ID.
// This is the safe inverse for a COPY whose destination UID was returned by UIDPLUS: a stale or
// forged UID cannot remove a different message's label copy. Without a Message-ID there is no
// stable identity shared by the source and copied rows, so no inverse is advertised.
export async function removeExactLabelCopy(imapManager, message, labelFolder, uid) {
  if (!message.message_id) return { removed: false };
  const { rows } = await query(
    `SELECT uid FROM messages
      WHERE account_id = $1 AND folder = $2 AND uid = $3
        AND message_id = $4 AND is_deleted = false
      LIMIT 1`,
    [message.account_id, labelFolder, uid, message.message_id]
  );
  if (!rows[0]) return { removed: false };
  await imapManager.removeMessageCopy(message.account_id, uid, labelFolder);
  return { removed: true };
}

// Remove a label: delete the message's copy living in the label folder, leaving INBOX and any
// other labels intact. No-op when no such copy exists. `message` needs { account_id, uid,
// folder, message_id }.
export async function removeLabel(imapManager, message, labelFolder) {
  const uid = await resolveLabelCopyUid(message, labelFolder);
  if (uid == null) return { removed: false };
  await imapManager.removeMessageCopy(message.account_id, uid, labelFolder);
  return { removed: true };
}

// Ensure a set of label folders exist on the IMAP server, resolving each to its REAL server
// path (a prefixed namespace turns a bare 'Todo' into 'INBOX.Todo') and reporting whether this
// call created it. Returns one result per DEDUPED input path, in input order:
//   { folder, path, created }  on success  |  { folder, error: true }  on failure.
// A single folder's failure is isolated (logged, marked) so one bad name never aborts the rest.
// Core owns the IMAP mechanics; the caller owns any config persistence keyed off the results
// (e.g. recording where a relocated folder actually landed).
export async function ensureLabelFolders(imapManager, account, folderPaths) {
  const paths = [...new Set(folderPaths || [])];
  const results = [];
  for (const folder of paths) {
    try {
      const { path, created } = await imapManager.ensureFolder(account, folder, { resolvePath: true });
      results.push({ folder, path, created });
    } catch (err) {
      console.error(`ensureLabelFolders failed for ${folder}:`, err.message);
      results.push({ folder, error: true });
    }
  }
  return results;
}

// Mark DB copies read and await surviving per-copy STOREs before the caller archives.
// Excluded folders are stripped next and must not acquire retries. INBOX and the acted
// row stay best-effort because a move without UIDPLUS may invalidate their address.
// `error` reports DB/selection or best-effort failures; other failed pushes are queued.
// `pushedIds` contains confirmed STOREs only, for callers avoiding duplicate writes.
export async function markThreadRead(imapManager, account, message, { excludeFolders = [] } = {}) {
  const { rows } = await query(
    'SELECT id, uid, is_read FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false LIMIT 1',
    [message.account_id, 'INBOX', message.message_id]
  );
  const inboxCopy = rows[0] || null;
  const pushedIds = [];
  let error;
  try {
    const flipped = await fanOutReadToSiblings(message.account_id, message.message_id, true) || [];
    const perCopy = !imapManager.isLabelStore(account);
    let eligible = [];
    if (perCopy) {
      try { eligible = await readCopyTargets(message.account_id, message.message_id, message); }
      catch (err) { error = err; }
    }
    // INBOX is written without the copy check: Done archives inboxCopy either way.
    if (inboxCopy && !inboxCopy.is_read) {
      try {
        await imapManager.setFlag(account, inboxCopy.uid, 'INBOX', '\\Seen', true);
        pushedIds.push(inboxCopy.id);
      } catch (err) { error = err; }
    }
    if (perCopy) {
      const flippedIds = new Set(flipped.map(r => r.id));
      const copies = eligible.filter(r => flippedIds.has(r.id) && r.id !== inboxCopy?.id && !excludeFolders.includes(r.folder));
      const acted = copies.find(r => r.id === message.id);
      if (acted) {
        try {
          await imapManager.setFlag(account, acted.uid, acted.folder, '\\Seen', true);
          pushedIds.push(acted.id);
        } catch (err) { error ||= err; }
      }
      pushedIds.push(...await pushSeen(imapManager, account, message.account_id, copies.filter(r => r.id !== message.id), true));
    }
  } catch (err) { error ||= err; }
  return { inboxCopy, pushedIds, ...(error ? { error } : {}) };
}

// Best-effort \Seen on one copy, for when a copy other than INBOX is the durable one (GTD Done
// archiving a message's only copy, #524). The DB side is markThreadRead's fan-out; without the
// flag the next sync of the destination folder reads the copy back as unread. Never throws.
// `message` needs { uid, folder, is_read }.
export async function markCopySeen(imapManager, account, message) {
  if (message.is_read) return {};
  try {
    await imapManager.setFlag(account, message.uid, message.folder, '\\Seen', true);
  } catch (err) {
    return { error: err };
  }
  return {};
}
