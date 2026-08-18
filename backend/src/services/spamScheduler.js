// Nightly full-retrain scheduler for the antispam classifier (v0.2) — V2-4.
//
// Runs every hour and retrains the "bucket" of users whose staggered offset
// matches the current UTC hour: offset_hours = hash(user_id) % 24 (design
// §7.2, fix v4). This spreads full retrains across 24 hours instead of a
// 00:00 UTC thundering herd.
//
// The per-user hash is stable, so a given user always retrains at the same
// hour (unless their account is created later).
//
// API (design §11.6): start() at boot, runFullRetrain() for the admin
// "retrain now" endpoint, stop() for tests.

import { retrainUser, getAllUsersWithTrainingLog } from './spamModelStore.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
let timer = null;
let bootTimer = null;

// Stable per-user offset: first 8 hex chars of the UUID (dashes stripped)
// interpreted as an integer, mod 24. UUIDs are random, so offsets are
// uniformly distributed.
export function offsetHoursForUser(userId) {
  const hex = String(userId).replace(/-/g, '').slice(0, 8);
  return parseInt(hex, 16) % 24;
}

/**
 * Retrain all users whose offset matches the given hour.
 *
 * @param {number} [hour] — UTC hour 0-23, defaults to now
 * @returns {{ usersProcessed: number, totalDuration_ms: number }}
 */
export async function runBucket(hour = new Date().getUTCHours()) {
  const userIds = await getAllUsersWithTrainingLog();
  const started = Date.now();
  let processed = 0;
  for (const userId of userIds) {
    if (offsetHoursForUser(userId) === hour) {
      try {
        await retrainUser(userId);
        processed += 1;
      } catch (err) {
        console.warn(`spam retrain failed for ${userId}:`, err.message);
      }
    }
  }
  return { usersProcessed: processed, totalDuration_ms: Date.now() - started };
}

/**
 * Trigger an immediate full retrain of every user with training data
 * (admin endpoint POST /api/spam/retrain-now).
 *
 * @returns {{ usersProcessed: number, totalDuration_ms: number }}
 */
export async function runFullRetrain() {
  const userIds = await getAllUsersWithTrainingLog();
  const started = Date.now();
  let processed = 0;
  for (const userId of userIds) {
    try {
      await retrainUser(userId);
      processed += 1;
    } catch (err) {
      console.warn(`spam retrain failed for ${userId}:`, err.message);
    }
  }
  return { usersProcessed: processed, totalDuration_ms: Date.now() - started };
}

/** Start the hourly scheduler (called once at server boot). */
export function start() {
  if (timer) return; // idempotent
  timer = setInterval(() => {
    runBucket().catch(err =>
      console.warn('spam scheduler bucket run failed:', err.message));
  }, CHECK_INTERVAL_MS);
  // Run the first bucket shortly after boot so freshly-created users are
  // picked up without waiting a full hour.
  bootTimer = setTimeout(() => {
    runBucket().catch(() => {});
  }, 5000);
  bootTimer.unref?.();
  console.log('Spam scheduler: hourly retrain job started (staggered by user hash)');
}

/** Stop the scheduler (tests / shutdown). */
export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

/** Export for tests that need to inject fake timers. */
export { CHECK_INTERVAL_MS };
