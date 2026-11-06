// Fixed-window rate limiter backed by the database (kvStore.js), so counters survive a
// restart within the window (they still reset on the window elapsing, which is the
// intended behaviour). Falls back to a per-process in-memory window if the database is
// unavailable, so auth never hard-fails on a database hiccup.

import { kv } from './kvStore.js';

// Fallback store, pruned periodically. Only used when the database errors.
const memory = new Map();
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of memory) if (now > b.resetAt) memory.delete(k);
}, 5 * 60 * 1000);
pruneTimer.unref?.();

// Count this hit against `key`. Returns { limited, resetMs }.
// `max` requests are allowed per `windowMs`; the (max+1)th is limited.
export async function consume(key, max, windowMs) {
  const rk = `rl:${key}`;
  try {
    const count = await kv.incr(rk);
    if (count === 1) {
      await kv.pExpire(rk, windowMs);
      return { limited: max < 1, resetMs: windowMs };
    }
    let ttl = await kv.pTTL(rk);
    if (ttl < 0) { await kv.pExpire(rk, windowMs); ttl = windowMs; } // key without TTL — re-arm
    return { limited: count > max, resetMs: ttl };
  } catch {
    const now = Date.now();
    const b = memory.get(key);
    if (!b || now > b.resetAt) {
      memory.set(key, { count: 1, resetAt: now + windowMs });
      return { limited: max < 1, resetMs: windowMs };
    }
    b.count++;
    return { limited: b.count > max, resetMs: b.resetAt - now };
  }
}

// Clear a key's counter (e.g. after a successful login).
export async function reset(key) {
  try { await kv.del(`rl:${key}`); } catch { /* best effort */ }
  memory.delete(key);
}

// Hand back one hit that consume() counted (e.g. once a CardDAV password checks out).
export async function release(key) {
  const rk = `rl:${key}`;
  try {
    const count = await kv.decr(rk);
    // DECR on a key that expired mid-request recreates it at -1, which is a free extra hit.
    if (count < 0) await kv.del(rk);
  } catch {
    const b = memory.get(key);
    if (b && b.count > 0) b.count--;
  }
}
