import { query } from './db.js';

// When each user last used the app, shown to admins in the Users list. A session rolls for
// days after its last request, so the last login says little about whether an account is in
// use; this says when it was last used.
//
// requireAuth runs on every authenticated request, and a database write on each would be one
// per API call. The timestamp is written at most once per WRITE_EVERY_MS per user, and the
// skipped requests cost a Map lookup.
export const WRITE_EVERY_MS = 5 * 60 * 1000;
const lastWritten = new Map();

export function touchLastSeen(userId, { now = Date.now(), write = query } = {}) {
  if (!userId) return;
  const previous = lastWritten.get(userId);
  if (previous !== undefined && now - previous < WRITE_EVERY_MS) return;
  lastWritten.set(userId, now);
  Promise.resolve()
    .then(() => write('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]))
    .catch(err => {
      // Let the next request try again rather than wait out the interval.
      lastWritten.delete(userId);
      console.warn('[lastSeen] could not record activity:', err.message);
    });
}

export function resetLastSeenForTests() {
  lastWritten.clear();
}
