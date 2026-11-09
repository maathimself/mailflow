import { query } from './db.js';
import { imapManager } from '../index.js';

// Delete every server-side session belonging to a user (the sessions table, sessionStore.js),
// then close the WebSockets those sessions opened, so a pre-existing session can't outlive a
// credential change. `exceptSessionId` keeps one session alive, its sockets included: an admin
// who resets their own password from the Users list stays signed in on the page they did it
// from. Best-effort — never throws to the caller.
export async function destroyUserSessions(userId, { exceptSessionId } = {}) {
  try {
    await query(
      'DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR sid <> $2::text)',
      [String(userId), exceptSessionId || null]
    );
  } catch (err) {
    console.error('destroyUserSessions failed:', err.message);
  }
  if (exceptSessionId) imapManager.closeSockets(userId, { exceptSessionId });
  else imapManager.closeSockets(userId);
}
