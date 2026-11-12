import { api } from './api.js';

// A launch needs the session, the preferences and the accounts before it can ask for a message
// list. Asked one after another, each waits a full round trip, which on a phone waking from idle
// (a new connection through the reverse proxy) is what makes a cold launch slow. The preferences
// and accounts are asked for at the same time as the session instead, and used once the session
// is confirmed. Quietly: a refusal here (signed out, screen locked) raises no session or lock
// event, and whoever takes a failed answer asks again the usual way, so every error path is the
// one it was before.

// An answer older than this is not used: a launch that stopped at the lock screen or sign-in
// asks again rather than show what the server said before.
const MAX_AGE_MS = 15_000;

let started = false;
let pending = null;

export function startBootPrefetch() {
  if (started) return;
  started = true;
  const quiet = (p) => { p.catch(() => {}); return p; };
  pending = {
    at: Date.now(),
    preferences: quiet(api.getPreferences({ quiet: true })),
    accounts: quiet(api.getAccounts({ quiet: true })),
  };
}

// The prefetched answer for `key`, once, while fresh; otherwise null.
export function takeBootPrefetch(key) {
  if (!pending || !pending[key]) return null;
  const answer = pending[key];
  pending[key] = null;
  return Date.now() - pending.at <= MAX_AGE_MS ? answer : null;
}

// The session was not confirmed (signed out, locked): nothing prefetched is used.
export function discardBootPrefetch() {
  pending = null;
}

// The answer prefetched for `key`, or `load()` when there is none or it failed.
export function prefetchedOr(key, load) {
  const answer = takeBootPrefetch(key);
  return answer ? answer.catch(() => load()) : load();
}

// Tests only.
export function resetBootPrefetchForTests() {
  started = false;
  pending = null;
}
