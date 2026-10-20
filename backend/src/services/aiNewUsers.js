import { query } from './db.js';

// Whether an account created now gets AI access (#644): the admin's "Allow AI for new users"
// setting, on until it is turned off. It has its own system_settings row rather than living in
// ai_config, so removing the AI configuration does not quietly turn it back on, and a save that
// does not mention it (an admin tab opened before the update) leaves it as it is.
// Kept apart from aiAccess.js so the sign-up routes do not load the AI provider. A registration
// passes its transaction client, so the read happens inside the transaction that creates the user.
const KEY = 'ai_new_users_enabled';

export async function aiEnabledForNewUser(db = { query }) {
  const result = await db.query('SELECT value FROM system_settings WHERE key = $1', [KEY]);
  return result.rows[0]?.value !== 'false';
}

export async function setAiEnabledForNewUser(enabled, db = { query }) {
  await db.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [KEY, enabled ? 'true' : 'false'],
  );
}
