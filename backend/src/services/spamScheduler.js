// Hourly full-retrain scheduler for the antispam classifier (v0.2) — V2-4.
//
// Runs every hour and retrains the "bucket" of users whose staggered offset
// matches the current UTC hour: offset_hours = hash(user_id) % 24 (design
// §7.2, fix v4). This spreads full retrains across 24 hours instead of a
// 00:00 UTC thundering herd.
//
// The per-user hash is stable, so a given user always retrains at the same
// hour (unless their account is created later).
//
// Re-entrancy (PR review, 2026-09-15): a run walks its users SEQUENTIALLY and each
// user costs DB work, so one slow user — or simply a large user base — can outlast
// the hourly interval. Two consequences used to be possible: setInterval started a
// second bucket on top of the running one, and the admin "retrain now" button could
// start a full retrain concurrently with either. Both write the same spam_models
// rows and multiply the DB load, and a full retrain already covers every user the
// hourly bucket would touch. So:
//   - one run at a time, published as `activeRun` for the whole duration (the
//     single-flight shape FolderStatusMonitor.refresh uses);
//   - the hourly tick is armed only AFTER the current run settles (a self-scheduling
//     timeout, not setInterval), so a slow run delays the next tick instead of
//     overlapping it;
//   - each user gets a bounded slice of the run, so one pathological user cannot
//     monopolize it;
//   - an overlapping run is REFUSED, not queued — runBucket skips the hour and
//     runFullRetrain reports it, which the admin endpoint surfaces as 409.
//
// API (design §11.6): start() at boot, runFullRetrain() for the admin
// "retrain now" endpoint, stop() for tests.

import { retrainUser, getAllUsersWithTrainingLog } from './spamModelStore.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
// First bucket shortly after boot so freshly-created users are picked up without
// waiting a full hour.
const BOOT_DELAY_MS = 5000;

// Ceiling on ONE user's retrain. The queries are already bounded by the pool's
// statement_timeout (30s, see db.js), so this bounds the JS-side await only: heavy
// aggregation over a large vocabulary, or a saturated DB. A user who exceeds it is
// counted and skipped — the run keeps going and still finishes before the next tick.
export const RETRAIN_USER_TIMEOUT_MS = 60 * 1000;

const RUN_TIMEOUT_MARKER = 'retrain_timed_out';

let timer = null;
let stopped = true;
// The single in-flight run: { kind: 'bucket' | 'full', promise } or null.
let activeRun = null;

/** True while a bucket or a full retrain is running (single-flight guard state). */
export function isRunning() {
  return activeRun !== null;
}

// Stable per-user offset: first 8 hex chars of the UUID (dashes stripped)
// interpreted as an integer, mod 24. UUIDs are random, so offsets are
// uniformly distributed.
export function offsetHoursForUser(userId) {
  const hex = String(userId).replace(/-/g, '').slice(0, 8);
  return parseInt(hex, 16) % 24;
}

/**
 * Retrain one user inside its slice of the run.
 *
 * @returns {Promise<'ok'|'timeout'|'error'>} the outcome, for the run counters
 */
async function retrainWithTimeout(userId) {
  let timer = null;
  try {
    await Promise.race([
      retrainUser(userId),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(RUN_TIMEOUT_MARKER)),
          RETRAIN_USER_TIMEOUT_MS,
        );
      }),
    ]);
    return 'ok';
  } catch (err) {
    const timedOut = err.message === RUN_TIMEOUT_MARKER;
    console.warn(`spam retrain ${timedOut ? 'timed out' : 'failed'} for ${userId}:`,
      timedOut ? `no result within ${RETRAIN_USER_TIMEOUT_MS}ms` : err.message);
    // An abandoned retrain may still finish and persist its model. It computes the
    // same model from the same rows, so that write is harmless — we only stop waiting.
    return timedOut ? 'timeout' : 'error';
  } finally {
    clearTimeout(timer);
  }
}

async function retrainUsers(userIds) {
  const started = Date.now();
  let processed = 0;
  let timedOut = 0;
  for (const userId of userIds) {
    const outcome = await retrainWithTimeout(userId);
    if (outcome === 'ok') processed += 1;
    if (outcome === 'timeout') timedOut += 1;
  }
  return { usersProcessed: processed, usersTimedOut: timedOut, totalDuration_ms: Date.now() - started };
}

// Publish the run for its whole duration so a second entry point is refused instead
// of interleaving with it.
function runExclusive(kind, fn) {
  const promise = fn();
  activeRun = { kind, promise };
  return promise.finally(() => {
    if (activeRun?.promise === promise) activeRun = null;
  });
}

/**
 * Retrain all users whose offset matches the given hour.
 *
 * @param {number} [hour] — UTC hour 0-23, defaults to now
 * @returns {{ usersProcessed: number, usersTimedOut: number, totalDuration_ms: number,
 *             skipped?: string }}
 */
export async function runBucket(hour = new Date().getUTCHours()) {
  if (activeRun) {
    // Skipped, not queued: the next tick picks this bucket up anyway (the offset is
    // stable), and queueing would only push a second run further behind the clock.
    console.warn(`Spam scheduler: ${activeRun.kind} retrain already in progress — skipping this bucket`);
    return { usersProcessed: 0, usersTimedOut: 0, totalDuration_ms: 0, skipped: 'already_running' };
  }
  return runExclusive('bucket', async () => {
    const userIds = await getAllUsersWithTrainingLog();
    return retrainUsers(userIds.filter(userId => offsetHoursForUser(userId) === hour));
  });
}

/**
 * Trigger an immediate full retrain of every user with training data
 * (admin endpoint POST /api/spam/retrain-now).
 *
 * @returns {{ ok: boolean, usersProcessed: number, usersTimedOut: number,
 *             totalDuration_ms: number, reason?: string, runningKind?: string }}
 */
export async function runFullRetrain() {
  if (activeRun) {
    // Refused, not queued: the run in flight already covers every user, so a second
    // one would only duplicate its work. The route turns this into a 409.
    console.warn(`Spam scheduler: ${activeRun.kind} retrain already in progress — refusing a full retrain`);
    return {
      ok: false,
      reason: 'already_running',
      runningKind: activeRun.kind,
      usersProcessed: 0,
      usersTimedOut: 0,
      totalDuration_ms: 0,
    };
  }
  return runExclusive('full', async () => ({
    ok: true,
    ...(await retrainUsers(await getAllUsersWithTrainingLog())),
  }));
}

/** Start the hourly scheduler (called once at server boot). */
export function start() {
  if (!stopped) return; // idempotent
  stopped = false;
  scheduleNext(BOOT_DELAY_MS);
  console.log('Spam scheduler: hourly retrain job started (staggered by user hash)');
}

function scheduleNext(delayMs) {
  timer = setTimeout(async () => {
    timer = null;
    try {
      await runBucket();
    } catch (err) {
      console.warn('spam scheduler bucket run failed:', err.message);
    }
    // Armed only now, i.e. after the run settled: a slow bucket delays the next tick
    // rather than overlapping it.
    if (!stopped) scheduleNext(CHECK_INTERVAL_MS);
  }, delayMs);
  timer.unref?.();
}

/** Stop the scheduler (tests / shutdown). */
export function stop() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Export for tests that need to inject fake timers. */
export { CHECK_INTERVAL_MS, BOOT_DELAY_MS };
