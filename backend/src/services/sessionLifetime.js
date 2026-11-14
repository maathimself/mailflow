import { query } from './db.js';
import { SESSION_IDLE_MS } from '../utils/sessionConfig.js';

// How long a sign-in lasts without use is each user's choice (D#400): one of these days, or the
// server's default (SESSION_IDLE_DAYS, 7 unless set) when they have not chosen. Stored in the
// user's preferences as `sessionDays`, where 0 or absent means the default.
export const SESSION_DAY_CHOICES = [7, 14, 30, 60, 90];
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_DAYS = SESSION_IDLE_MS / DAY_MS;

// The value to store for `sessionDays` from a request: a choice, 0 for the default, or null for
// anything else (left unchanged, as other preferences treat values they do not know).
export function parseSessionDays(value) {
  if (value === 0 || value === '0' || value === '') return 0;
  const days = Number(value);
  return Number.isInteger(days) && SESSION_DAY_CHOICES.includes(days) ? days : null;
}

export function sessionLifetimeMs(days) {
  return SESSION_DAY_CHOICES.includes(days) ? days * DAY_MS : SESSION_IDLE_MS;
}

// userId -> { days, at }. Read on every signed-in request, so the choice is cached rather than
// queried each time; a change through PATCH /preferences updates it at once.
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 10000;
const cache = new Map();

export function rememberSessionDays(userId, days) {
  const key = String(userId);
  cache.delete(key);
  cache.set(key, { days, at: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function sessionDaysFor(userId) {
  const hit = cache.get(String(userId));
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.days;
  const { rows } = await query("SELECT preferences->>'sessionDays' AS days FROM users WHERE id = $1", [userId]);
  const days = parseSessionDays(rows[0]?.days) ?? 0;
  rememberSessionDays(userId, days);
  return days;
}

// Sets the session cookie's lifetime to the signed-in user's choice. express-session re-sends the
// cookie on every response (`rolling`), so the browser's copy and the stored session's expiry
// both follow it from this request on, on every device, whichever way the user signed in. A
// failed lookup keeps the session's current lifetime rather than failing the request.
export async function applySessionLifetime(req, _res, next) {
  const userId = req.session?.userId;
  if (!userId || req.apiToken || !req.session.cookie) return next();
  try {
    req.session.cookie.maxAge = sessionLifetimeMs(await sessionDaysFor(userId));
  } catch {
    // keep the current lifetime
  }
  next();
}

// For tests.
export function _resetSessionLifetimeCache() {
  cache.clear();
}
