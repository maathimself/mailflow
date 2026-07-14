import { query } from './db.js';
import { resolveLookupPhotos } from './carddavLookupService.js';

// Resolve an inbound sender against the user's lookup-only CardDAV books — ledger
// rows (mapping_status='lookup') that are retained for sender resolution but never
// materialized as contacts (multi-book-design.md, Slice 4). LATERAL + LIMIT 1
// yields at most one match, so a sender present in several lookup books never
// multiplies message rows. It feeds two things below: a fallback display name when
// the message header carries none, and `matched` — a marker that a retained vCard
// exists for this sender.
//
// `matched` deliberately does NOT try to decide whether that vCard yields a
// servable avatar: a syntactic "has a PHOTO property" check diverges from the
// bounded decode the photo endpoint actually runs — it would miss a grouped
// `item1.PHOTO` (a false no-avatar) and falsely promise a photo for an oversized,
// URL-only, or malformed one (a guaranteed 404 GET /api/contacts/photo). Instead
// SQL only flags the sender as a photo *candidate* (co.id IS NULL AND matched);
// applyLookupPhotoGate below resolves each candidate through the real decode path
// (resolveLookupPhoto), so has_contact_photo never promises a photo the endpoint
// would 404 on, nor hides one it would serve.
const LOOKUP_SENDER_JOIN = `
        LEFT JOIN LATERAL (
          SELECT lo.lookup_display_name, true AS matched
          FROM carddav_remote_objects lo
          JOIN address_books lab ON lab.id = lo.address_book_id
          WHERE lo.mapping_status = 'lookup'
            AND lo.primary_email = lower(m.from_email)
            AND lab.user_id = a.user_id
            AND lab.source = 'carddav'
            AND lab.is_lookup_source = true
          ORDER BY lo.updated_at DESC
          LIMIT 1
        ) lookup ON true`;

// Turn the SQL photo *candidates* (co.id IS NULL AND a lookup vCard matched) into a
// truthful has_contact_photo by running the same bounded decode the photo endpoint
// uses. resolveLookupPhoto is memoized, so this also primes the cache that the
// subsequent GET /api/contacts/photo reads from. Materialized-contact photos are
// already resolved in SQL (co.id IS NOT NULL) and never re-checked here, so they
// keep winning over the ledger fallback. Mutates and returns the rows.
//
// Candidates are collected as one set of distinct normalized sender emails and
// resolved in a single batched probe (resolveLookupPhotos), so a page with N
// distinct lookup senders costs one DB round-trip, not N. Fanning out one query
// per sender would flood the connection pool on a large page, and — because the
// in-process LRU cannot dedupe concurrent misses — race every duplicate of a
// repeated sender to its own DB read + vCard decode (a cache stampede). The
// batched probe both bounds the pool cost and shares the decode.
async function applyLookupPhotoGate(userId, rows) {
  const normalize = row => String(row.from_email ?? '').trim().toLowerCase();

  const candidateEmails = new Set();
  for (const row of rows) {
    if (row.lookup_photo_candidate) candidateEmails.add(normalize(row));
  }
  const photoByEmail = candidateEmails.size
    ? await resolveLookupPhotos(userId, [...candidateEmails])
    : new Map();

  for (const row of rows) {
    if (row.lookup_photo_candidate && photoByEmail.get(normalize(row))) {
      row.has_contact_photo = true;
    }
    delete row.lookup_photo_candidate;
  }
  return rows;
}

export async function listMessages({ userId, accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, category }) {
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

  // Category filter: 'primary' matches NULL and 'primary'; others match exactly.
  const safeCategory = typeof category === 'string' && category.length > 0 ? category : null;
  if (safeCategory && safeCategory !== 'primary') {
    whereConditions.push(`m.category = $${p++}`);
    values.push(safeCategory);
  } else if (safeCategory === 'primary') {
    whereConditions.push(`(m.category IS NULL OR m.category = 'primary')`);
  }

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
  } catch {
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
               m.subject,
               COALESCE(NULLIF(m.from_name, ''), lookup.lookup_display_name) AS from_name,
               m.from_email,
               m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id, m.category,
               m.list_unsubscribe, m.list_unsubscribe_post,
               a.name  AS account_name,
               a.email_address AS account_email,
               a.color AS account_color,
               (co.id IS NOT NULL) AS has_contact_photo,
               (co.id IS NULL AND lookup.matched IS TRUE) AS lookup_photo_candidate
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        LEFT JOIN contacts co ON co.user_id = a.user_id
                              AND co.primary_email = lower(m.from_email)
                              AND co.photo_data IS NOT NULL${LOOKUP_SENDER_JOIN}
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
               FIRST_VALUE(d.lookup_photo_candidate) OVER (PARTITION BY d.thread_id ORDER BY d.date ASC) AS thread_lookup_photo_candidate,
               ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.date DESC) AS rn
        FROM deduped d
        LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
      )
      SELECT id, uid, folder, message_id, thread_id, thread_subject AS subject,
             thread_from_name AS from_name, thread_from_email AS from_email,
             to_addresses, cc_addresses, reply_to, in_reply_to,
             date, snippet, is_starred, is_read, has_attachments, account_id,
             account_name, account_email, account_color,
             category, list_unsubscribe, list_unsubscribe_post,
             message_count, unread_count,
             thread_has_contact_photo AS has_contact_photo,
             thread_lookup_photo_candidate AS lookup_photo_candidate
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
      messages: await applyLookupPhotoGate(userId, threadResult.rows),
      total: threadCountResult.rows[0]?.total ?? 0,
      threaded: true,
      resolvedAccountId: isSpecificAccount ? accountId : null,
    };
  }

  const limitParam  = p;
  const offsetParam = p + 1;
  values.push(safeLimit, safeOffset);

  const result = await query(`
    SELECT m.id, m.uid, m.folder, m.message_id, m.subject,
           COALESCE(NULLIF(m.from_name, ''), lookup.lookup_display_name) AS from_name,
           m.from_email,
           m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
           m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id, m.category,
           m.list_unsubscribe, m.list_unsubscribe_post,
           a.name as account_name, a.email_address as account_email, a.color as account_color,
           (co.id IS NOT NULL) AS has_contact_photo,
           (co.id IS NULL AND lookup.matched IS TRUE) AS lookup_photo_candidate
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    LEFT JOIN contacts co ON co.user_id = a.user_id
                          AND co.primary_email = lower(m.from_email)
                          AND co.photo_data IS NOT NULL${LOOKUP_SENDER_JOIN}
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `, values);

  return {
    messages: await applyLookupPhotoGate(userId, result.rows),
    total,
    resolvedAccountId: isSpecificAccount ? accountId : null,
  };
}
