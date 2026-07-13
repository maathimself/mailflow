import { query } from './db.js';
import { getGtdConfig } from './gtdConfig.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';
import { logger } from './logger.js';

// Transition rules for auto-stripping a GTD label once a thread's state has moved on,
// evaluated per thread against its LAST non-draft message. Designed to match the
// behavior of an external labeling automation some accounts run concurrently, so a
// thread's state converges the same way regardless of which side strips it first:
//   'self'  → strip when that message is FROM the account owner   (Todo/Someday: I've
//             handled it, so it drops off my action list)
//   'other' → strip when that message is NOT from the owner       (Watch/Delegated: the
//             ball is back in my court once they reply, so the waiting state clears)
//   null    → never auto-strip                                    (Reference: manual only)
const STRIP_RULE = {
  todo: 'self',
  someday: 'self',
  watch: 'other',
  delegated: 'other',
  reference: null,
};

// ── Owner-address resolver ───────────────────────────────────────────────────
// The addresses that count as "me" for an account: its login address plus every
// configured alias. Aliases are unvalidated free text, so each is reduced to a bare
// lowercase addr-spec. Cached with the same short TTL as gtdConfig, so an alias added
// or removed via the account settings routes is picked up within CACHE_TTL_MS even
// though nothing currently calls invalidateOwnerAddressesCache proactively.
const ownerCache = new Map(); // accountId -> { value: Set<string>, expiry: number }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Exported for tests, which reuse one accountId across cases and need a clean cache
// between them; nothing else calls this today, so an alias change surfaces only once
// the TTL above lapses.
export function invalidateOwnerAddressesCache(accountId) {
  ownerCache.delete(accountId);
}

// Reduce free-form address text to a bare lowercase addr-spec. Handles a stored
// `Name <a@b>` display form and stray whitespace/casing; returns null for empties.
function normalizeAddress(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const angled = s.match(/<([^>]*)>/);
  if (angled) s = angled[1];
  s = s.trim().toLowerCase();
  return s || null;
}

export async function getOwnerAddresses(accountId) {
  const cached = ownerCache.get(accountId);
  if (cached && cached.expiry > Date.now()) return cached.value;

  const { rows } = await query(
    `SELECT email_address AS addr FROM email_accounts WHERE id = $1
     UNION ALL
     SELECT email AS addr FROM account_aliases WHERE account_id = $1`,
    [accountId]
  );
  const set = new Set();
  for (const r of rows) {
    const a = normalizeAddress(r.addr);
    if (a) set.add(a);
  }
  ownerCache.set(accountId, { value: set, expiry: Date.now() + CACHE_TTL_MS });
  return set;
}

// ── Thread-key resolvers for the two hook points ─────────────────────────────
// The INBOX post-ingest hook knows the surviving new rows' ids but not their thread_keys;
// the GTD tick knows which label folders changed but not which threads they touched.

export async function threadKeysForMessageIds(accountId, ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await query(
    `SELECT DISTINCT thread_key FROM messages
     WHERE account_id = $1 AND id = ANY($2::uuid[])`,
    [accountId, ids]
  );
  return rows.map((r) => r.thread_key);
}

export async function threadKeysInFolders(accountId, folders) {
  if (!folders || folders.length === 0) return [];
  const { rows } = await query(
    `SELECT DISTINCT thread_key FROM messages
     WHERE account_id = $1 AND folder = ANY($2::text[]) AND is_deleted = false`,
    [accountId, folders]
  );
  return rows.map((r) => r.thread_key);
}

