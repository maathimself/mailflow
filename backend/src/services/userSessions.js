import { redisClient } from './redis.js';

// Delete every server-side session belonging to a user (Redis-backed store, keys
// prefixed "sess:"), so a pre-existing session can't outlive a credential change.
// `exceptSessionId` keeps one session alive: an admin who resets their own password
// from the Users list stays signed in on the page they did it from. Best-effort —
// never throws to the caller.
export async function destroyUserSessions(userId, { exceptSessionId } = {}) {
  const keep = exceptSessionId ? `sess:${exceptSessionId}` : null;
  try {
    let cursor = 0;
    do {
      const res = await redisClient.scan(cursor, { MATCH: 'sess:*', COUNT: 200 });
      cursor = res.cursor;
      for (const key of res.keys) {
        if (key === keep) continue;
        const raw = await redisClient.get(key);
        if (!raw) continue;
        try { if (JSON.parse(raw).userId === userId) await redisClient.del(key); } catch { /* not this user / unparsable */ }
      }
    } while (cursor !== 0);
  } catch (err) {
    console.error('destroyUserSessions failed:', err.message);
  }
}
