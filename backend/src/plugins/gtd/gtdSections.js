import { getGtdConfig, GTD_STATES } from './gtdConfig.js';
import { resolveAllDraftsPaths, listThreadHeadsByLabels, notifyOnLabelTouch, listUserAccounts } from '../api.js';
import { getMessageAnnotations } from '../gtdApi.js';

// States the frontend merges into the single "Waiting" section (utils/gtd.js). Their
// counts must dedupe a thread holding BOTH labels; see the waiting_agg CTE below.
export const WAITING_STATES = ['watch', 'delegated'];

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

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
    // AI-condensed one-line gist for waiting rows, when cached (in the message's plugin
    // annotations, merged onto the row below). Null until lazily generated; client falls back
    // to the raw snippet.
    gist: row.gist ?? null,
  };
}

// Build the GTD display sections for a user. Unified across the user's gtd_enabled
// accounts when accountId is null, or scoped to a single owned account otherwise.
// Ownership + the gtd_enabled/enabled filter live in the accounts query, so a foreign
// or disabled accountId simply resolves to no targets and yields empty sections.
export async function getGtdSections({ userId, accountId = null, limit } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // The user's enabled accounts; the per-account GTD gate (gtd active for the account) is applied
  // per account below via getGtdConfig, so accounts where GTD is off simply contribute nothing.
  let targets = (await listUserAccounts(userId)).filter(a => a.enabled);
  if (accountId) targets = targets.filter(a => a.id === accountId);
  else targets = targets.filter(a => a.include_in_unified_inbox !== false);
  if (!targets.length) return { sections: { ...emptySections(), waiting: { total: 0, unread: 0 } } };

  const sections = emptySections();
  // Server-side deduped rollup for the merged Waiting section (watch ∪ delegated),
  // summed across accounts like the per-state totals. Lets the client stop inferring
  // the dedupe from the heads it happens to hold (which drifts past the head window).
  const waiting = { total: 0, unread: 0 };

  for (const acct of targets) {
    const { enabled, folders } = await getGtdConfig(acct.id);
    if (!enabled) continue; // GTD not active for this account (config off or plugin deactivated)
    // Only states that map to a folder, in canonical order.
    const states = GTD_STATES.filter(s => folders[s]);
    const folderPaths = states.map(s => folders[s]);
    const waitingStates = states.filter(s => WAITING_STATES.includes(s));
    const draftPaths = [...(await resolveAllDraftsPaths(acct.id, acct.folder_mappings))];

    const rows = await listThreadHeadsByLabels(acct.id, { labels: states, labelFolders: folderPaths, draftFolders: draftPaths, limit: safeLimit, unionLabels: waitingStates });

    // The labels-read capability is generic (no GTD columns); merge GTD's own per-message gist
    // (stored in the message's plugin annotations) onto each head so mapHead can surface it.
    const gists = await getMessageAnnotations(acct.id, rows.map(r => r.id));
    for (const row of rows) row.gist = gists[row.id]?.gist ?? null;

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
  if (!ids.length) return; // short-circuit before touching config (no getGtdConfig on an empty batch)

  const { enabled, folders } = await getGtdConfig(accountId);
  if (!enabled) return;

  // Delegate relevance + the scoped broadcast to the generic labels-touch notify capability;
  // GTD only supplies its designated label folders and its refresh event name.
  await notifyOnLabelTouch(imapManager, {
    accountId,
    userId,
    messageIds: ids,
    actedFolders,
    labelFolders: [...new Set(Object.values(folders))],
    event: 'gtd_sections_updated',
  });
}
