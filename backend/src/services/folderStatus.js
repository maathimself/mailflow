import { query } from './db.js';

export const STATUS_INTERVAL_MS = 60000;
// INBOX plus (BATCH - 1) rotating folders per cycle. The monitor query's LIMIT is bound from
// this same constant so the poll width and the freshness maths can never drift apart.
export const STATUS_FOLDER_BATCH = 6;
// Freshness allowance for a folder polled EVERY cycle, i.e. INBOX and the account totals
// derived from it. Three cycles of slack.
export const STATUS_STALE_MS = 180000;

// A non-INBOX folder is only visited once per rotation, so a fixed allowance marks perfectly
// healthy folders stale the moment an account grows past the batch size. Measured on a
// 16-folder account: worst-case observation age 178-181s against a fixed 180s threshold, which
// produced false stale markers in normal operation. Derive the allowance from the rotation the
// monitor actually performs instead, with 50% slack for a cycle that runs long.
export function folderStaleMs(selectableFolders) {
  const rotating = Math.max(1, STATUS_FOLDER_BATCH - 1);   // INBOX is pinned, the rest rotate
  const others = Math.max(0, (Number(selectableFolders) || 0) - 1);
  const cycles = Math.max(1, Math.ceil(others / rotating));
  return Math.max(STATUS_STALE_MS, cycles * STATUS_INTERVAL_MS * 1.5);
}
export const STATUS_QUERY = { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: true };

export function validFolderStatus(s) {
  return !!s && Number.isSafeInteger(s.messages) && s.messages >= 0 &&
    Number.isSafeInteger(s.unseen) && s.unseen >= 0 && s.unseen <= s.messages &&
    Number.isSafeInteger(s.uidNext) && s.uidNext > 0 &&
    /^(?:[1-9][0-9]*)$/.test(String(s.uidValidity));
}

export function folderNeedsSync(row, s, now = Date.now()) {
  if (!row.status_synced_at) return true;
  if (String(row.status_synced_uid_validity) !== String(s.uidValidity)) return true;
  if (Number(row.status_synced_uid_next) !== s.uidNext) return true;
  if (Number(row.cached_total) !== s.messages || Number(row.cached_unread) !== s.unseen) return true;
  if (s.highestModseq != null && String(row.status_synced_modseq) !== String(s.highestModseq)) return true;
  // UIDNEXT cannot detect expunges/flags, and equal counts cannot prove equal UID sets.
  // Periodically verify membership even with CONDSTORE (repairs old cache holes too).
  return now - new Date(row.status_synced_at).getTime() >= 15 * 60000;
}

export async function observeFolder(client, accountId, path) {
  // Allocate before network I/O. A slower old request must never replace a newer sample.
  const { rows: [sample] } = await query("SELECT nextval('folder_status_revision')::text AS revision, clock_timestamp() AS started_at");
  let timer;
  try {
    const status = await Promise.race([
      client.status(path, STATUS_QUERY),
      new Promise((_, reject) => { timer = setTimeout(() => {
        try { client.close(); } catch { /* already closed */ }
        reject(new Error('Folder STATUS timed out'));
      }, 10000); }),
    ]);
    if (!validFolderStatus(status)) throw new Error('Incomplete folder STATUS response');
    const { rows } = await query(`
      UPDATE folders SET server_total_count=$3, server_unread_count=$4,
        server_uid_next=$5, server_uid_validity=$6, server_highest_modseq=$7,
        server_counts_at=$8, server_count_revision=$9, status_attempt_revision=$9,
        status_attempted_at=NOW(), status_error=NULL
      WHERE account_id=$1 AND path=$2
        AND (status_attempt_revision IS NULL OR status_attempt_revision < $9)
      RETURNING id`, [accountId, path, status.messages, status.unseen, status.uidNext,
      String(status.uidValidity), status.highestModseq == null ? null : String(status.highestModseq), sample.started_at, sample.revision]);
    return rows.length ? status : null;
  } catch (err) {
    // Never turn an unavailable mailbox into an empty one or erase the last good sample.
    await query(`UPDATE folders SET status_attempt_revision=$3, status_attempted_at=NOW(), status_error=$4
      WHERE account_id=$1 AND path=$2 AND (status_attempt_revision IS NULL OR status_attempt_revision < $3)`,
    [accountId, path, sample.revision, String(err.message).slice(0, 300)]);
    throw err;
  } finally { clearTimeout(timer); }
}

export async function checkpointFolderStatus(accountId, path, status) {
  // Only the completed ingestion/reconciliation callback calls this; STATUS itself never does.
  await query(`UPDATE folders SET status_synced_uid_next=$3, status_synced_uid_validity=$4,
    status_synced_modseq=$5, status_synced_at=NOW() WHERE account_id=$1 AND path=$2 AND uid_validity=$4`,
  [accountId, path, status.uidNext, String(status.uidValidity),
    status.highestModseq == null ? null : String(status.highestModseq)]);
}

