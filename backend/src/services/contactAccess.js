import { query } from './db.js';

// Only the current user's address books can supply recipient personalization data.
export async function getOwnedContactByEmail(userId, email) {
  if (!userId || !email) return null;
  const { rows } = await query(
    `SELECT c.display_name, c.first_name, c.last_name, c.primary_email,
            c.emails, c.phones, c.organization, c.vcard
       FROM contacts c WHERE c.user_id = $1
        AND (lower(c.primary_email) = lower($2) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(c.emails, '[]'::jsonb)) e
           WHERE lower(e->>'value') = lower($2)))
       ORDER BY c.is_auto ASC, c.updated_at DESC, c.id LIMIT 1`,
    [userId, email],
  );
  return rows[0] || null;
}
