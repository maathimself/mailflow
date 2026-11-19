import { query } from './db.js';
import { resolveAccountScope } from './unifiedInbox.js';
import { draftMessageSql, sentInboxRoleCtes } from '../utils/mailUtils.js';

// Where snoozed mail waits (routes/mail.js snoozes into it, imapManager wakes it from it). On a
// server with an INBOX. namespace prefix the folder is INBOX.Snoozed: the snooze route stores the
// path the server gave it, on the message and on its snooze record.
export const SNOOZED_FOLDER = 'Snoozed';

// Snoozed mail outside the folder named Snoozed (in INBOX.Snoozed, or wherever a rename took it) is
// a message whose own snooze record names the folder it is in; the folder's other mail is not
// snoozed. The ANY over the folders the records name lets the (account_id, folder) index find it.
const snoozedElsewhereSql = (accounts) =>
  `(m.folder = ANY(ARRAY(SELECT DISTINCT sm.snoozed_folder FROM snoozed_messages sm WHERE sm.account_id = ANY(${accounts})))`
  + ' AND EXISTS (SELECT 1 FROM snoozed_messages own WHERE own.account_id = m.account_id'
  + ' AND own.message_id_header = m.message_id AND own.snoozed_folder = m.folder))';

// List orders (#528). Each maps to fixed SQL, never to text from the request. Sender and Subject
// sort on what the row shows: the sender's name, or the address when there is none, and the
// subject without its Re:/Fwd: prefixes (normalized_subject, a generated column). A conversation
// row shows its opener's sender and subject, so the threaded list sorts by the opener's.
// #407: a UID-only placeholder row whose envelope has not been fetched yet (see listMessages).
// Lists and the counts beside them leave it out.
export const NOT_PLACEHOLDER_SQL = "NOT (m.message_id IS NULL AND (m.subject IS NULL OR m.subject = '(no subject)') AND COALESCE(m.snippet, '') = '')";

export const LIST_SORTS = ['date', 'from', 'subject'];
export const LIST_SORT_DIRS = ['asc', 'desc'];
// A row with no sender or subject sorts last either way (NULLS LAST), as the client orders it.
const SENDER_SQL = "nullif(lower(coalesce(nullif(m.from_name, ''), m.from_email)), '')";
const SUBJECT_SQL = "nullif(m.normalized_subject, '')";
const OPENER_SQL = {
  from: `(array_agg(${SENDER_SQL} ORDER BY m.date ASC, m.id))[1]`,
  subject: `(array_agg(${SUBJECT_SQL} ORDER BY m.date ASC, m.id))[1]`,
};

// The ORDER BY keys for a list. Every order ends on date and id, so equal keys still page stably.
// Date newest first is exactly the order the list always had, which idx_messages_list serves.
function listOrderSql({ sort, dir, starredFirst, threaded }) {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  const keys = [];
  if (starredFirst) keys.push(threaded ? 'bool_or(m.is_starred) DESC' : 'm.is_starred DESC');
  if (sort === 'from' || sort === 'subject') {
    keys.push(`${threaded ? OPENER_SQL[sort] : sort === 'from' ? SENDER_SQL : SUBJECT_SQL} ${d} NULLS LAST`);
    keys.push(threaded ? 'MAX(m.date) DESC' : 'm.date DESC');
  } else {
    keys.push(threaded ? `MAX(m.date) ${d}` : `m.date ${d}`);
  }
  keys.push(threaded ? 'm.thread_key' : 'm.id');
  return keys.join(', ');
}

// Materialized draft/sent folder lookup CTEs layered on top of sentInboxRoleCtes so
// message queries can join/probe (account_id, folder) directly through idx_messages_list
// and idx_messages_list_unread instead of scanning every folder with OR EXISTS(...).
const sentFolderHelperCtes = (roleScopeSql) => `${sentInboxRoleCtes(roleScopeSql)},
_draft_folders AS MATERIALIZED (
  SELECT account_id, path AS folder FROM _folder_roles WHERE is_draft
),
_sent_folders AS MATERIALIZED (
  SELECT account_id, path AS folder FROM _folder_roles WHERE is_sent
  UNION
  SELECT ac.account_id, fb.folder
  FROM _acct_sent ac
  CROSS JOIN LATERAL unnest(ARRAY[
    'Sent', 'Sent Items', 'Sent Mail', 'Sent Messages',
    '[Gmail]/Sent Mail', '[Google Mail]/Sent Mail', 'INBOX.Sent', 'INBOX/Sent',
    ac.mapped_sent
  ]) AS fb(folder)
  WHERE fb.folder IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM _folder_roles fr WHERE fr.account_id = ac.account_id AND fr.path = fb.folder)
)`;

