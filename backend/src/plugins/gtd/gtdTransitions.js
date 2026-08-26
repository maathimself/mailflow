import { getGtdConfig } from './gtdConfig.js';
import { resolveAllDraftsPaths, logger, getAccountAddresses, getThreadKeysForMessageIds as _threadKeysForIds, getThreadKeysInFolders as _threadKeysInFolders, getThreadKeysForMessageIdHeaders, getMessagesByThreadKeys } from '../api.js';
import { getThreadAnnotationRows } from '../gtdApi.js';
import { withGtdDelegationLock } from './gtdDelegationLock.js';

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
// lowercase addr-spec. Account-alias routes invalidate the short-lived cache after every
// successful create/update/delete so a newly configured Fastmail masked sender is recognized
// before the next GTD transition tick evaluates a just-ingested message; a stale owner set
// would misclassify that self-sent message and strip its Watch copy for up to the full TTL.
const ownerCache = new Map(); // accountId -> { value: Set<string>, expiry: number }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Exported for tests, which reuse one accountId across cases and need a clean cache, and for
// the account-alias routes, which call it only after a mutation succeeds. The next resolver
// read must observe the committed owner identities before a GTD transition can classify mail.
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

  const addrs = await getAccountAddresses(accountId);
  const set = new Set();
  for (const raw of addrs) {
    const a = normalizeAddress(raw);
    if (a) set.add(a);
  }
  ownerCache.set(accountId, { value: set, expiry: Date.now() + CACHE_TTL_MS });
  return set;
}

// ── Thread-key resolvers for the two hook points ─────────────────────────────
// The INBOX post-ingest hook knows the surviving new rows' ids but not their thread_keys;
// the GTD tick knows which label folders changed but not which threads they touched.

// Thin GTD-facing wrappers over the mail-access capabilities (kept as exports so the hooks and
// tests that import them from here are unchanged).
export const threadKeysForMessageIds = (accountId, ids) => _threadKeysForIds(accountId, ids);
export const threadKeysInFolders = (accountId, folders) => _threadKeysInFolders(accountId, folders);

async function withThreadTransitionLocks(accountId, keys, work, index = 0) {
  if (index >= keys.length) return work();
  return withGtdDelegationLock(
    accountId,
    keys[index],
    () => withThreadTransitionLocks(accountId, keys, work, index + 1),
  );
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

  // Acquire every affected thread in stable order before taking the message/annotation snapshot.
  // An explicit delegation uses the same lock. Whichever operation entered first therefore
  // finishes first, and a tick can never inspect a half-written label + delegation marker.
  await withThreadTransitionLocks(account.id, [...keys].sort(), async () => {
    const [rows, annotationRows] = await Promise.all([
      getMessagesByThreadKeys(account.id, keys),
      getThreadAnnotationRows(account.id, keys),
    ]);

    const delegatedAtByThread = new Map();
    for (const row of annotationRows) {
      const raw = row.plugin_annotations?.gtd?.delegation?.delegatedAt;
      const timestamp = Date.parse(raw);
      if (!Number.isFinite(timestamp)) continue;
      const previous = delegatedAtByThread.get(row.thread_key);
      if (previous == null || timestamp > previous) {
        delegatedAtByThread.set(row.thread_key, timestamp);
      }
    }

    const byThread = new Map();
    for (const row of rows) {
      if (!byThread.has(row.thread_key)) byThread.set(row.thread_key, []);
      byThread.get(row.thread_key).push(row);
    }

    let anyStripped = false;

    for (const [threadKey, threadRows] of byThread) {
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
      let shouldStrip = rule === 'self' ? isSelf : rule === 'other' ? !isSelf : false;
      if (state === 'delegated' && shouldStrip) {
        const delegatedAt = delegatedAtByThread.get(threadKey);
        if (delegatedAt != null) {
          // Explicit delegation starts a new waiting period. The external message that was
          // already newest at that moment must not immediately cancel it; only a later-dated
          // external reply can do so. With an invalid/missing message date, retain the explicit
          // state because there is no evidence that the message arrived after delegation.
          const newestAt = Date.parse(newest.date);
          shouldStrip = Number.isFinite(newestAt) && newestAt > delegatedAt;
        }
      }
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
  });
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
  if (!account?.id || !messageId) return;
  if (!(await getGtdConfig(account.id)).enabled) return;
  const bare = String(messageId).replace(/[<>]/g, '').trim();
  if (!bare) return;

  const threadKeys = await getThreadKeysForMessageIdHeaders(account.id, [bare, `<${bare}>`]);
  await runGtdTransitions(imapManager, account, threadKeys);
}
