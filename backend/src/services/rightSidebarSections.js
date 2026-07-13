import { query } from './db.js';
import { getRightSidebarConfig } from './rightSidebarConfig.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

// Heads only ever come from a configured folder, so only threads that show up in one can
// reach the output — bounding `msg` to those threads keeps the folder rollup off the whole
// mailbox. Every other non-draft copy of such a thread is still there, which is what makes
// a thread unread when only its INBOX copy is.
const SECTION_SQL = `
  WITH configured(path, ordinal) AS (
    SELECT * FROM unnest($2::text[], $3::int[])
  ),
  label_threads AS (
    SELECT DISTINCT m.thread_key
    FROM messages m
    WHERE m.account_id = $1
      AND m.is_deleted = false
      AND m.folder = ANY($2::text[])
      AND m.folder <> ALL($4::text[])
  ),
  msg AS (
    SELECT m.id, m.account_id, m.thread_key, m.message_id, m.folder,
           m.subject, m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred, m.uid
    FROM messages m
    JOIN label_threads lt ON lt.thread_key = m.thread_key
    WHERE m.account_id = $1
      AND m.is_deleted = false
      AND m.folder <> ALL($4::text[])
  ),
  folders_agg AS (
    SELECT thread_key,
           array_agg(DISTINCT folder) AS folders,
           bool_or(folder = 'INBOX') AS in_inbox,
           bool_or(NOT is_read) AS thread_unread
    FROM msg
    GROUP BY thread_key
  ),
  head AS (
    SELECT DISTINCT ON (c.ordinal, m.thread_key)
           c.path AS section_path, c.ordinal,
           m.id, m.account_id, m.thread_key, m.message_id, m.folder,
           m.subject, m.from_name, m.from_email, m.date, m.snippet, m.is_starred, m.uid
    FROM configured c
    JOIN msg m ON m.folder = c.path
    ORDER BY c.ordinal, m.thread_key, m.date DESC, m.id DESC
  ),
  ranked AS (
    SELECT h.*, fa.folders, fa.in_inbox, fa.thread_unread,
           COUNT(*) OVER (PARTITION BY h.section_path) AS total,
           COUNT(*) FILTER (WHERE fa.thread_unread) OVER (PARTITION BY h.section_path) AS unread,
           ROW_NUMBER() OVER (PARTITION BY h.section_path ORDER BY h.date DESC, h.id DESC) AS rn
    FROM head h
    JOIN folders_agg fa ON fa.thread_key = h.thread_key
  )
  SELECT c.path AS section_path, c.ordinal, f.path IS NOT NULL AS available, f.name AS section_name,
         r.id, r.account_id, r.thread_key, r.message_id, r.folder,
         r.subject, r.from_name, r.from_email, r.date, r.snippet, r.is_starred, r.uid,
         r.folders, r.in_inbox, r.thread_unread, r.total::int, r.unread::int
  FROM configured c
  LEFT JOIN folders f ON f.account_id = $1 AND f.path = c.path
  LEFT JOIN ranked r ON r.section_path = c.path AND r.rn <= $5
  ORDER BY c.ordinal, r.rn NULLS LAST
`;

// name falls back to the path until the folder row is seen — a folder that has vanished
// from the server has no display name left to show.
function emptySection(path) {
  return { path, name: path, available: false, total: 0, unread: 0, threads: [] };
}

function mapHead(row) {
  return {
    id: row.id,
    account_id: row.account_id,
    message_id: row.message_id,
    thread_key: row.thread_key,
    subject: row.subject,
    from_name: row.from_name,
    from_email: row.from_email,
    date: row.date,
    snippet: row.snippet,
    is_read: !row.thread_unread,
    is_starred: row.is_starred === true,
    uid: row.uid,
    folder: row.folder,
    folders: row.folders || [],
    in_inbox: row.in_inbox === true,
  };
}

export async function getRightSidebarSections({ userId, accountId = null, limit } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const accountsResult = await query(
    `SELECT id, folder_mappings FROM email_accounts
      WHERE user_id = $1 AND enabled = true
      ORDER BY sort_order, created_at`,
    [userId]
  );
  let targets = accountsResult.rows;
  if (accountId) targets = targets.filter(account => account.id === accountId);
  if (!targets.length) return { sections: [] };

  const sections = new Map();
  for (const account of targets) {
    const labels = await getRightSidebarConfig(account.id);
    for (const path of labels) {
      if (!sections.has(path)) sections.set(path, emptySection(path));
    }
    if (!labels.length) continue;

    // sanitizeRightSidebarLabels rejects real drafts folders (exact draft/drafts segments)
    // at write time, so any configured path caught by the '%draft%' name heuristic here is a
    // substring false positive (e.g. "Draft Proposals") and must stay aggregatable, not blanked.
    const draftPaths = [...(await resolveAllDraftsPaths(account.id, account.folder_mappings))]
      .filter(path => !labels.includes(path));
    const ordinals = labels.map((_, index) => index);
    const result = await query(SECTION_SQL, [account.id, labels, ordinals, draftPaths, safeLimit]);
    const counted = new Set();
    for (const row of result.rows) {
      const section = sections.get(row.section_path);
      if (!section) continue;
      if (row.available === true) section.available = true;
      // Show the folder's display name ("Clients"), not its full path ("Work/Clients").
      if (row.section_name) section.name = row.section_name;
      if (!counted.has(row.section_path)) {
        section.total += Number(row.total) || 0;
        section.unread += Number(row.unread) || 0;
        counted.add(row.section_path);
      }
      if (row.id) section.threads.push(mapHead(row));
    }
  }

  for (const section of sections.values()) {
    section.threads.sort((a, b) => new Date(b.date) - new Date(a.date));
    const seen = new Set();
    section.threads = section.threads
      .filter(thread => {
        const key = `${thread.account_id}\0${thread.message_id || thread.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, safeLimit);
  }

  return { sections: [...sections.values()] };
}
