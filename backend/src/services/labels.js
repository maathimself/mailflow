import { query } from './db.js';
import { snapshotFromMessageRow } from './messageSnapshots.js';

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
  return (await resolveLabelCopyRow(message, folder))?.uid ?? null;
}

async function resolveLabelCopyRow(message, folder) {
  if (message.folder === folder) return message;
  if (!message.message_id) return null;
  const { rows } = await query(
    `SELECT m.id, m.account_id, m.uid, m.folder, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                     AND f.is_present = true AND f.uid_validity IS NOT NULL
      WHERE m.account_id = $1 AND m.folder = $2 AND m.message_id = $3
        AND m.is_deleted = false AND m.metadata_complete = true
      ORDER BY m.id LIMIT 2`,
    [message.account_id, folder, message.message_id]
  );
  if (rows.length > 1) {
    const err = new Error(`More than one live copy exists in label folder ${folder}`);
    err.code = 'AMBIGUOUS_LABEL_COPY';
    throw err;
  }
  return rows[0] || null;
}

// Apply a label: ensure the label folder exists, then COPY the message into it (leaving the
// original in place). imapManager.copyMessage also emits the section-refresh event. No-op when
// the message already lives in the label folder. `message` needs { uid, folder }.
export async function applyLabel(imapManager, account, message, labelFolder, { operationKey } = {}) {
  if (message.folder === labelFolder) {
    return { applied: false, uid: message.uid, reason: 'already-there' };
  }
  const existingUid = await resolveLabelCopyUid(message, labelFolder);
  if (existingUid != null) {
    return { applied: false, uid: existingUid, reason: 'already-labelled' };
  }
  await imapManager.ensureFolder(account, labelFolder);
  const uid = await imapManager.copyMessage(account.id, message.uid, message.folder, labelFolder, {
    operationKey,
    snapshot: snapshotFromMessageRow(message),
  });
  return { applied: true, uid: uid ?? null };
}

// Remove one exact label copy only when it still carries the source message's RFC Message-ID.
// This is the safe inverse for a COPY whose destination UID was returned by UIDPLUS: a stale or
// forged UID cannot remove a different message's label copy. Without a Message-ID there is no
// stable identity shared by the source and copied rows, so no inverse is advertised.
export async function removeExactLabelCopy(imapManager, message, labelFolder, uid) {
  if (!message.message_id) return { removed: false };
  const { rows } = await query(
    `SELECT m.id, m.account_id, m.uid, m.folder, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                     AND f.is_present = true AND f.uid_validity IS NOT NULL
      WHERE m.account_id = $1 AND m.folder = $2 AND m.uid = $3
        AND m.message_id = $4 AND m.is_deleted = false AND m.metadata_complete = true
      LIMIT 1`,
    [message.account_id, labelFolder, uid, message.message_id]
  );
  if (!rows[0]) return { removed: false };
  return removeLabelRow(imapManager, rows[0]);
}

// Remove a label: delete the message's copy living in the label folder, leaving INBOX and any
// other labels intact. No-op when no such copy exists. `message` needs { account_id, uid,
// folder, message_id }.
export async function removeLabel(imapManager, message, labelFolder) {
  const row = await resolveLabelCopyRow(message, labelFolder);
  if (!row) return { removed: false };
  await imapManager.removeMessageCopy(message.account_id, row.uid, labelFolder, {
    expectedId: row.id,
    expectedUidValidity: row.folder_uid_validity,
    snapshot: snapshotFromMessageRow(row),
  });
  return { removed: true };
}

