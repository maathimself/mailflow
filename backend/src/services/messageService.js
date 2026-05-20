import { query } from './db.js';

export async function listMessages({ userId, accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded }) {
  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return { messages: [], total: 0 };

  let whereConditions = ['m.is_deleted = false'];
  const values = [];
  let p = 1;

  const isSpecificAccount = accountId && userAccountIds.includes(accountId);

  if (isSpecificAccount) {
    whereConditions.push(`m.account_id = $${p++}`);
    values.push(accountId);
    whereConditions.push(`m.folder = $${p++}`);
    values.push(folder);
  } else {
    whereConditions.push(`m.account_id = ANY($${p++})`);
    values.push(userAccountIds);
    whereConditions.push(`m.folder = 'INBOX'`);
  }

  const isUnreadOnly = unreadOnly === 'true' || unreadOnly === true;
  if (isUnreadOnly) whereConditions.push('m.is_read = false');

  const where = whereConditions.join(' AND ');

  const safeLimit  = Math.min(Math.max(parseInt(limit)  || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  let total = 0;
  try {
    if (isSpecificAccount) {
      const r = await query(
        'SELECT total_count, unread_count FROM folders WHERE account_id = $1 AND path = $2',
        [accountId, folder]
      );
      if (r.rows.length) {
        total = isUnreadOnly ? (r.rows[0].unread_count ?? 0) : (r.rows[0].total_count ?? 0);
      }
    } else {
      const r = isUnreadOnly
        ? await query(
            "SELECT COALESCE(SUM(unread_count), 0)::int AS n FROM folders WHERE account_id = ANY($1) AND path = 'INBOX'",
            [userAccountIds]
          )
        : await query(
            "SELECT COALESCE(SUM(total_count), 0)::int AS n FROM folders WHERE account_id = ANY($1) AND path = 'INBOX'",
            [userAccountIds]
          );
      total = r.rows[0]?.n ?? 0;
    }
  } catch (_) {
    total = 0;
  }

  if (threaded === 'true' || threaded === true) {
    const filterValues = [...values];
    const threadAccountParam = isSpecificAccount ? [accountId] : userAccountIds;
    // For INBOX-specific views the thread badge must match the expansion, so scope
    // thread_totals to that folder. For other folders (All Mail, Sent, etc.) count
    // across all folders so the badge reflects the true thread size.
    const threadFolderFilter = isSpecificAccount
      ? (folder === 'INBOX' ? `AND folder = $2` : '')
      : `AND folder = 'INBOX'`;

    const threadResult = await query(`
      WITH paged_threads AS (
        SELECT m.thread_key AS thread_id
        FROM messages m
        WHERE ${where}
        GROUP BY m.thread_key
        ORDER BY MAX(m.date) DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
      ),
      deduped AS MATERIALIZED (
        SELECT DISTINCT ON (m.account_id, m.thread_key, m.message_id)
               m.id, m.uid, m.folder, m.message_id,
               m.thread_key AS thread_id,
               m.subject, m.from_name, m.from_email,
               m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id,
               a.name  AS account_name,
               a.email_address AS account_email,
               a.color AS account_color
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE ${where}
          AND m.thread_key IN (SELECT thread_id FROM paged_threads)
        ORDER BY m.account_id,
                 m.thread_key,
                 m.message_id,
                 CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                 m.date ASC
      ),
      thread_totals AS (
        SELECT m.thread_key AS thread_id,
               COUNT(DISTINCT m.message_id)::int AS message_count
        FROM messages m
        WHERE m.account_id = ANY($${p})
          AND m.is_deleted = false
          AND m.message_id IS NOT NULL
          ${threadFolderFilter}
          AND m.thread_key IN (SELECT thread_id FROM paged_threads)
        GROUP BY m.thread_key
      ),
      ranked AS (
        SELECT d.*,
               COALESCE(tt.message_count, 1) AS message_count,
               COUNT(*) FILTER (WHERE NOT d.is_read) OVER (PARTITION BY d.thread_id)::int AS unread_count,
               FIRST_VALUE(d.subject)    OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_subject,
               FIRST_VALUE(d.from_name)  OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_from_name,
               FIRST_VALUE(d.from_email) OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_from_email,
               ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.date DESC) AS rn
        FROM deduped d
        LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
      )
      SELECT id, uid, folder, message_id, thread_id, thread_subject AS subject,
             thread_from_name AS from_name, thread_from_email AS from_email,
             to_addresses, cc_addresses, reply_to, in_reply_to,
             date, snippet, is_starred, is_read, has_attachments, account_id,
             account_name, account_email, account_color,
             message_count, unread_count
      FROM ranked
      WHERE rn = 1
      ORDER BY date DESC
    `, [...filterValues, threadAccountParam, safeLimit, safeOffset]);

    const threadCountResult = await query(`
      SELECT COUNT(DISTINCT m.thread_key)::int AS total
      FROM messages m
      WHERE ${where}
    `, filterValues);

    return {
      messages: threadResult.rows,
      total: threadCountResult.rows[0]?.total ?? 0,
      threaded: true,
      resolvedAccountId: isSpecificAccount ? accountId : null,
    };
  }

  const limitParam  = p;
  const offsetParam = p + 1;
  values.push(safeLimit, safeOffset);

  const result = await query(`
    SELECT m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
           m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
           m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id,
           a.name as account_name, a.email_address as account_email, a.color as account_color
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `, values);

  return {
    messages: result.rows,
    total,
    resolvedAccountId: isSpecificAccount ? accountId : null,
  };
}
