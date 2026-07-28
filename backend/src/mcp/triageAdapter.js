// SQL owner for the inbox-triage MCP surface. Handlers validate and shape wire
// envelopes; this adapter keeps every read/checkpoint query scoped to accountIds.
import { query } from '../services/db.js';

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (
      !parsed
      || typeof parsed.d !== 'string'
      || !parsed.d
      || typeof parsed.h !== 'string'
      || !parsed.h
    ) {
      throw new Error('invalid shape');
    }
    return parsed;
  } catch {
    throw new Error('invalid triage cursor');
  }
}

function encodeCursor(row) {
  if (!row) return null;
  const date = row.date instanceof Date ? row.date.toISOString() : row.date;
  return Buffer.from(JSON.stringify({ d: date, h: row.message_id }), 'utf8').toString('base64');
}

export async function listTriageCandidates({
  accountIds,
  cursor,
  limit = 25,
  unreadOnly = true,
  includeTriaged = false,
  categories,
  since,
}) {
  const pageLimit = Number(limit);
  if (!accountIds?.length) return { rows: [], hasMore: false, cursor: null };

  const params = [accountIds];
  const bind = value => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [
    'm.account_id = ANY($1)',
    "m.folder = 'INBOX'",
    'm.is_deleted = false',
    'm.message_id IS NOT NULL',
  ];

  if (unreadOnly) where.push('m.is_read = false');
  if (!includeTriaged) {
    where.push(`NOT EXISTS (
      SELECT 1
      FROM message_triage mt
      WHERE mt.account_id = m.account_id
        AND mt.message_id_header = m.message_id
    )`);
  }
  if (categories?.length) {
    where.push(`COALESCE(m.category, 'primary') = ANY(${bind(categories)})`);
  }
  if (since) where.push(`m.date >= ${bind(since)}`);

  const decodedCursor = decodeCursor(cursor);
  if (decodedCursor) {
    const dateParam = bind(decodedCursor.d);
    const headerParam = bind(decodedCursor.h);
    where.push(`(m.date, m.message_id) > (${dateParam}, ${headerParam})`);
  }

  const sql = `
    WITH sender_history AS (
      SELECT
        lower(mh.from_email) AS sender_email,
        COUNT(*)::int AS received_count,
        MIN(mh.date) AS first_received,
        MAX(mh.date) AS last_received
      FROM messages mh
      WHERE mh.account_id = ANY($1)
        AND mh.is_deleted = false
        AND mh.from_email IS NOT NULL
      GROUP BY lower(mh.from_email)
    )
    SELECT
      m.id,
      m.account_id,
      a.email_address AS account,
      m.message_id,
      m.thread_key AS conversation_id,
      m.subject,
      m.snippet,
      m.from_email,
      m.from_name,
      m.date,
      m.is_read,
      m.is_starred,
      m.has_attachments,
      COALESCE(m.category, 'primary') AS category,
      COALESCE(m.is_bulk, false) AS is_bulk,
      (m.list_unsubscribe IS NOT NULL) AS has_unsubscribe,
      m.spam_verdict,
      thread_state.message_count AS thread_message_count,
      thread_state.last_activity AS thread_last_activity,
      thread_state.i_replied,
      COALESCE(sh.received_count, 0)::int AS received_count,
      sh.first_received,
      sh.last_received,
      c.id AS contact_id,
      c.display_name AS contact_name,
      COALESCE(c.send_count, 0)::int AS send_count,
      c.last_sent,
      c.is_auto,
      (c.id IS NOT NULL) AS contact_known
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS message_count,
        MAX(t.date) AS last_activity,
        EXISTS (
          SELECT 1
          FROM messages sent
          WHERE sent.account_id = m.account_id
            AND sent.thread_key = m.thread_key
            AND sent.is_deleted = false
            AND (
              sent.folder = COALESCE(a.folder_mappings->>'sent', '')
              OR sent.folder ~* '(^|[./ ])sent($|[./ ])'
              OR EXISTS (
                SELECT 1
                FROM folders sf
                WHERE sf.account_id = sent.account_id
                  AND sf.path = sent.folder
                  AND sf.special_use = '\\Sent'
              )
            )
        ) AS i_replied
      FROM messages t
      WHERE t.account_id = m.account_id
        AND t.thread_key = m.thread_key
        AND t.is_deleted = false
    ) thread_state ON true
    LEFT JOIN sender_history sh ON sh.sender_email = lower(m.from_email)
    LEFT JOIN contacts c
      ON c.user_id = a.user_id
     AND c.primary_email = lower(m.from_email)
    WHERE ${where.join('\n      AND ')}
    ORDER BY m.date ASC, m.message_id ASC
    LIMIT ${bind(pageLimit + 1)}
  `;

  const result = await query(sql, params);
  const hasMore = result.rows.length > pageLimit;
  const rows = result.rows.slice(0, pageLimit);
  return {
    rows,
    hasMore,
    cursor: encodeCursor(rows.at(-1)),
  };
}

