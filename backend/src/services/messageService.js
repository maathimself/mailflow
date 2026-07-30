import { query } from './db.js';
import { resolveAccountScope } from './unifiedInbox.js';

const GTD_STATE_FOLDER_VALUES = `
  ('todo',      COALESCE(NULLIF(a.gtd_folders->>'todo', ''),      'Todo'),      1),
  ('watch',     COALESCE(NULLIF(a.gtd_folders->>'watch', ''),     'Watch'),     2),
  ('delegated', COALESCE(NULLIF(a.gtd_folders->>'delegated', ''), 'Delegated'), 3),
  ('reference', COALESCE(NULLIF(a.gtd_folders->>'reference', ''), 'Reference'), 4),
  ('someday',   COALESCE(NULLIF(a.gtd_folders->>'someday', ''),   'Someday'),   5)
`;

function gtdMetadataCtes(pageThreadColumn) {
  return `,
    page_threads AS (
      SELECT DISTINCT page.account_id, page.${pageThreadColumn} AS thread_key
      FROM page
    ),
    gtd_matches AS (
      SELECT gm.account_id,
             gm.thread_key,
             state_map.state,
             state_map.sort_order,
             MAX(gm.date) AS state_date
      FROM page_threads pt
      JOIN email_accounts a
        ON a.id = pt.account_id
       AND a.gtd_enabled = true
      CROSS JOIN LATERAL (
        VALUES ${GTD_STATE_FOLDER_VALUES}
      ) AS state_map(state, folder, sort_order)
      JOIN messages gm
        ON gm.account_id = pt.account_id
       AND gm.thread_key = pt.thread_key
       AND gm.folder = state_map.folder
       AND gm.is_deleted = false
      GROUP BY gm.account_id, gm.thread_key, state_map.state, state_map.sort_order
    ),
    gtd_metadata AS (
      SELECT account_id,
             thread_key,
             ARRAY_AGG(state ORDER BY sort_order) AS gtd_states,
             JSONB_OBJECT_AGG(state, state_date) AS gtd_dates,
             MAX(state_date) AS gtd_date
      FROM gtd_matches
      GROUP BY account_id, thread_key
    )`;
}

function gtdPageSelect(pageThreadColumn, includeGtdMetadata) {
  if (!includeGtdMetadata) return 'SELECT page.* FROM page ORDER BY page.date DESC';
  return `
    SELECT page.*,
           COALESCE(gtd_metadata.gtd_states, ARRAY[]::text[]) AS gtd_states,
           COALESCE(gtd_metadata.gtd_dates, '{}'::jsonb) AS gtd_dates,
           gtd_metadata.gtd_date
    FROM page
    LEFT JOIN gtd_metadata
      ON gtd_metadata.account_id = page.account_id
     AND gtd_metadata.thread_key = page.${pageThreadColumn}
    ORDER BY page.date DESC`;
}

export async function listMessages({ userId, accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, category }) {
  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  const {
    accountIds: scopedAccountIds,
    resolvedAccountId,
  } = resolveAccountScope(accountsResult.rows, accountId);
  if (!scopedAccountIds.length) return { messages: [], total: 0 };

  let whereConditions = ['m.is_deleted = false'];
  const values = [];
  let p = 1;

  const isSpecificAccount = resolvedAccountId !== null;

  if (isSpecificAccount) {
    whereConditions.push(`m.account_id = $${p++}`);
    values.push(resolvedAccountId);
    whereConditions.push(`m.folder = $${p++}`);
    values.push(folder);
  } else {
    whereConditions.push(`m.account_id = ANY($${p++})`);
    values.push(scopedAccountIds);
    whereConditions.push(`m.folder = 'INBOX'`);
  }

  const isUnreadOnly = unreadOnly === 'true' || unreadOnly === true;
  if (isUnreadOnly) whereConditions.push('m.is_read = false');

  // Category filter: 'primary' matches NULL and 'primary'; others match exactly.
  const safeCategory = typeof category === 'string' && category.length > 0 ? category : null;
  if (safeCategory && safeCategory !== 'primary') {
    whereConditions.push(`m.category = $${p++}`);
    values.push(safeCategory);
  } else if (safeCategory === 'primary') {
    whereConditions.push(`(m.category IS NULL OR m.category = 'primary')`);
  }

  const where = whereConditions.join(' AND ');
  const includeGtdMetadata = !isSpecificAccount || folder === 'INBOX';

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
            [scopedAccountIds]
          )
        : await query(
            "SELECT COALESCE(SUM(total_count), 0)::int AS n FROM folders WHERE account_id = ANY($1) AND path = 'INBOX'",
            [scopedAccountIds]
          );
      total = r.rows[0]?.n ?? 0;
    }
  } catch {
    total = 0;
  }

  if (threaded === 'true' || threaded === true) {
    const filterValues = [...values];
    const threadAccountParam = isSpecificAccount ? [resolvedAccountId] : scopedAccountIds;
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
               m.has_attachments, m.account_id, m.category,
               m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
               a.name  AS account_name,
               a.email_address AS account_email,
               a.color AS account_color,
               (co.id IS NOT NULL) AS has_contact_photo
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        LEFT JOIN contacts co ON co.user_id = a.user_id
                              AND co.primary_email = lower(m.from_email)
                              AND co.photo_data IS NOT NULL
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
               FIRST_VALUE(d.subject)           OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_subject,
               FIRST_VALUE(d.from_name)          OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_from_name,
               FIRST_VALUE(d.from_email)         OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_from_email,
               FIRST_VALUE(d.has_contact_photo)  OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_has_contact_photo,
               ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.date DESC) AS rn
        FROM deduped d
        LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
      ),
      page AS MATERIALIZED (
        SELECT id, uid, folder, message_id, thread_id, thread_subject AS subject,
               thread_from_name AS from_name, thread_from_email AS from_email,
               to_addresses, cc_addresses, reply_to, in_reply_to,
               date, snippet, is_starred, is_read, has_attachments, account_id,
               account_name, account_email, account_color,
               category, list_unsubscribe, list_unsubscribe_post, delivery_addresses,
               message_count, unread_count,
               thread_has_contact_photo AS has_contact_photo
        FROM ranked
        WHERE rn = 1
      )
      ${includeGtdMetadata ? gtdMetadataCtes('thread_id') : ''}
      ${gtdPageSelect('thread_id', includeGtdMetadata)}
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
      resolvedAccountId,
    };
  }

  const limitParam  = p;
  const offsetParam = p + 1;
  values.push(safeLimit, safeOffset);

  const result = await query(`
    WITH page AS MATERIALIZED (
      SELECT m.id, m.uid, m.folder, m.message_id, m.thread_key,
             m.subject, m.from_name, m.from_email,
             m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id, m.category,
             m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
             a.name as account_name, a.email_address as account_email, a.color as account_color,
             (co.id IS NOT NULL) AS has_contact_photo
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      LEFT JOIN contacts co ON co.user_id = a.user_id
                            AND co.primary_email = lower(m.from_email)
                            AND co.photo_data IS NOT NULL
      WHERE ${where}
      ORDER BY m.date DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    )
    ${includeGtdMetadata ? gtdMetadataCtes('thread_key') : ''}
    ${gtdPageSelect('thread_key', includeGtdMetadata)}
  `, values);

  return {
    messages: result.rows,
    total,
    resolvedAccountId,
  };
}
