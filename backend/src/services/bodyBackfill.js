import { query } from './db.js';
import { providerProfile } from './imapManager.js';

// Body-materialization drainer. Fills messages.body_text/body_html over IMAP so weight-D
// lexical search has material to work with, WITHOUT growing the imapManager
// singleton (README invariant) and WITHOUT touching throttle-hostile providers. ALL policy —
// the scan predicate, batching, pacing, provider gating, session cap, quiet-window
// backpressure, and the per-account circuit breaker — lives here. The singleton exposes only
// the narrow fetchBodiesForMessages() entry point this module calls.
//
// Shape is copied from imapManager.startSnippetIndexer, but this module is standalone: its
// per-account run guard and circuit-breaker state are module-level (not instance fields), and
// its IMAP/quiet-window/progress/clock dependencies are injected so it unit-tests against a
// fake fetchBodies with no real IMAP.

const BATCH_SIZE = 50;              // messages fetched per batch
const MIN_BATCH_DELAY_MS = 2000;    // floor between batches (provider batchDelay may raise it)
const MAX_BATCHES_PER_RUN = 200;    // session cap: 10,000 messages per run, then resume next kick
const QUIET_WINDOW_MS = 8000;       // pause extra when the user opened a message this recently
const MAX_CONSECUTIVE_ERRORS = 3;   // abort the run after this many failing batches in a row
const BACKOFF_BASE_MS = 10 * 60 * 1000;    // first circuit-breaker back-off
const BACKOFF_MAX_MS = 2 * 60 * 60 * 1000; // cap

// Per-account run guard and circuit breaker. Module-level so a single process runs at most one
// body drainer per account (the snippet indexer uses instance fields for the same purpose).
const running = new Set();          // accountId
const backoff = new Map();          // accountId -> { failures, until }

