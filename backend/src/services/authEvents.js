import { query } from './db.js';

// Prune records older than 90 days once per hour so the table stays bounded.
setInterval(() => {
  query("DELETE FROM auth_events WHERE created_at < NOW() - INTERVAL '90 days'")
    .catch(err => console.error('[auth] Failed to prune auth events:', err.message));
}, 60 * 60 * 1000);

// Fire-and-forget audit log write. Never throws — a logging failure must
// not block or crash authentication flows. username/userId are the account the event is
// about; actorUsername is the admin who made a change to it, for admin actions.
export function logAuthEvent(eventType, { username = null, userId = null, actorUsername = null, ip, success }) {
  query(
    `INSERT INTO auth_events (event_type, username, user_id, actor_username, ip, success)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [eventType, username || null, userId || null, actorUsername || null, ip || null, success]
  ).catch(err => console.error('[auth] Failed to log event:', err.message));
}
