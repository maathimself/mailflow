import { query } from '../services/db.js';
import { touchLastSeen } from '../services/lastSeen.js';
import { answerInvalidToken } from '../services/apiTokens.js';

export async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query('SELECT id FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) {
      // An API token request has no session to end (deleting the user deletes the token too).
      if (req.apiToken) return answerInvalidToken(res);
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Token traffic must not make a dormant account look in use; tokens record their own last use.
    if (!req.apiToken) touchLastSeen(req.session.userId);
    next();
  } catch (err) {
    next(err);
  }
}

// Always verifies against the DB so a revoked admin can't keep using
// a stale session. The extra query is cheap and only hits admin routes.
export async function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // No admin route is on the API token allowlist; this keeps it so if one is ever added by mistake.
  if (req.apiToken) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const result = await query(
      'SELECT is_admin FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    // The admin router uses requireAdmin alone, so time spent in Settings counts as being seen
    // too. Routes that stack it after requireAuth record once: lastSeen throttles per user.
    touchLastSeen(req.session.userId);
    next();
  } catch (err) {
    next(err);
  }
}
