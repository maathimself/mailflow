import { query } from './db.js';

// Generic thread-aware "labels" READ capability (v3.0 plugin platform).
//
// Given a set of label folders for one account, return the thread HEADS grouped by label,
// with per-label total/unread counts and a deduped union rollup. Everything correctness-
// critical about reading labels lives here so features — and, later, sandboxed plugins —
// never run raw SQL:
//   • the head prefers the (often older) label-folder copy so its id is stable for as long
//     as the thread is in a section (a transient INBOX copy could be archived out from under
//     the feed, leaving the client deep-linking to a since-deleted id);
//   • "unread" is THREAD-LEVEL — a thread is unread while ANY of its non-deleted, non-draft
//     copies is unread, so a read label-folder head can't mask an unread INBOX-only reply;
//   • `in_inbox` / `folders` expose the full cross-folder picture (archived-but-labelled vs
//     still-in-box);
//   • the union rollup deduplicates a thread that carries two of the union labels.
//
// GTD is the first consumer — its states (Todo/Watch/Delegated/…) are just labels whose
// folders come from its own config. The `state` column in the result is the label identifier
// (named for that first consumer). Per-account only: a thread spanning accounts is counted
// independently per account (the caller merges/dedupes across accounts).
//
// Params: $1 accountId, $2 label names[], $3 label folder paths[] (parallel to $2),
//         $4 draft folder paths[] (excluded), $5 per-label limit,
//         $6 union label names[] (the subset of $2 rolled up into one deduped count).
const SECTION_SQL = `
  WITH gtd(state, folder) AS (
    SELECT * FROM unnest($2::text[], $3::text[])
  ),
  msg AS (
    SELECT m.id, m.account_id, m.thread_key, m.message_id, m.folder,
           m.subject, m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred, m.uid
    FROM messages m
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder
      AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.account_id = $1
      AND m.is_deleted = false
      AND m.metadata_complete = true
      AND m.folder <> ALL($4::text[])
  ),
  folders_agg AS (
    SELECT thread_key,
           array_agg(DISTINCT folder) AS folders,
           bool_or(folder = 'INBOX')  AS in_inbox,
           bool_or(NOT is_read)       AS thread_unread
    FROM msg
    GROUP BY thread_key
  ),
  head AS (
    SELECT DISTINCT ON (account_id, thread_key)
           thread_key, account_id, message_id, folder,
           subject, from_name, from_email, date, snippet, is_starred, uid, id
    FROM msg
    ORDER BY account_id, thread_key, (folder IN (SELECT folder FROM gtd)) DESC, date DESC, id DESC
  ),
  thread_state AS (
    SELECT DISTINCT msg.thread_key, gtd.state
    FROM msg
    JOIN gtd ON gtd.folder = msg.folder
  ),
  waiting_agg AS (
    SELECT
      COUNT(DISTINCT ts.thread_key)                                  AS waiting_total,
      COUNT(DISTINCT ts.thread_key) FILTER (WHERE fa.thread_unread)  AS waiting_unread
    FROM thread_state ts
    JOIN folders_agg fa ON fa.thread_key = ts.thread_key
    WHERE ts.state = ANY($6::text[])
  ),
  ranked AS (
    SELECT ts.state,
           h.thread_key, h.account_id, h.message_id, h.folder,
           h.subject, h.from_name, h.from_email, h.date, h.snippet, h.is_starred, h.uid, h.id,
           fa.folders, fa.in_inbox, fa.thread_unread,
           COUNT(*)                                  OVER (PARTITION BY ts.state) AS total,
           COUNT(*) FILTER (WHERE fa.thread_unread)  OVER (PARTITION BY ts.state) AS unread,
           ROW_NUMBER() OVER (PARTITION BY ts.state ORDER BY h.date DESC, h.id DESC) AS rn
    FROM thread_state ts
    JOIN head h         ON h.thread_key = ts.thread_key
    JOIN folders_agg fa ON fa.thread_key = ts.thread_key
  )
  SELECT state, thread_key, account_id, message_id, folder,
         subject, from_name, from_email, date, snippet, is_starred, uid, id,
         folders, in_inbox, thread_unread, total::int AS total, unread::int AS unread,
         waiting_total::int AS waiting_total, waiting_unread::int AS waiting_unread
  FROM ranked
  CROSS JOIN waiting_agg
  WHERE rn <= $5
  ORDER BY state, rn
`;

// One per-account pass: thread heads per label, each label's total/unread counts, and a
// deduped union rollup (waiting_total/waiting_unread, constant across the returned rows).
// Returns the raw rows; mapping/presentation is the caller's.
export async function listThreadHeadsByLabels(accountId, { labels, labelFolders, draftFolders, limit, unionLabels }) {
  const { rows } = await query(SECTION_SQL, [accountId, labels, labelFolders, draftFolders, limit, unionLabels]);
  return rows;
}

// Generic "did a mail mutation touch a labelled thread?" notify capability (v3.0 plugin
// platform). An ordinary mutation Mailflow itself writes to the DB (archive, delete, move,
// snooze, read, star) never trips the periodic sync tick — which only re-emits when the IMAP
// server's fingerprint moves — so a label-driven feed can lag a full tick behind. This lets a
// feature (and, later, a sandboxed plugin) ask core to broadcast a scoped refresh event to the
// owning user IFF the mutation was relevant to its labels. Relevance is either:
//   1. one of the acted messages still shares its RFC Message-ID with a live row in one of the
//      label folders (the thread has, or is, a label copy) — `messageIds` are RFC Message-IDs
//      (not row PKs) so this survives the acted row being moved/deleted by the mutation; or
//   2. one of the acted rows' PRE-mutation folders was itself a label folder — covers a
//      mutation that removes the last label copy of a thread, where #1 finds nothing.
// #2 is a pure in-memory check (no query). #1 is one indexed EXISTS. `event` is the broadcast
// type; the plugin never names another user — the broadcast is scoped to `userId`. imapManager
// is injected so this stays unit-testable without a live socket server. Returns whether it
// broadcast.
export async function notifyOnLabelTouch(imapManager, { accountId, userId, messageIds, actedFolders, labelFolders, event }) {
  if (!accountId || !userId || !event) return false;
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  if (!ids.length) return false;
  const folderPaths = [...new Set(labelFolders || [])];
  if (!folderPaths.length) return false;

  const folderSet = new Set(folderPaths);
  const preMutationHit = (actedFolders || []).some(f => folderSet.has(f));

  const { rows } = await query(
    `SELECT 1 FROM messages
      WHERE account_id = $1
        AND message_id = ANY($2::text[])
        AND folder = ANY($3::text[])
        AND is_deleted = false
      LIMIT 1`,
    [accountId, ids, folderPaths]
  );
  if (preMutationHit || rows.length) {
    imapManager.broadcast({ type: event, accountId }, userId);
    return true;
  }
  return false;
}