const draftFromFoldersSql = (m = 'm') => `(COALESCE(${m}.flags ? '\\Draft', false)
  OR EXISTS (SELECT 1 FROM _draft_folders df WHERE df.account_id = ${m}.account_id AND df.folder = ${m}.folder))`;

const sentFromFoldersSql = (m = 'm') =>
  `EXISTS (SELECT 1 FROM _sent_folders sf2 WHERE sf2.account_id = ${m}.account_id AND sf2.folder = ${m}.folder)`;

// Eligibility check for a Sent row (already known to live in _sent_folders):
// Case A: a Sent reply/message belonging to a thread that still has a live copy in INBOX.
// Case B: a Sent-initiated thread (root or follow-up whose root is a Sent message with no
// in_reply_to) that has no copy in any non-Sent folder (neither INBOX nor Archive/Trash/etc.)
// and was not dismissed from Inbox (e.g. via Gmail All-Mail archive).
const sentEligibilityBodySql = (m = 'm') => `(NOT ${draftFromFoldersSql(m)} AND (
  EXISTS (
    SELECT 1 FROM messages inb
    WHERE inb.account_id = ${m}.account_id AND inb.thread_key = ${m}.thread_key
      AND inb.folder = 'INBOX' AND inb.is_deleted = false AND NOT ${draftFromFoldersSql('inb')}
  )
  OR (
    (COALESCE(NULLIF(trim(${m}.in_reply_to), ''), NULL) IS NULL OR EXISTS (
      SELECT 1 FROM messages root
      WHERE root.account_id = ${m}.account_id AND root.thread_key = ${m}.thread_key
        AND root.is_deleted = false AND ${sentFromFoldersSql('root')} AND NOT ${draftFromFoldersSql('root')}
        AND COALESCE(NULLIF(trim(root.in_reply_to), ''), NULL) IS NULL
    ))
    AND NOT EXISTS (
      SELECT 1 FROM messages other
      WHERE other.account_id = ${m}.account_id AND other.thread_key = ${m}.thread_key
        AND other.is_deleted = false AND other.folder <> ${m}.folder
        AND NOT ${sentFromFoldersSql('other')} AND NOT ${draftFromFoldersSql('other')}
    )
    AND NOT EXISTS (
      SELECT 1 FROM sent_inbox_dismissed sid
      WHERE sid.account_id = ${m}.account_id AND sid.thread_key = ${m}.thread_key
    )
  )
))`;

const sentEligibleSql = (m = 'm') => `(${sentFromFoldersSql(m)} AND ${sentEligibilityBodySql(m)})`;

// Threshold above which unfiltered threaded listings avoid running a full-mailbox
// COUNT(DISTINCT thread_key) when more pages exist; mirrors flat mode's use of folders.total_count.
const LARGE_THREADED_COUNT_THRESHOLD = 2000;
const FAST_THREAD_MAX_REACH = 1000;

