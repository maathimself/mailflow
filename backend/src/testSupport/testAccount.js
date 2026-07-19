// Shared IT/dev-script fixture: seed and tear down a throwaway user + email account
// against a real DB. `db` is anything with .query(text, params) — a pg.Client, a
// pooled client, or the app pool. Deleting the user cascades to email_accounts →
// messages (ON DELETE CASCADE), so cleanupAccount removes everything in one step.
import { randomUUID } from 'crypto';

export async function seedAccount(db, label = 'it') {
  const u = await db.query('INSERT INTO users (username) VALUES ($1) RETURNING id', [`${label}-${randomUUID()}`]);
  const userId = u.rows[0].id;
  const a = await db.query(
    'INSERT INTO email_accounts (user_id, name, email_address) VALUES ($1, $2, $3) RETURNING id',
    [userId, label, `${label}-${randomUUID()}@example.com`],
  );
  return { userId, accountId: a.rows[0].id };
}

export async function cleanupAccount(db, userId) {
  if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]);
}
