// When to pull a folder from IMAP as the user moves around the mailbox.
//
// The background sync only ever polls INBOX, and so does the manual "sync now" button.
// Every other folder was populated once at backfill and then left alone, so anything that
// arrived from outside MailFlow was invisible indefinitely: mail sent from another client
// landing in Sent, messages filed from a phone, server-side rules moving things. The
// on-open sync that did exist only fired for a folder with NO local messages, so a folder
// went permanently stale the moment it held one.
//
// Syncing on every open fixes that but cannot be done unconditionally: a completed sync
// broadcasts sync_complete, which the client turns into mailflow:refresh, which re-runs the
// very effect that triggered the sync. Without the interval below that is an unbounded
// loop, so this guard is load-bearing rather than a politeness measure.

/** Minimum gap between IMAP pulls of the same folder. Also what breaks the refresh loop. */
export const FOLDER_SYNC_MIN_INTERVAL_MS = 30_000;

/**
 * Should this folder be pulled from IMAP right now?
 *
 * INBOX is excluded because it is already covered by IDLE and the short poll, so syncing it
 * here would double the work and add nothing. The unified inbox is excluded because it is
 * not a single folder on a single account and has no on-demand equivalent.
 *
 * `force` is for an explicit user action ("sync now"), which should refresh the folder being
 * looked at even if it was pulled moments ago. It deliberately still respects the INBOX and
 * unified-inbox exclusions, which are about applicability rather than rate.
 */
export function shouldSyncFolder({
  accountId = null,
  folder = null,
  lastSyncedAt = null,
  now = Date.now(),
  minIntervalMs = FOLDER_SYNC_MIN_INTERVAL_MS,
  force = false,
} = {}) {
  if (!accountId) return false;                 // unified inbox: nothing single to sync
  if (!folder || folder === 'INBOX') return false;  // IDLE and the poll already cover it
  if (force) return true;
  if (!Number.isFinite(lastSyncedAt)) return true;  // never pulled, or an unusable record
  if (!Number.isFinite(now)) return true;
  return now - lastSyncedAt >= minIntervalMs;
}

/** Key a folder is tracked under. Account-scoped: the same folder name exists on many. */
export function folderSyncKey(accountId, folder) {
  return `${accountId}:${folder}`;
}
