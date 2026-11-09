import session from 'express-session';
import { query } from './db.js';
import { SESSION_IDLE_MS } from '../utils/sessionConfig.js';

// express-session's store, in the sessions table (connect-redis before 4.4). A session past
// expires_at reads as ended; the sweep in kvStore.js deletes it later.
//
// touch() moves the expiry forward without rewriting the session, as connect-redis did, and
// only when it moves by more than a minute, so a burst of requests is one write.

const TOUCH_SLACK_MS = 60 * 1000;

function expiresAt(sess) {
  const at = sess?.cookie?.expires ? new Date(sess.cookie.expires) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date(Date.now() + SESSION_IDLE_MS);
}

export class PgSessionStore extends session.Store {
  get(sid, cb) {
    query('SELECT sess FROM sessions WHERE sid = $1 AND expires_at > now()', [sid])
      .then(({ rows }) => cb(null, rows[0]?.sess ?? null), cb);
  }

  set(sid, sess, cb = () => {}) {
    query(
      `INSERT INTO sessions (sid, sess, user_id, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
      [sid, JSON.stringify(sess), sess?.userId != null ? String(sess.userId) : null, expiresAt(sess)]
    ).then(() => cb(null), cb);
  }

  destroy(sid, cb = () => {}) {
    query('DELETE FROM sessions WHERE sid = $1', [sid]).then(() => cb(null), cb);
  }

  touch(sid, sess, cb = () => {}) {
    const at = expiresAt(sess);
    query(
      `UPDATE sessions SET expires_at = $2
       WHERE sid = $1 AND expires_at > now() AND expires_at < $2::timestamptz - $3::bigint * interval '1 millisecond'`,
      [sid, at, TOUCH_SLACK_MS]
    ).then(() => cb(null), cb);
  }
}
