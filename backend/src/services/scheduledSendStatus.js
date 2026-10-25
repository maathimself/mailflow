import { query } from './db.js';

// What the diagnostics report says about scheduled send (design 3.3): when the sender last
// ticked, and the user's scheduled messages counted by status, with how long the oldest due one
// has waited. Counts only, nothing of any message. Kept apart from scheduledSend.js so the
// report does not load the send pipeline.

let lastTickAt = null;

export function noteTick(at) {
  lastTickAt = at;
}

export async function scheduledSendReport(userId) {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count,
            MAX(EXTRACT(EPOCH FROM NOW() - due_at)) FILTER (WHERE status = 'scheduled' AND due_at < NOW()) AS oldest_due_seconds
       FROM scheduled_messages WHERE user_id = $1 GROUP BY status`,
    [userId],
  );
  const counts = {};
  let oldest = null;
  for (const r of rows) {
    if (typeof r.status !== 'string') continue;
    counts[r.status] = Number(r.count) || 0;
    if (r.oldest_due_seconds != null) oldest = Number(r.oldest_due_seconds);
  }
  return {
    lastTickAgeSeconds: lastTickAt ? Math.round((Date.now() - lastTickAt.getTime()) / 1000) : null,
    counts,
    oldestOverdueMinutes: oldest == null ? null : Math.floor(oldest / 60),
  };
}
