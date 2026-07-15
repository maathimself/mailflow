import { query } from './db.js';
import { getGtdConfig, GTD_STATES } from './gtdConfig.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';

// States the frontend merges into the single "Waiting" section (utils/gtd.js). Their
// counts must dedupe a thread holding BOTH labels; see the waiting_agg CTE below.
export const WAITING_STATES = ['watch', 'delegated'];

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

// Per-account, single-pass section query.
//
// The existing thread queries dedupe to the INBOX copy and hide label rows, so this is
// written fresh rather than reused. A thread "belongs to" a state when it has a
// (non-draft) row in that state's folder; the head is the thread's newest non-draft
// row across all its folders. array_agg exposes the full folder set and bool_or flags
// an INBOX sibling, so GTD display surfaces can show an archived-but-labelled commitment (in_inbox
// false) distinctly from one still in the box.
//
// Unread is THREAD-LEVEL: a thread is unread while ANY of its non-deleted, non-draft
// copies is unread, not just the head. The head prefers the (often older) GTD-label
// copy for id stability, so on folder-based servers a newer reply that exists only in
// INBOX would otherwise be invisible to every unread figure. folders_agg computes the
// aggregate once (thread_unread) and it is the single truth for the per-state unread
// counts, the waiting rollup, and the per-row flag mapHead surfaces.
//
// Params: $1 accountId, $2 state names[], $3 state folder paths[] (parallel to $2),
//         $4 draft folder paths[] (excluded), $5 per-section limit,
//         $6 waiting state names[] (the subset of $2 the client merges into Waiting).
const SECTION_SQL = `
  WITH gtd(state, folder) AS (
    SELECT * FROM unnest($2::text[], $3::text[])
  ),
  msg AS (
    SELECT m.id, m.account_id, m.thread_key, m.message_id, m.folder,
           m.subject, m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred, m.uid, m.gtd_gist
    FROM messages m
    WHERE m.account_id = $1
      AND m.is_deleted = false
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
           subject, from_name, from_email, date, snippet, is_starred, uid, id, gtd_gist
    FROM msg
    -- Prefer a row that lives in a GTD label folder: that copy's id is stable for as long
    -- as the thread is in a section, whereas a transient INBOX copy (archived/purged out
    -- from under the section feed) leaves the client deep-linking to a since-deleted id. Then newest.
    ORDER BY account_id, thread_key, (folder IN (SELECT folder FROM gtd)) DESC, date DESC, id DESC
  ),
  thread_state AS (
    SELECT DISTINCT msg.thread_key, gtd.state
    FROM msg
    JOIN gtd ON gtd.folder = msg.folder
  ),
  -- Deduped counts for the merged Waiting section. A thread carrying BOTH watch and
  -- delegated labels has two thread_state rows (one per state) but a single head, so the
  -- per-state totals below count it twice; COUNT(DISTINCT thread_key) collapses it to one.
  -- thread_key is the identity here because within this per-account query each thread_key
  -- resolves to exactly one head row — so its message_id/id is fixed and deduping by
  -- thread_key yields the same one-row-per-thread result the client's message_id||id
  -- dedupe (mergeWaiting) produces. Doing it server-side stays correct past the per-section
  -- head window the client sees, where the client can no longer spot the overlap.
  -- Scope note: this rollup, like every per-state total in this query, is PER-ACCOUNT (the
  -- msg CTE filters account_id = $1). A thread that spans accounts is summed independently
  -- per account and not deduped across them — an accepted limitation.
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
           h.subject, h.from_name, h.from_email, h.date, h.snippet, h.is_starred, h.uid, h.id, h.gtd_gist,
           fa.folders, fa.in_inbox, fa.thread_unread,
           COUNT(*)                                  OVER (PARTITION BY ts.state) AS total,
           COUNT(*) FILTER (WHERE fa.thread_unread)  OVER (PARTITION BY ts.state) AS unread,
           ROW_NUMBER() OVER (PARTITION BY ts.state ORDER BY h.date DESC, h.id DESC) AS rn
    FROM thread_state ts
    JOIN head h         ON h.thread_key = ts.thread_key
    JOIN folders_agg fa ON fa.thread_key = ts.thread_key
  )
  SELECT state, thread_key, account_id, message_id, folder,
         subject, from_name, from_email, date, snippet, is_starred, uid, id, gtd_gist,
         folders, in_inbox, thread_unread, total::int AS total, unread::int AS unread,
         waiting_total::int AS waiting_total, waiting_unread::int AS waiting_unread
  FROM ranked
  CROSS JOIN waiting_agg
  WHERE rn <= $5
  ORDER BY state, rn
`;

function emptySections() {
  const s = {};
  for (const st of GTD_STATES) s[st] = { total: 0, unread: 0, threads: [] };
  return s;
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
    // Thread-level: read only when EVERY non-draft copy of the thread is read (the
    // same bool_or aggregate the section unread counts use), never the head row's own
    // flag — a read label-folder head must not mask an unread INBOX-only reply.
    is_read: !row.thread_unread,
    is_starred: row.is_starred === true,
    uid: row.uid,
    folder: row.folder,
    folders: row.folders || [],
    in_inbox: row.in_inbox === true,
    // AI-condensed one-line gist for waiting rows, when cached on this head.
    // Null until lazily generated; the client falls back to the raw snippet.
    gist: row.gtd_gist || null,
  };
}

