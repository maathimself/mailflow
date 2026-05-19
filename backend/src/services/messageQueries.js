import { query } from './db.js';

export async function listAccounts(userId) {
  const { rows } = await query(
    `SELECT id, email_address, name, enabled FROM email_accounts WHERE user_id = $1 ORDER BY id`,
    [userId]
  );
  return rows;
}

export async function listFolders(userId, accountId) {
  const params = [userId];
  const extra = accountId ? `AND f.account_id = $${params.push(accountId)}` : '';
  const { rows } = await query(
    `SELECT f.id, f.account_id, ea.email_address, f.path, f.name, f.unread_count, f.total_count
     FROM folders f
     JOIN email_accounts ea ON f.account_id = ea.id
     WHERE ea.user_id = $1 ${extra}
     ORDER BY f.account_id, f.path`,
    params
  );
  return rows;
}

export async function listMessages(userId, { accountId, folder, unreadOnly, limit = 20, offset = 0 } = {}) {
  const conditions = ['ea.user_id = $1', 'm.is_deleted = false'];
  const params = [userId];
  if (accountId)   { conditions.push(`m.account_id = $${params.push(accountId)}`); }
  if (folder)      { conditions.push(`m.folder = $${params.push(folder)}`); }
  if (unreadOnly)  { conditions.push('m.is_read = false'); }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT m.id, m.account_id, ea.email_address AS account, m.folder, m.subject,
            m.from_name, m.from_email, m.date, m.is_read, m.is_starred, m.thread_id
     FROM messages m
     JOIN email_accounts ea ON m.account_id = ea.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.date DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

export async function getUnreadCounts(userId, accountId) {
  const params = [userId];
  const extra = accountId ? `AND f.account_id = $${params.push(accountId)}` : '';
  const { rows } = await query(
    `SELECT ea.email_address AS account, f.path AS folder, f.unread_count
     FROM folders f
     JOIN email_accounts ea ON f.account_id = ea.id
     WHERE ea.user_id = $1 AND f.unread_count > 0 ${extra}
     ORDER BY f.unread_count DESC`,
    params
  );
  return rows;
}

// Returns full message row with account info, or null if not found / not owned.
export async function getMessage(id, userId) {
  const { rows } = await query(
    `SELECT m.id, m.uid, m.folder, m.account_id, m.subject,
            m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
            m.reply_to, m.in_reply_to, m.message_id, m.thread_id,
            m.date, m.snippet, m.body_text, m.body_html,
            m.is_read, m.is_starred, m.has_attachments,
            ea.email_address AS account_email,
            ea.sender_name, ea.name AS account_name
     FROM messages m
     JOIN email_accounts ea ON m.account_id = ea.id
     WHERE m.id = $1 AND ea.user_id = $2`,
    [id, userId]
  );
  return rows[0] ?? null;
}

// Returns all messages in a thread, deduped by message_id, ordered by date ASC.
export async function getThread(threadId, userId) {
  const { rows: accountRows } = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  if (!accountRows.length) return [];
  const userAccountIds = accountRows.map(r => r.id);

  const { rows } = await query(
    `SELECT DISTINCT ON (m.message_id)
            m.id, m.subject, m.from_name, m.from_email, m.date, m.is_read,
            m.body_text, m.to_addresses, m.cc_addresses, m.message_id,
            m.account_id, ea.email_address AS account_email
     FROM messages m
     JOIN email_accounts ea ON m.account_id = ea.id
     WHERE COALESCE(m.thread_id, m.id::text) = $1
       AND m.account_id = ANY($2)
       AND m.is_deleted = false
     ORDER BY m.message_id,
              CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
              m.date ASC`,
    [threadId, userAccountIds]
  );
  return rows.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Full-text search across subject, from_email, and body_text.
export async function searchMessages(userId, q, { accountId, limit = 20 } = {}) {
  const params = [userId, `%${q}%`, `%${q}%`, `%${q}%`];
  const accountFilter = accountId ? `AND m.account_id = $${params.push(accountId)}` : '';
  params.push(limit);
  const { rows } = await query(
    `SELECT m.id, m.subject, m.from_name, m.from_email, m.date, m.is_read,
            m.folder, m.thread_id, ea.email_address AS account
     FROM messages m
     JOIN email_accounts ea ON m.account_id = ea.id
     WHERE ea.user_id = $1
       AND m.is_deleted = false
       AND (m.subject ILIKE $2 OR m.from_email ILIKE $3 OR m.body_text ILIKE $4)
       ${accountFilter}
     ORDER BY m.date DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}