export async function listMessages({ userId, accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, includeSent, category, sort, dir, starredFirst }) {
  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  // The Snoozed view (#269): snoozed mail with when it comes back, soonest first, one row per
  // message. Without an account it is every enabled account's: a snooze is the reader's own,
  // whether or not the account shows in All Inboxes.
  const isSnoozedView = folder === SNOOZED_FOLDER;
  const scope = resolveAccountScope(accountsResult.rows, accountId);
  const resolvedAccountId = scope.resolvedAccountId;
  const scopedAccountIds = isSnoozedView && resolvedAccountId === null
    ? accountsResult.rows.map(r => r.id)
    : scope.accountIds;
  if (!scopedAccountIds.length) return { messages: [], total: 0 };

  let whereConditions = ['m.is_deleted = false'];
  const values = [];
  let p = 1;

  const isSpecificAccount = resolvedAccountId !== null;
  const isThreaded = !isSnoozedView && (threaded === 'true' || threaded === true);
  const withSent = isThreaded && (includeSent === 'true' || includeSent === true) && (!isSpecificAccount || folder === 'INBOX');
  const roleCtes = withSent ? sentFolderHelperCtes(isSpecificAccount ? 'ea.id = $1' : 'ea.id = ANY($1)') : null;
  const withRolePrefix = roleCtes ? `WITH ${roleCtes}\n` : '';
  const draftSql = withSent ? draftFromFoldersSql : draftMessageSql;

  if (isSpecificAccount) {
    whereConditions.push(`m.account_id = $${p++}`);
    values.push(resolvedAccountId);
    const folderParam = `$${p++}`;
    values.push(folder);
    whereConditions.push(withSent
      ? `(m.folder = ${folderParam} OR ${sentEligibleSql('m')})`
      : `m.folder = ${folderParam}`);
  } else {
    const accountsParam = `$${p++}`;
    whereConditions.push(`m.account_id = ANY(${accountsParam})`);
    values.push(scopedAccountIds);
    whereConditions.push(isSnoozedView
      ? `(m.folder = '${SNOOZED_FOLDER}' OR ${snoozedElsewhereSql(accountsParam)})`
      : withSent
        ? `(m.folder = 'INBOX' OR ${sentEligibleSql('m')})`
        : `m.folder = 'INBOX'`);
  }

  const isUnreadOnly = unreadOnly === 'true' || unreadOnly === true;
  if (isUnreadOnly) whereConditions.push('m.is_read = false');

  // Category filter: 'primary' matches NULL and 'primary'; others match exactly.
  const safeCategory = typeof category === 'string' && category.length > 0 ? category : null;
  if (safeCategory && safeCategory !== 'primary') {
    const catParam = `$${p++}`;
    values.push(safeCategory);
    if (withSent) {
      whereConditions.push(`(
        (m.folder = 'INBOX' AND m.category = ${catParam})
        OR (${sentEligibleSql('m')} AND EXISTS (
          SELECT 1 FROM messages cat_inb
          WHERE cat_inb.account_id = m.account_id AND cat_inb.thread_key = m.thread_key
            AND cat_inb.folder = 'INBOX' AND cat_inb.is_deleted = false AND NOT ${draftSql('cat_inb')}
            AND cat_inb.category = ${catParam}
        ))
      )`);
    } else {
      whereConditions.push(`m.category = ${catParam}`);
    }
  } else if (safeCategory === 'primary') {
    if (withSent) {
      whereConditions.push(`(
        (m.folder = 'INBOX' AND (m.category IS NULL OR m.category = 'primary'))
        OR (${sentEligibleSql('m')} AND (
          EXISTS (
            SELECT 1 FROM messages cat_inb
            WHERE cat_inb.account_id = m.account_id AND cat_inb.thread_key = m.thread_key
              AND cat_inb.folder = 'INBOX' AND cat_inb.is_deleted = false AND NOT ${draftSql('cat_inb')}
              AND (cat_inb.category IS NULL OR cat_inb.category = 'primary')
          ) OR (
            NOT EXISTS (
              SELECT 1 FROM messages cat_inb
              WHERE cat_inb.account_id = m.account_id AND cat_inb.thread_key = m.thread_key
                AND cat_inb.folder = 'INBOX' AND cat_inb.is_deleted = false AND NOT ${draftSql('cat_inb')}
            ) AND (m.category IS NULL OR m.category = 'primary')
          )
        ))
      )`);
    } else {
      whereConditions.push(`(m.category IS NULL OR m.category = 'primary')`);
    }
  }

  // #407: hide UID-only placeholder rows whose envelope has not been fetched yet. During a
  // rapid archive/reconcile overlap a UID can be listed before its envelope arrives, rendering
  // as an "Unknown / (no subject)" ghost row. A genuine message always carries at least a
  // Message-ID, a real subject, or a snippet, so this predicate only ever hides the hollow
  // placeholder, never a real message. Applies to both the flat and threaded queries (shared
  // `where`), so pagination and the threaded count stay consistent.
  whereConditions.push(NOT_PLACEHOLDER_SQL);

  const where = whereConditions.join(' AND ');

  // The Snoozed view keeps its own order: soonest back first.
  const order = {
    sort: !isSnoozedView && LIST_SORTS.includes(sort) ? sort : 'date',
    dir: !isSnoozedView && dir === 'asc' ? 'asc' : 'desc',
    starredFirst: !isSnoozedView && (starredFirst === 'true' || starredFirst === true),
  };

  const safeLimit  = Math.min(Math.max(parseInt(limit)  || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset) || 0, 0);

  let total = 0;
  try {
    if (safeCategory && !isSnoozedView) {
      // A category tab lists only that category's mail; the folder's counts are of all its mail,
      // so the list offered pages, or a "Load more", with nothing on them (#611). Counted by
      // row, as the threaded list is.
      const r = await query(`${withRolePrefix}SELECT COUNT(*)::int AS n FROM messages m WHERE ${where}`, values);
      total = r.rows[0]?.n ?? 0;
    } else if (isSpecificAccount) {
      const r = await query(
        'SELECT total_count, unread_count FROM folders WHERE account_id = $1 AND path = $2',
        [accountId, folder]
      );
      if (r.rows.length) {
        total = isUnreadOnly ? (r.rows[0].unread_count ?? 0) : (r.rows[0].total_count ?? 0);
      }
    } else {
      const unifiedPath = isSnoozedView ? SNOOZED_FOLDER : 'INBOX';
      // Snoozed mail outside the folder named Snoozed is counted by row, as it is listed: the count
      // of the folder it is in takes in that folder's other mail too.
      const plusSnoozedElsewhere = isSnoozedView
        ? ' + (SELECT COUNT(*)::int FROM messages m WHERE m.account_id = ANY($1) AND m.folder <> $2'
          + ` AND m.is_deleted = false${isUnreadOnly ? ' AND m.is_read = false' : ''} AND ${snoozedElsewhereSql('$1')})`
        : '';
      const r = isUnreadOnly
        ? await query(
            `SELECT COALESCE(SUM(unread_count), 0)::int${plusSnoozedElsewhere} AS n FROM folders WHERE account_id = ANY($1) AND path = $2`,
            [scopedAccountIds, unifiedPath]
          )
        : await query(
            `SELECT COALESCE(SUM(total_count), 0)::int${plusSnoozedElsewhere} AS n FROM folders WHERE account_id = ANY($1) AND path = $2`,
            [scopedAccountIds, unifiedPath]
          );
      total = r.rows[0]?.n ?? 0;
    }
  } catch {
    total = 0;
  }

  if (isThreaded) {
    const filterValues = [...values];
    const threadAccountParam = isSpecificAccount ? [resolvedAccountId] : scopedAccountIds;
    const unreadSql = isUnreadOnly ? ' AND m.is_read = false' : '';

    // Full-scan threaded CTE (used for non-date sorts, starredFirst, category tabs, deep offsets,
    // or as a guaranteed-exact fallback when a mega-thread fills the fast index-ordered window).
    const runFullThreadedQuery = async (fetchLimit) => query(`
      WITH ${roleCtes ? `${roleCtes},\n      ` : ''}paged_threads AS (
        SELECT m.thread_key AS thread_id,
               -- Starred on top orders by any starred message (listOrderSql); see others_starred.
               COUNT(*) FILTER (WHERE m.is_starred)::int AS starred_count,
               -- The page's own order, which the rows are returned in at the end.
               ROW_NUMBER() OVER (ORDER BY ${listOrderSql({ ...order, threaded: true })}) AS pos
        FROM messages m
        WHERE ${where}
        GROUP BY m.thread_key
        -- thread_key breaks exact date ties so paging is stable (see the flat query).
        ORDER BY ${listOrderSql({ ...order, threaded: true })}
        LIMIT $${p + 1} OFFSET $${p + 2}
      ),
      deduped AS MATERIALIZED (
        SELECT DISTINCT ON (m.account_id, m.thread_key, m.message_id)
               m.id, m.uid, m.folder, m.message_id,
               m.thread_key AS thread_id,
               m.subject, m.from_name, m.from_email,
               m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to, m.thread_references,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id, m.category,
               m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
               m.spam_verdict, m.spam_user_override, m.spam_score_ml,
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
               -- Per account, not per Message-ID: one email delivered to two connected
               -- accounts is two messages in the thread (see the thread route), so the badge
               -- has to count both or it reads 1 beside a conversation holding 2 (#476).
               COUNT(DISTINCT (m.account_id, m.message_id))::int AS message_count
        FROM messages m
        -- Every folder, not just the one listed: the badge has to match what expanding the
        -- row or opening the conversation shows, and the thread route loads the thread from
        -- all folders. An INBOX-only count left your own replies (in Sent) out, so a received
        -- message plus your reply counted 1, and the row could neither expand nor open the
        -- conversation view until a second reply arrived (#576).
        --
        -- Except drafts. A count of 2 makes the row a conversation, and deleting or moving a
        -- conversation takes every message in it; a deleted draft is expunged for good. A saved
        -- reply must not turn its message into a conversation and be swept away with it. A draft
        -- is known by its IMAP Draft flag or by its folder (draftMessageSql in mailUtils.js).
        WHERE m.account_id = ANY($${p})
          AND m.is_deleted = false
          AND m.message_id IS NOT NULL
          AND NOT ${draftSql('m')}
          AND m.thread_key IN (SELECT thread_id FROM paged_threads)
        GROUP BY m.thread_key
      ),
      ranked AS (
        SELECT d.*,
               COALESCE(tt.message_count, 1) AS message_count,
               COUNT(*) FILTER (WHERE NOT d.is_read) OVER (PARTITION BY d.thread_id)::int AS unread_count,
               FIRST_VALUE(d.subject)           OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_subject,
               FIRST_VALUE(d.from_name)         OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_from_name,
               FIRST_VALUE(d.from_email)        OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_from_email,
               FIRST_VALUE(d.has_contact_photo) OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_has_contact_photo,
               FIRST_VALUE(d.to_addresses)      OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_to_addresses,
               FIRST_VALUE(d.folder)            OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_folder,
               -- Representative for the thread row. On an exact date tie prefer the UNREAD
               -- copy (is_read ASC puts false first), so a thread holding unread mail never
               -- renders as its already-read duplicate; d.id keeps the choice deterministic.
               ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.date DESC, d.is_read ASC, d.id) AS rn
        FROM deduped d
        LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
      )
      SELECT id, uid, folder, message_id, thread_id, thread_subject AS subject,
             thread_from_name AS from_name, thread_from_email AS from_email,
             from_name AS reply_from_name, from_email AS reply_from_email, subject AS reply_subject,
             thread_to_addresses, thread_folder,
             to_addresses, cc_addresses, reply_to, in_reply_to, thread_references,
             date, snippet, is_starred, is_read, has_attachments, account_id,
             account_name, account_email, account_color,
             category, list_unsubscribe, list_unsubscribe_post, delivery_addresses,
             spam_verdict, spam_user_override, spam_score_ml,
             message_count, unread_count,
             thread_has_contact_photo AS has_contact_photo,
             -- Whether a message other than the row's own is starred: the client sorts the row as
             -- starred when either is, so starring or unstarring the row moves it as the server would.
             (pt.starred_count - CASE WHEN is_starred THEN 1 ELSE 0 END) > 0 AS others_starred
      FROM ranked
      JOIN paged_threads pt USING (thread_id)
      WHERE rn = 1
      ORDER BY pt.pos
    `, [...filterValues, threadAccountParam, fetchLimit, safeOffset]);

    const runThreadCountQuery = async () => {
      if (withSent && !safeCategory) {
        const inboxBranch = isSpecificAccount
          ? `SELECT m.thread_key FROM messages m WHERE m.account_id = $1 AND m.folder = $2 AND m.is_deleted = false${unreadSql} AND ${NOT_PLACEHOLDER_SQL}`
          : `SELECT m.thread_key FROM unnest($1::uuid[]) AS acc(account_id) JOIN messages m ON m.account_id = acc.account_id AND m.folder = 'INBOX' WHERE m.is_deleted = false${unreadSql} AND ${NOT_PLACEHOLDER_SQL}`;
        return query(`
          ${withRolePrefix}SELECT COUNT(DISTINCT thread_key)::int AS total FROM (
            ${inboxBranch}
            UNION ALL
            SELECT m.thread_key
            FROM _sent_folders sf
            JOIN messages m ON m.account_id = sf.account_id AND m.folder = sf.folder
            WHERE m.is_deleted = false${unreadSql} AND ${NOT_PLACEHOLDER_SQL} AND ${sentEligibilityBodySql('m')}
          ) _u
        `, filterValues);
      }
      return query(`
        ${withRolePrefix}SELECT COUNT(DISTINCT m.thread_key)::int AS total
        FROM messages m
        WHERE ${where}
      `, filterValues);
    };

    const canUseFastThreadWindow = order.sort === 'date'
      && order.dir === 'desc'
      && !order.starredFirst
      && !safeCategory
      && (safeOffset + safeLimit) <= FAST_THREAD_MAX_REACH;

    let rawRows;
    let exactTotalFromWindow = null;

    if (canUseFastThreadWindow) {
      const windowLimit = Math.max((safeOffset + safeLimit + 1) * 6, 300);
      const winParam = `$${p + 1}`;
      const limParam = `$${p + 2}`;
      const offParam = `$${p + 3}`;

      // Index-ordered recent scan: pulls the newest windowLimit rows per folder via
      // idx_messages_list / idx_messages_list_unread instead of grouping the entire mailbox.
      // Any thread with MAX(date) strictly above the window boundary is guaranteed to have
      // its exact global MAX(date) and ordering; if fewer than offset+limit+1 threads lie
      // above the boundary (e.g. a mega-thread), we fall back cleanly to runFullThreadedQuery.
      const inboxRecentSql = isSpecificAccount
        ? `SELECT m.thread_key, m.date
           FROM messages m
           WHERE m.account_id = $1 AND m.folder = $2
             AND m.is_deleted = false${unreadSql} AND ${NOT_PLACEHOLDER_SQL}
           ORDER BY m.date DESC, m.id ASC
           LIMIT ${winParam}`
        : `SELECT x.thread_key, x.date
           FROM unnest($1::uuid[]) AS acc(account_id)
           CROSS JOIN LATERAL (
             SELECT m.thread_key, m.date, m.id
             FROM messages m
             WHERE m.account_id = acc.account_id AND m.folder = 'INBOX'
               AND m.is_deleted = false${unreadSql} AND ${NOT_PLACEHOLDER_SQL}
             ORDER BY m.date DESC, m.id ASC
             LIMIT ${winParam}
           ) x
           ORDER BY x.date DESC, x.id ASC
           LIMIT ${winParam}`;

      const sentRecentCtes = withSent ? `,
      _sent_recent AS MATERIALIZED (
        SELECT s.thread_key, s.date
        FROM _sent_folders sf
        CROSS JOIN LATERAL (
          SELECT m.thread_key, m.date, m.id
          FROM messages m
          WHERE m.account_id = sf.account_id AND m.folder = sf.folder
            AND m.is_deleted = false${unreadSql} AND ${NOT_PLACEHOLDER_SQL}
            AND m.date >= COALESCE(
              (SELECT CASE WHEN cnt >= ${winParam} THEN min_date END FROM _inbox_bound),
              '-infinity'::timestamptz
            )
            AND ${sentEligibilityBodySql('m')}
          ORDER BY m.date DESC, m.id ASC
          LIMIT ${winParam}
        ) s
        ORDER BY s.date DESC, s.id ASC
        LIMIT ${winParam}
      ),
      _sent_bound AS MATERIALIZED (
        SELECT COUNT(*)::int AS cnt, MIN(date) AS min_date FROM _sent_recent
      ),
      _combined AS (
        SELECT thread_key, date FROM _inbox_recent
        UNION ALL
        SELECT thread_key, date FROM _sent_recent
      )` : '';

      const strictSource = withSent ? '_combined' : '_inbox_recent';
      const strictHaving = withSent
        ? `((SELECT cnt FROM _inbox_bound) < ${winParam} OR MAX(c.date) > (SELECT min_date FROM _inbox_bound))
           AND ((SELECT cnt FROM _sent_bound) < ${winParam} OR MAX(c.date) > (SELECT min_date FROM _sent_bound))`
        : `((SELECT cnt FROM _inbox_bound) < ${winParam} OR MAX(c.date) > (SELECT min_date FROM _inbox_bound))`;
      const exhaustedExpr = withSent
        ? `((SELECT cnt FROM _inbox_bound) < ${winParam} AND (SELECT cnt FROM _sent_bound) < ${winParam})`
        : `((SELECT cnt FROM _inbox_bound) < ${winParam})`;

      const fastResult = await query(`
        WITH ${roleCtes ? `${roleCtes},\n        ` : ''}_inbox_recent AS MATERIALIZED (
          ${inboxRecentSql}
        ),
        _inbox_bound AS MATERIALIZED (
          SELECT COUNT(*)::int AS cnt, MIN(date) AS min_date FROM _inbox_recent
        )${sentRecentCtes},
        _strict_threads AS MATERIALIZED (
          SELECT c.thread_key AS thread_id, MAX(c.date) AS max_date
          FROM ${strictSource} c
          GROUP BY c.thread_key
          HAVING ${strictHaving}
        ),
        _window_meta AS MATERIALIZED (
          SELECT (SELECT COUNT(*)::int FROM _strict_threads) AS strict_total,
                 ${exhaustedExpr} AS exhausted
        ),
        paged_threads AS MATERIALIZED (
          SELECT thread_id,
                 ROW_NUMBER() OVER (ORDER BY max_date DESC, thread_id) AS pos
          FROM _strict_threads
          ORDER BY max_date DESC, thread_id
          LIMIT ${limParam} OFFSET ${offParam}
        ),
        _page_msgs AS MATERIALIZED (
          SELECT m.*
          FROM paged_threads pt
          JOIN messages m ON m.thread_key = pt.thread_id
          WHERE ${where}
        ),
        deduped AS MATERIALIZED (
          SELECT DISTINCT ON (m.account_id, m.thread_key, m.message_id)
                 m.id, m.uid, m.folder, m.message_id,
                 m.thread_key AS thread_id,
                 m.subject, m.from_name, m.from_email,
                 m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to, m.thread_references,
                 m.date, m.snippet, m.is_read, m.is_starred,
                 m.has_attachments, m.account_id, m.category,
                 m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
                 m.spam_verdict, m.spam_user_override, m.spam_score_ml,
                 a.name  AS account_name,
                 a.email_address AS account_email,
                 a.color AS account_color,
                 (co.id IS NOT NULL) AS has_contact_photo
          FROM _page_msgs m
          JOIN email_accounts a ON m.account_id = a.id
          LEFT JOIN contacts co ON co.user_id = a.user_id
                                AND co.primary_email = lower(m.from_email)
                                AND co.photo_data IS NOT NULL
          ORDER BY m.account_id,
                   m.thread_key,
                   m.message_id,
                   CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                   m.date ASC
        ),
        thread_stars AS (
          SELECT m.thread_key AS thread_id,
                 COUNT(*) FILTER (WHERE m.is_starred)::int AS starred_count
          FROM _page_msgs m
          GROUP BY m.thread_key
        ),
        thread_totals AS (
          SELECT m.thread_key AS thread_id,
                 COUNT(DISTINCT (m.account_id, m.message_id))::int AS message_count
          FROM messages m
          WHERE m.account_id = ANY($${p})
            AND m.is_deleted = false
            AND m.message_id IS NOT NULL
            AND NOT ${draftSql('m')}
            AND m.thread_key IN (SELECT thread_id FROM paged_threads)
          GROUP BY m.thread_key
        ),
        ranked AS (
          SELECT d.*,
                 COALESCE(tt.message_count, 1) AS message_count,
                 COUNT(*) FILTER (WHERE NOT d.is_read) OVER (PARTITION BY d.thread_id)::int AS unread_count,
                 FIRST_VALUE(d.subject)           OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_subject,
                 FIRST_VALUE(d.from_name)         OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_from_name,
                 FIRST_VALUE(d.from_email)        OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_from_email,
                 FIRST_VALUE(d.has_contact_photo) OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_has_contact_photo,
                 FIRST_VALUE(d.to_addresses)      OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_to_addresses,
                 FIRST_VALUE(d.folder)            OVER (PARTITION BY d.thread_id ORDER BY d.date ASC, d.id ASC) AS thread_folder,
                 ROW_NUMBER() OVER (PARTITION BY d.thread_id ORDER BY d.date DESC, d.is_read ASC, d.id) AS rn
          FROM deduped d
          LEFT JOIN thread_totals tt ON tt.thread_id = d.thread_id
        )
        SELECT r.id, r.uid, r.folder, r.message_id, r.thread_id, r.subject,
               r.from_name, r.from_email,
               r.reply_from_name, r.reply_from_email, r.reply_subject,
               r.thread_to_addresses, r.thread_folder,
               r.to_addresses, r.cc_addresses, r.reply_to, r.in_reply_to, r.thread_references,
               r.date, r.snippet, r.is_starred, r.is_read, r.has_attachments, r.account_id,
               r.account_name, r.account_email, r.account_color,
               r.category, r.list_unsubscribe, r.list_unsubscribe_post, r.delivery_addresses,
               r.spam_verdict, r.spam_user_override, r.spam_score_ml,
               r.message_count, r.unread_count,
               r.has_contact_photo,
               r.others_starred,
               _wm.strict_total AS _strict_total,
               _wm.exhausted AS _window_exhausted
        FROM _window_meta _wm
        LEFT JOIN (
          SELECT id, uid, folder, message_id, thread_id, thread_subject AS subject,
                 thread_from_name AS from_name, thread_from_email AS from_email,
                 from_name AS reply_from_name, from_email AS reply_from_email, subject AS reply_subject,
                 thread_to_addresses, thread_folder,
                 to_addresses, cc_addresses, reply_to, in_reply_to, thread_references,
                 date, snippet, is_starred, is_read, has_attachments, account_id,
                 account_name, account_email, account_color,
                 category, list_unsubscribe, list_unsubscribe_post, delivery_addresses,
                 spam_verdict, spam_user_override, spam_score_ml,
                 message_count, unread_count,
                 thread_has_contact_photo AS has_contact_photo,
                 (COALESCE(ts.starred_count, 0) - CASE WHEN is_starred THEN 1 ELSE 0 END) > 0 AS others_starred,
                 pt.pos
          FROM ranked
          JOIN paged_threads pt USING (thread_id)
          LEFT JOIN thread_stars ts USING (thread_id)
          WHERE rn = 1
        ) r ON true
        WHERE r.id IS NOT NULL OR NOT _wm.exhausted
        ORDER BY r.pos NULLS LAST
      `, [...filterValues, threadAccountParam, windowLimit, safeLimit + 1, safeOffset]);

      const fastRows = fastResult.rows;
      if (fastRows.length > 0 && fastRows[0]._window_exhausted !== undefined) {
        const exhausted = Boolean(fastRows[0]._window_exhausted);
        const strictTotal = Number(fastRows[0]._strict_total) || 0;
        const windowSufficient = exhausted || strictTotal >= safeOffset + safeLimit + 1;
        if (!windowSufficient) {
          const fallback = await runFullThreadedQuery(safeLimit + 1);
          rawRows = fallback.rows;
        } else {
          rawRows = fastRows
            .filter(r => r.id != null)
            .map((r) => {
              const row = { ...r };
              delete row._strict_total;
              delete row._window_exhausted;
              return row;
            });
          if (exhausted) exactTotalFromWindow = strictTotal;
        }
      } else {
        rawRows = fastRows;
      }
    } else {
      const fullResult = await runFullThreadedQuery(safeLimit + 1);
      rawRows = fullResult.rows;
    }

    const hasMore = rawRows.length > safeLimit;
    const pageRows = hasMore ? rawRows.slice(0, safeLimit) : rawRows;

    let threadedTotal;
    if (exactTotalFromWindow !== null) {
      threadedTotal = exactTotalFromWindow;
    } else if (!isUnreadOnly && !safeCategory && total > LARGE_THREADED_COUNT_THRESHOLD) {
      threadedTotal = hasMore
        ? Math.max(total, safeOffset + safeLimit + 1)
        : (pageRows.length > 0 ? safeOffset + pageRows.length : 0);
    } else {
      const threadCountResult = await runThreadCountQuery();
      threadedTotal = threadCountResult.rows[0]?.total ?? 0;
    }

    return {
      messages: pageRows,
      total: threadedTotal,
      threaded: true,
      resolvedAccountId,
    };
  }

  const limitParam  = p;
  const offsetParam = p + 1;
  values.push(safeLimit, safeOffset);

  const result = await query(`
    SELECT m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
           m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to, m.thread_references,
           m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id, m.category,
           m.list_unsubscribe, m.list_unsubscribe_post, m.delivery_addresses,
           m.spam_verdict, m.spam_user_override, m.spam_score_ml,
           a.name as account_name, a.email_address as account_email, a.color as account_color,
           (co.id IS NOT NULL) AS has_contact_photo${isSnoozedView ? ', sz.snooze_until, sz.snoozed_folder' : ''}
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    LEFT JOIN contacts co ON co.user_id = a.user_id
                          AND co.primary_email = lower(m.from_email)
                          AND co.photo_data IS NOT NULL${isSnoozedView ? `
    -- When it comes back: its live snooze record (routes/mail.js LIVE_SNOOZE_SQL's match). The
    -- record's folder tells the client the mail is snoozed where the folder is not named Snoozed.
    LEFT JOIN LATERAL (
      SELECT sm.snooze_until, sm.snoozed_folder FROM snoozed_messages sm
      WHERE sm.account_id = m.account_id AND sm.message_id_header = m.message_id
        AND sm.snoozed_folder = m.folder
      ORDER BY sm.snooze_until LIMIT 1
    ) sz ON true` : ''}
    WHERE ${where}
    -- m.id breaks exact date ties. Without it the sort is unspecified, so LIMIT/OFFSET
    -- paging could show a row twice or skip it entirely, and the client-side duplicate
    -- collapse would receive the two copies of a message in an arbitrary order.
    ORDER BY ${isSnoozedView ? 'sz.snooze_until ASC NULLS LAST, m.date DESC, m.id' : listOrderSql(order)}
    LIMIT $${limitParam} OFFSET $${offsetParam}
  `, values);

  return {
    messages: result.rows,
    total,
    resolvedAccountId,
  };
}