// Build the GTD display sections for a user. Unified across the user's gtd_enabled
// accounts when accountId is null, or scoped to a single owned account otherwise.
// Ownership + the gtd_enabled/enabled filter live in the accounts query, so a foreign
// or disabled accountId simply resolves to no targets and yields empty sections.
export async function getGtdSections({ userId, accountId = null, limit } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const accountsResult = await query(
    'SELECT id, folder_mappings FROM email_accounts WHERE user_id = $1 AND enabled = true AND gtd_enabled = true',
    [userId]
  );
  let targets = accountsResult.rows;
  if (accountId) targets = targets.filter(a => a.id === accountId);
  if (!targets.length) return { sections: { ...emptySections(), waiting: { total: 0, unread: 0 } } };

  const sections = emptySections();
  // Server-side deduped rollup for the merged Waiting section (watch ∪ delegated),
  // summed across accounts like the per-state totals. Lets the client stop inferring
  // the dedupe from the heads it happens to hold (which drifts past the head window).
  const waiting = { total: 0, unread: 0 };

  for (const acct of targets) {
    const { folders } = await getGtdConfig(acct.id);
    // Only states that map to a folder, in canonical order.
    const states = GTD_STATES.filter(s => folders[s]);
    const folderPaths = states.map(s => folders[s]);
    const waitingStates = states.filter(s => WAITING_STATES.includes(s));
    const draftPaths = [...(await resolveAllDraftsPaths(acct.id, acct.folder_mappings))];

    const { rows } = await query(SECTION_SQL, [acct.id, states, folderPaths, draftPaths, safeLimit, waitingStates]);

    // Fold this account's rows in. total/unread are constant within a state, so add
    // each state's figure exactly once (from its first row) rather than per head.
    const seenState = new Set();
    for (const row of rows) {
      const sec = sections[row.state];
      if (!sec) continue;
      if (!seenState.has(row.state)) {
        sec.total += row.total;
        sec.unread += row.unread;
        seenState.add(row.state);
      }
      sec.threads.push(mapHead(row));
    }
    // waiting_total/unread are constant across the account's rows — add once.
    if (rows.length) {
      waiting.total += Number(rows[0].waiting_total) || 0;
      waiting.unread += Number(rows[0].waiting_unread) || 0;
    }
  }

  // Finalise each section: newest-first across accounts, dedupe by message_id
  // (the same mail delivered to two accounts collapses to one head), cap to the limit.
  for (const st of GTD_STATES) {
    const sec = sections[st];
    sec.threads.sort((a, b) => new Date(b.date) - new Date(a.date));
    const seen = new Set();
    sec.threads = sec.threads
      .filter(h => {
        const key = h.message_id || h.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, safeLimit);
  }

  return { sections: { ...sections, waiting } };
}

// Broadcast gtd_sections_updated for an account IFF an ordinary mail mutation touched a
// thread present in GTD section data. The periodic sync tick only re-emits when the IMAP
// server's fingerprint moves, so a change Mailflow itself wrote to the DB (archive,
// delete, move, snooze, spam/ham, read, star) never trips it and the data can lag a full
// tick behind. A mutation is "relevant" when either of two things is true:
//   1. One of the acted messages still shares its RFC Message-ID with a live row in one
//      of the account's designated GTD label folders — i.e. the thread has (or is) a
//      classify sibling. `messageIds` are RFC Message-IDs (not row PKs) so this survives
//      the acted row being moved/deleted by the mutation.
//   2. One of the acted rows' PRE-mutation folders (`actedFolders`) was itself a
//      designated GTD folder. This covers a mutation that removes the last GTD-folder
//      copy of a thread: the post-mutation EXISTS below finds nothing (no sibling is
//      left), but the thread was present in GTD section data and clients still need a refresh.
//
// #2 is a pure in-memory check against the cached config, so it adds no query. #1 is a
// single indexed EXISTS, so a mutation on a non-GTD thread with no pre-mutation GTD folder
// emits nothing; a GTD-disabled account skips both checks entirely (getGtdConfig is
// cached). One broadcast per call regardless of how many messages qualified. imapManager
// is injected (like the transition engine) so this stays unit-testable without a live
// socket server.
export async function emitGtdIfRelevant(imapManager, accountId, userId, messageIds, actedFolders) {
  if (!accountId || !userId) return;
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  if (!ids.length) return;

  const { enabled, folders } = await getGtdConfig(accountId);
  if (!enabled) return;
  const folderPaths = [...new Set(Object.values(folders))];
  if (!folderPaths.length) return;

  const gtdFolderSet = new Set(folderPaths);
  const preMutationHit = (actedFolders || []).some(f => gtdFolderSet.has(f));

  const { rows } = await query(
    `SELECT 1 FROM messages
      WHERE account_id = $1
        AND message_id = ANY($2::text[])
        AND folder = ANY($3::text[])
        AND is_deleted = false
      LIMIT 1`,
    [accountId, ids, folderPaths]
  );
  if (preMutationHit || rows.length) imapManager.broadcast({ type: 'gtd_sections_updated', accountId }, userId);
}