export class FolderStatusMonitor {
  constructor({ withClient, enqueueSync, broadcast }) {
    this.withClient = withClient;
    this.enqueueSync = enqueueSync;
    this.broadcast = broadcast;
    this.running = new Map();
    this.nextCheck = new Map();
    this.failures = new Map();
  }
  refresh(account, { force = false } = {}) {
    if (this.running.has(account.id)) return this.running.get(account.id);
    if (!force && Date.now() < (this.nextCheck.get(account.id) || 0)) return Promise.resolve();
    // Even mutation-driven refreshes have a minimum interval; no connection storm on bulk reads.
    if (force && Date.now() < (this.nextCheck.get(account.id) || 0) - STATUS_INTERVAL_MS + 5000) return Promise.resolve();
    const task = this._refresh(account).finally(() => this.running.delete(account.id));
    this.running.set(account.id, task);
    return task;
  }
  async _refresh(account) {
    this.nextCheck.set(account.id, Date.now() + STATUS_INTERVAL_MS);
    let any = false, failed = false;
    try {
      const { rows } = await query(`SELECT f.*,
        (SELECT count(*) FROM messages m WHERE m.account_id=f.account_id AND m.folder=f.path AND NOT m.is_deleted) AS cached_total,
        (SELECT count(*) FROM messages m WHERE m.account_id=f.account_id AND m.folder=f.path AND NOT m.is_deleted AND NOT m.is_read) AS cached_unread
        FROM folders f WHERE f.account_id=$1 AND NOT f.no_select
        ORDER BY (f.path='INBOX') DESC, f.status_attempted_at ASC NULLS FIRST, f.path LIMIT $2`, [account.id, STATUS_FOLDER_BATCH]);
      if (!rows.length) return;
      const changed = [];
      // This connection stays AUTHENTICATED: no selected mailbox, no interference with IDLE.
      await this.withClient(account, async client => {
        for (const row of rows) {
          try {
            const status = await observeFolder(client, account.id, row.path);
            if (!status) continue;
            any = true;
            if (folderNeedsSync(row, status)) changed.push({ row, status });
          } catch (err) {
            failed = true;
            console.warn(`Folder status check failed for account ${account.id}: ${err.message}`);
            // A timed-out command destroys this connection; later folders wait for next cycle.
            if (!client.usable) break;
          }
        }
      });
      // Close the status transport BEFORE starting potentially long ingestion work.
      let queued = 0;
      // Failed ingestion must remain retryable without monopolizing the account.
      // An attempt is separate from a successful checkpoint and is used only for fairness.
      changed.sort((a, b) => {
        const mismatch = item => Number(item.row.cached_total) !== item.status.messages || Number(item.row.cached_unread) !== item.status.unseen;
        // Repair a measured deficit before spending the first pass on unchanged empty
        // folders. Within each priority, rotate attempts; per-folder backoff prevents starvation.
        return Number(mismatch(b)) - Number(mismatch(a)) ||
          new Date(a.row.status_sync_attempted_at || 0) - new Date(b.row.status_sync_attempted_at || 0);
      });
      for (const item of changed) {
        if (queued >= 2) break;
        if (this.enqueueSync(account, item.row.path, item.status)) queued++;
      }
      if (failed) throw new Error('One or more folder status checks failed');
      this.failures.delete(account.id);
    } catch (err) {
      const failures = (this.failures.get(account.id) || 0) + 1;
      this.failures.set(account.id, failures);
      this.nextCheck.set(account.id, Date.now() + Math.min(600000, STATUS_INTERVAL_MS * 2 ** Math.min(failures - 1, 4)));
      console.warn(`Folder status cycle failed for account ${account.id}: ${err.message}`);
    } finally {
      if (any || failed) this.broadcast({ type: 'folder_counts', accountId: account.id }, account.user_id);
    }
  }
}

export function publicFolderCounts(row, now = Date.now(), { selectableFolders = 0 } = {}) {
  const known = row.server_counts_at != null && row.server_total_count != null && row.server_unread_count != null;
  // INBOX is polled every cycle; everything else waits its turn in the rotation.
  const staleMs = row.path === 'INBOX' ? STATUS_STALE_MS : folderStaleMs(selectableFolders);
  return { ...row, cached_total_count: row.total_count, cached_unread_count: row.unread_count,
    total_count: known ? Number(row.server_total_count) : null,
    unread_count: known ? Number(row.server_unread_count) : null,
    counts_known: known,
    counts_stale: !known || !!row.status_error || now - new Date(row.server_counts_at).getTime() > staleMs };
}