// Remove one concrete row from a label folder. Unlike removeLabel(), this never resolves through
// Message-ID: callers that already hold an authorized thread snapshot can delete every exact copy
// without an arbitrary LIMIT 1. The engine's expectedId option makes the DB half a CAS; rowCount 0
// is an idempotent concurrent completion, not an error. Batch callers suppress per-row plugin
// hooks and emit one terminal refresh themselves.
export async function removeLabelRow(imapManager, row, { notify = true } = {}) {
  const options = { expectedId: row.id, notify, snapshot: snapshotFromMessageRow(row) };
  if (Object.prototype.hasOwnProperty.call(row, 'folder_uid_validity')) {
    options.expectedUidValidity = row.folder_uid_validity;
  }
  const removed = await imapManager.removeMessageCopy(
    row.account_id,
    row.uid,
    row.folder,
    options,
  );
  return { removed: removed > 0, alreadyGone: removed === 0 };
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

// Mark an entire thread read by resolving every actionable sibling descriptively, then accepting
// an independent exact-row desired Seen delivery for each. The INBOX copy is returned so the
// caller can archive it afterward; a sibling failure is reported only after all rows were tried.
// `message` needs { account_id, message_id }.
export async function markThreadRead(imapManager, account, message) {
  const { rows } = await query(
    `SELECT m.id, m.account_id, m.uid, m.folder, m.is_read,
            m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                     AND f.is_present = true AND f.uid_validity IS NOT NULL
      WHERE m.account_id = $1 AND m.message_id = $2
        AND m.is_deleted = false AND m.metadata_complete = true
      ORDER BY m.id`,
    [message.account_id, message.message_id]
  );
  const inboxCopy = rows.find(row => row.folder === 'INBOX') || null;
  let firstError;
  for (const row of rows) {
    try {
      await imapManager.setDesiredFlag(account, row.id, '\\Seen', true, {
        snapshot: snapshotFromMessageRow(row),
      });
    } catch (err) {
      firstError ||= err;
    }
  }
  return firstError ? { inboxCopy, error: firstError } : { inboxCopy };
}

// Mark the exact authorized thread snapshot read before destructive mutations. The desired-flag
// service owns the atomic visible-state/count update and durable provider retry for each row.
export async function markThreadRowsRead(imapManager, account, rows) {
  const exactRows = [...new Map((rows || []).filter(row => row.id).map(row => [row.id, row])).values()];
  if (exactRows.length === 0) return { changedCount: 0, seenFailedCount: 0 };
  let changedCount = 0;
  let seenFailedCount = 0;
  const postSeenRows = [];
  // Confirm every snapshot copy, including rows already marked read locally. A previous request
  // may have queued a failed push under that row id; re-confirming here prevents destructive Done
  // from deleting/moving the retry identity before the server has accepted \Seen.
  for (const row of exactRows) {
    try {
      const outcome = await imapManager.setDesiredFlag(account, row.id, '\\Seen', true, {
        snapshot: snapshotFromMessageRow(row),
      });
      if (outcome?.changed) changedCount++;
      if (outcome?.delivery?.state !== 'confirmed') {
        const err = new Error(`Seen delivery for row ${row.id} is not confirmed`);
        err.code = 'DESIRED_SEEN_NOT_CONFIRMED';
        err.retryable = true;
        err.uncertain = true;
        throw err;
      }
      const revision = Number(outcome?.acceptance?.delivery?.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        const err = new Error(`Seen acceptance revision for row ${row.id} is unavailable`);
        err.code = 'DESIRED_SEEN_REVISION_UNAVAILABLE';
        err.retryable = true;
        throw err;
      }
      postSeenRows.push({ ...row, is_read: true, read_revision: revision });
    } catch (err) {
      if (err?.code === 'MESSAGE_SNAPSHOT_SUPERSEDED'
          || err?.code === 'MESSAGE_SNAPSHOT_NOT_ACTIONABLE'
          || err?.code === 'DESIRED_FLAG_ROW_SUPERSEDED') {
        err.retryable = false;
        throw err;
      }
      seenFailedCount++;
      console.warn(`GTD done: desired Seen delivery for row ${row.id} deferred:`, err.message);
    }
  }

  return postSeenRows.length > 0
    ? { changedCount, seenFailedCount, postSeenRows }
    : { changedCount, seenFailedCount };
}