// Test seam: reset module state between unit tests.
export function resetBodyBackfillState() {
  running.clear();
  backoff.clear();
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Core drainer. Dependencies are injected so tests supply a fake fetchBodies:
//   fetchBodies(accountId, ids)  -> Promise<{ fetched: number }>  (writes bodies; throws on a
//                                   connection-level failure so this loop can back off)
//   getLastActivityMs(accountId) -> number   (ms timestamp of the user's last live body open)
//   isSnippetIndexerRunning(accountId) -> boolean  (the snippet indexer does its own sustained
//                                   BODY[]-ish fetches over an independent connection; running
//                                   both loops for the same account at once double-books IMAP
//                                   connections against the same provider limit)
//   upsertJobProgress({ accountId, kind, processed, total, state }) -> Promise  (this is
//                                   backgroundJobs.upsertJob's own shape — callers inject it
//                                   directly; the drainer speaks its vocabulary, no adapter)
//   sleep(ms) -> Promise    (injectable for fast, deterministic tests)
//   now() -> number         (injectable clock)
export async function startBodyBackfill(account, deps) {
  const {
    fetchBodies,
    getLastActivityMs = () => 0,
    isSnippetIndexerRunning = () => false,
    upsertJobProgress = async () => {},
    sleep = realSleep,
    now = Date.now,
  } = deps;

  const cfg = providerProfile(account);
  if (!cfg.bodyBackfill) return;                    // provider gate (Gmail/PurelyMail/etc.)
  if (running.has(account.id)) return;              // one drainer per account
  const bo = backoff.get(account.id);
  if (bo && now() < bo.until) return;               // circuit breaker open
  running.add(account.id);

  const batchDelay = Math.max(cfg.batchDelay || 0, MIN_BATCH_DELAY_MS);
  const kind = 'body_backfill';
  let batchCount = 0;
  let failed = false;

  try {
    // Denominator + starting coverage for progress. total is the whole eligible mailbox so the
    // progress bar reflects real coverage, not just this run.
    const countRes = await query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE body_text IS NOT NULL OR body_html IS NOT NULL)::int AS have_body
       FROM messages WHERE account_id = $1 AND is_deleted = false`,
      [account.id]
    );
    const total = countRes.rows[0].total;
    let haveBody = countRes.rows[0].have_body;
    if (total - haveBody <= 0) {
      await upsertJobProgress({ accountId: account.id, kind, processed: haveBody, total, state: 'done' });
      return;
    }

    // Keyset by id ascending: id is a non-null, unique UUID, so the cursor advances past every
    // row exactly once per run — including rows whose body cannot be fetched (they stay NULL but
    // are not re-selected this run, so the run always terminates). Recency ordering is
    // intentionally not used: body coverage is a background quality lever.
    let cursorId = null;
    let consecutiveErrors = 0;

    while (true) {
      // Stop if the account was deleted mid-run.
      const alive = await query('SELECT id FROM email_accounts WHERE id = $1', [account.id]);
      if (!alive.rows.length) return;

      // Defer to the snippet indexer rather than double-book BODY[] IMAP connections for the
      // same account — checked every iteration (not just at kick time) so a session already in
      // progress backs off cleanly the moment the indexer starts, instead of racing it.
      if (isSnippetIndexerRunning(account.id)) {
        await upsertJobProgress({ accountId: account.id, kind, processed: haveBody, total, state: 'deferred' });
        return;
      }

      if (batchCount >= MAX_BATCHES_PER_RUN) {
        await upsertJobProgress({ accountId: account.id, kind, processed: haveBody, total, state: 'paused' });
        return;
      }

      const batchRes = await query(
        `SELECT id FROM messages
         WHERE account_id = $1 AND body_text IS NULL AND body_html IS NULL AND is_deleted = false
           AND ($2::uuid IS NULL OR id > $2)
         ORDER BY id ASC
         LIMIT $3`,
        [account.id, cursorId, BATCH_SIZE]
      );
      if (!batchRes.rows.length) break; // drained
      const ids = batchRes.rows.map((r) => r.id);

      try {
        const { fetched } = await fetchBodies(account.id, ids);
        haveBody += fetched;
        cursorId = ids[ids.length - 1]; // advance only on success
        batchCount++;
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors++;
        await sleep(cfg.errorDelay || batchDelay);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          failed = true;
          // Write a terminal 'error' state (ftsBackfill.js convention) so background_jobs
          // doesn't keep showing a stale 'running' row for an account that's actually stalled.
          await upsertJobProgress({ accountId: account.id, kind, processed: haveBody, total, state: 'error' });
          return; // finally trips the circuit breaker
        }
        continue; // retry the same batch (cursor not advanced); fetchBodies reopens IMAP
      }

      await upsertJobProgress({ accountId: account.id, kind, processed: haveBody, total, state: 'running' });

      // Quiet-window backpressure: pause longer when the user is actively opening messages so
      // background BODY[] traffic doesn't compete with click-time fetches.
      const quietFor = now() - getLastActivityMs(account.id);
      const extraDelay = quietFor < QUIET_WINDOW_MS ? QUIET_WINDOW_MS - quietFor : 0;
      await sleep(batchDelay + extraDelay);
    }

    await upsertJobProgress({ accountId: account.id, kind, processed: haveBody, total, state: 'done' });
  } catch {
    failed = true;
  } finally {
    running.delete(account.id);
    // Circuit breaker: a run that failed without draining a single batch (e.g. the provider
    // refuses the extra connection) backs off exponentially so we stop reopening competing IMAP
    // connections. Any progress — or a clean finish — clears the backoff.
    if (failed && batchCount === 0) {
      const failures = (backoff.get(account.id)?.failures || 0) + 1;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      backoff.set(account.id, { failures, until: now() + delay });
    } else {
      backoff.delete(account.id);
    }
  }
}

// Convenience wrapper for the reindex route: builds the injected deps from the imapManager
// singleton and the injected progress sink (backgroundJobs.upsertJob — the drainer already
// emits its shape), then runs the core drainer. Kept here (not in the route) so the wiring is
// unit-testable and bodyBackfill.js never imports backgroundJobs.js directly.
export function startAccountBodyBackfill(account, imapManager, upsertJobProgress) {
  return startBodyBackfill(account, {
    fetchBodies: (accountId, ids) => imapManager.fetchBodiesForMessages(accountId, ids),
    getLastActivityMs: (accountId) => imapManager.lastUserActivity.get(accountId) || 0,
    isSnippetIndexerRunning: (accountId) => imapManager.snippetIndexerRunning.has(accountId),
    upsertJobProgress,
  });
}
