// The order of a user's accounts in the sidebar (#695): email_accounts.sort_order, 0 for the first.
import { withTransaction } from './db.js';

// The position for an account a user adds: after their others. For an INSERT whose $1 is the
// user's id. Every account used to start at 0, so a new one appeared among the first.
export const NEXT_ACCOUNT_SORT_ORDER = '(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM email_accounts WHERE user_id = $1)';

// Sets the order of all of a user's accounts at once, as `ids` lists them. Moving one account used
// to rewrite only the two it swapped, so where several shared a position the rest reshuffled on the
// next load. Resolves false, changing nothing, unless `ids` is exactly the user's accounts.
export async function setAccountOrder(userId, ids) {
  return withTransaction(async client => {
    const { rows } = await client.query('SELECT id FROM email_accounts WHERE user_id = $1 FOR UPDATE', [userId]);
    const owned = new Set(rows.map(r => r.id));
    if (ids.length !== owned.size || new Set(ids).size !== ids.length || !ids.every(id => owned.has(id))) return false;
    await client.query(
      `UPDATE email_accounts a SET sort_order = o.pos - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos)
        WHERE a.id = o.id AND a.user_id = $1`,
      [userId, ids]
    );
    return true;
  });
}
