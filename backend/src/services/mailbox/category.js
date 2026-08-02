import { query } from '../db.js';

export async function setCategory(imapManager, { userId, accountIds, id, category }) {
  void imapManager;
  const accountClause = accountIds == null
    ? ''
    : ' AND messages.account_id = ANY($4::uuid[])';
  const params = accountIds == null
    ? [category === 'primary' ? null : category, id, userId]
    : [category === 'primary' ? null : category, id, userId, accountIds];
  const result = await query(
    `UPDATE messages SET category = $1
     FROM email_accounts a
     WHERE messages.id = $2
       AND messages.account_id = a.id
       AND a.user_id = $3${accountClause}
     RETURNING messages.id`,
    params
  );
  if (!result.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  return { ok: true, category };
}