// Backlog total for triage_inbox's counts.untriaged_unread: unread INBOX
// messages not yet checkpointed in message_triage, regardless of paging.
export async function countUntriagedUnread(accountIds) {
  if (!accountIds?.length) return 0;
  const { rows } = await query(
    `SELECT COUNT(*) AS total
     FROM messages m
     WHERE m.account_id = ANY($1)
       AND m.folder = 'INBOX'
       AND m.is_deleted = false
       AND m.message_id IS NOT NULL
       AND m.is_read = false
       AND NOT EXISTS (
         SELECT 1
         FROM message_triage mt
         WHERE mt.account_id = m.account_id
           AND mt.message_id_header = m.message_id
       )`,
    [accountIds],
  );
  return parseInt(rows[0]?.total, 10) || 0;
}

export async function senderHistory(fromEmail, accountIds) {
  if (!fromEmail || !accountIds?.length) return null;
  const { rows } = await query(
    `WITH sender_history AS (
       SELECT
         COUNT(*)::int AS received_count,
         MIN(m.date) AS first_received,
         MAX(m.date) AS last_received
       FROM messages m
       WHERE m.account_id = ANY($1)
         AND m.is_deleted = false
         AND lower(m.from_email) = lower($2)
     )
     SELECT
       sh.received_count,
       sh.first_received,
       sh.last_received,
       c.id AS contact_id,
       c.display_name AS contact_name,
       c.primary_email,
       COALESCE(c.send_count, 0)::int AS send_count,
       c.last_sent,
       c.is_auto,
       (c.id IS NOT NULL) AS contact_known
     FROM sender_history sh
     LEFT JOIN contacts c
       ON c.user_id IN (
         SELECT a.user_id
         FROM email_accounts a
         WHERE a.id = ANY($1)
       )
      AND c.primary_email = lower($2)
     LIMIT 1`,
    [accountIds, fromEmail],
  );
  return rows[0] || null;
}

// Resolved Sent folder for disposition classification: the account's explicit
// folder_mappings.sent wins, else the IMAP \Sent special-use folder. Mirrors
// services/mail/sentCopy.js resolveSentFolder but keyed by accountId so the
// signals path never needs a full account row.
export async function sentFolderForAccount(accountId) {
  if (!accountId) return null;
  const { rows } = await query(
    `SELECT COALESCE(
       a.folder_mappings->>'sent',
       (SELECT f.path FROM folders f
        WHERE f.account_id = a.id AND f.special_use = '\\Sent'
        LIMIT 1)
     ) AS path
     FROM email_accounts a
     WHERE a.id = $1`,
    [accountId],
  );
  return rows[0]?.path || null;
}

export async function triageActionsForMessages(pairs) {
  if (!pairs?.length) return [];
  const { rows } = await query(
    `SELECT
       mt.account_id,
       mt.message_id_header,
       mt.action,
       mt.triaged_at
     FROM unnest($1::uuid[], $2::text[]) AS input(account_id, message_id_header)
     JOIN message_triage mt
       ON mt.account_id = input.account_id
      AND mt.message_id_header = input.message_id_header`,
    [
      pairs.map(pair => pair.accountId),
      pairs.map(pair => pair.messageIdHeader),
    ],
  );
  return rows;
}

export async function resolveHeadersForIds(ids, accountIds) {
  if (!ids?.length || !accountIds?.length) return [];
  const { rows } = await query(
    `SELECT id, account_id, message_id AS message_id_header
     FROM messages
     WHERE id = ANY($1::uuid[])
       AND account_id = ANY($2::uuid[])`,
    [ids, accountIds],
  );
  return rows;
}

export async function markTriaged({
  userId,
  accountIds,
  messageIds,
  action = null,
  note = null,
  tokenId = null,
}) {
  const resolved = await resolveHeadersForIds(messageIds, accountIds);
  const byId = new Map(resolved.map(row => [row.id, row]));
  const skipped = [];
  const durableByKey = new Map();

  for (const id of messageIds || []) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'not_found_or_out_of_scope' });
    } else if (!row.message_id_header) {
      skipped.push({ id, reason: 'no_message_id_header' });
    } else {
      durableByKey.set(`${row.account_id}\0${row.message_id_header}`, row);
    }
  }

  const durable = [...durableByKey.values()];
  if (!durable.length) {
    return {
      ok: true,
      marked: 0,
      newly_marked: 0,
      already_triaged: 0,
      skipped,
    };
  }

  const { rows } = await query(
    `INSERT INTO message_triage
       (user_id, account_id, message_id_header, action, note, source, token_id)
     SELECT $1, input.account_id, input.message_id_header, $4, $5, 'mcp', $6
     FROM unnest($2::uuid[], $3::text[]) AS input(account_id, message_id_header)
     ON CONFLICT (account_id, message_id_header) DO UPDATE
       SET triaged_at = NOW(),
           action = EXCLUDED.action,
           note = EXCLUDED.note
     RETURNING account_id, message_id_header, (xmax = 0) AS inserted`,
    [
      userId,
      durable.map(row => row.account_id),
      durable.map(row => row.message_id_header),
      action,
      note,
      tokenId,
    ],
  );

  const newlyMarked = rows.filter(row => row.inserted === true).length;
  return {
    ok: true,
    marked: rows.length,
    newly_marked: newlyMarked,
    already_triaged: rows.length - newlyMarked,
    skipped,
  };
}