// ── Transition engine ────────────────────────────────────────────────────────
// Apply the GTD Labeler rules to a set of threads for one account.
//
// Per thread, the verdict is decided against the newest NON-DRAFT message across all of
// the thread's folders: from the owner → strip Todo/Someday; from anyone else → strip
// Watch/Delegated; Reference is never touched. Stripping a state removes that thread's
// rows from the state's designated folder via imapManager.removeMessageCopy — mirroring
// how an external labeling automation drops a label from every message in a thread at once.
//
// Loop safety: a strip deletes label-folder rows but changes no message's date or sender,
// so re-running over the same threads yields the same verdict with nothing left to strip
// — the second pass is a no-op. Drafts are excluded from recency; GTD sibling rows are
// NOT excluded, because a sibling is a copy of the same message and shares the source's
// date and sender, so it can never change the verdict (its differing row id only breaks a
// same-date tie between identical senders).
//
// imapManager is injected (the hooks pass `this`) so the DB-touching logic stays unit-
// testable without standing up a live IMAP pool.
export async function runGtdTransitions(imapManager, account, threadKeys) {
  const keys = [...new Set(threadKeys || [])];
  if (keys.length === 0) return;

  const { enabled, folders } = await getGtdConfig(account.id);
  if (!enabled) return; // defence in depth — the hooks already gate on gtd_enabled

  // state -> designated folder, for the states that map somewhere. getGtdConfig always
  // merges DEFAULT_GTD_FOLDERS, so every state currently resolves to a truthy folder and
  // this map is never empty — the old "no designated folders present" early-return was dead
  // code and is removed. The per-state `folders[state]` guard is kept so a future settings
  // route that blanks a state's mapping simply drops that one state. A designated folder that
  // doesn't exist on the server is self-limiting anyway (no rows live in it, so nothing is
  // stripped), so no whole-run early-return is warranted; the tradeoff is that if every state
  // were ever blanked, this run would still issue its draft/owner/rows lookups before finding
  // nothing to strip — cheap, and still correct (it never strips anything wrongly).
  const stateFolder = {};
  for (const state of Object.keys(STRIP_RULE)) {
    if (folders[state]) stateFolder[state] = folders[state];
  }

  const draftPaths = await resolveAllDraftsPaths(account.id, account.folder_mappings);
  const owner = await getOwnerAddresses(account.id);

  const { rows } = await query(
    `SELECT thread_key, uid, folder, from_email, date, id
     FROM messages
     WHERE account_id = $1 AND thread_key = ANY($2::text[]) AND is_deleted = false`,
    [account.id, keys]
  );

  const byThread = new Map();
  for (const row of rows) {
    if (!byThread.has(row.thread_key)) byThread.set(row.thread_key, []);
    byThread.get(row.thread_key).push(row);
  }

  let anyStripped = false;

  for (const [, threadRows] of byThread) {
    const nonDraft = threadRows.filter((r) => !draftPaths.has(r.folder));
    if (nonDraft.length === 0) continue;

    // Newest non-draft message wins; ties break by id (matches the sections head order),
    // though a tie is always between sibling copies of one message so it cannot flip self.
    let newest = nonDraft[0];
    for (const r of nonDraft) {
      const diff = new Date(r.date) - new Date(newest.date);
      if (diff > 0 || (diff === 0 && String(r.id) > String(newest.id))) newest = r;
    }
    const isSelf = owner.has(normalizeAddress(newest.from_email));

    for (const [state, folder] of Object.entries(stateFolder)) {
      const rule = STRIP_RULE[state];
      const shouldStrip = rule === 'self' ? isSelf : rule === 'other' ? !isSelf : false;
      if (!shouldStrip) continue;

      for (const copy of threadRows.filter((r) => r.folder === folder)) {
        anyStripped = true;
        try {
          await imapManager.removeMessageCopy(account.id, copy.uid, copy.folder);
        } catch (err) {
          // An external automation may strip the same label concurrently, so the copy
          // can already be gone on the server. Treat a failed removal as a successful
          // strip and move on; the stale DB row reconciles on the next sync.
          logger.debug(`gtdTransitions: tolerated removeMessageCopy failure uid=${copy.uid} ${copy.folder}: ${err.message}`);
        }
      }
    }
  }

  // One batched emit per run (not per stripped copy) so the rail converges once.
  if (anyStripped) {
    imapManager.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
  }
}

// ── Sent-message hook ────────────────────────────────────────────────────────
// A reply the owner sends reaches neither the INBOX post-ingest hook (Sent isn't INBOX) nor
// the GTD tick (it watches only the five state folders), so replying to a Todo/Someday thread
// would otherwise never strip its label. The send route calls this once the reply's Sent copy
// has synced to the DB: resolve the sent message's thread by its RFC Message-ID, then run the
// engine over it. message_id is stored with or without angle brackets depending on the ingest
// path (see the dedup probe in imapManager), so both forms are matched. Gated on gtd_enabled
// so a non-GTD send issues zero queries. A lookup that finds nothing (the Sent copy hasn't
// synced yet) resolves to an empty key set, which runGtdTransitions treats as a no-op — a
// later post-send sync attempt (or, on Gmail, the next tick) retries. Errors propagate to the
// caller, which swallows them (a missed strip self-heals on the next inbound sync / tick).
export async function runTransitionsForSentMessage(imapManager, account, messageId) {
  if (!account?.gtd_enabled || !messageId) return;
  const bare = String(messageId).replace(/[<>]/g, '').trim();
  if (!bare) return;

  const { rows } = await query(
    `SELECT DISTINCT thread_key FROM messages
     WHERE account_id = $1 AND message_id = ANY($2::text[]) AND is_deleted = false`,
    [account.id, [bare, `<${bare}>`]]
  );
  await runGtdTransitions(imapManager, account, rows.map((r) => r.thread_key));
}
