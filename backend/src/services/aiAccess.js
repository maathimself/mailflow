import { query } from './db.js';
import { getAiStatus } from './aiProvider.js';

// Who may use the instance's AI provider (#644). The provider is set up once for the whole
// instance, often on the admin's own subscription, so each user also carries an ai_enabled flag
// the admin controls. It is read from the database on every check, as requireAdmin reads
// is_admin, so switching it off applies to the user's next request, not their next sign-in.

export const AI_FEATURES = ['compose', 'summarize'];

// Returns the instance status and whether this user may use AI. A user row that is missing or
// cannot be read denies access: a read error is thrown to the caller, never treated as allowed.
export async function getUserAiAccess(userId) {
  if (!userId) return { status: await getAiStatus(), allowed: false, isAdmin: false };
  const [status, user] = await Promise.all([
    getAiStatus(),
    query('SELECT ai_enabled, is_admin FROM users WHERE id = $1', [userId]).then(r => r.rows[0]),
  ]);
  return {
    status,
    allowed: status.enabled === true && user?.ai_enabled === true,
    isAdmin: user?.is_admin === true,
  };
}

// The instance switches for the writing assistant and summaries, which also cover AI actions.
export function aiFeatureEnabled(status, feature) {
  return AI_FEATURES.includes(feature) && status?.features?.[feature] !== false;
}
