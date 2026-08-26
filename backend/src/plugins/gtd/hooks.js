// GTD plugin — sync-engine hook handlers (v3.0 plugin platform).
//
// These are the handlers core's sync engine (imapManager) consults through the generic
// plugin registry, so the sync engine itself holds no GTD imports. Each handler is the GTD-
// specific half of a generic capability; core owns the mechanism (when/where it fires), the
// plugin owns the policy (which folders, which event, what to re-evaluate).
//
// Registered on the GTD manifest's `hooks` map (see ./index.js). Handlers must never throw
// into core — the registry swallows per-plugin errors — but they still guard internally so a
// transient DB blip degrades to "nothing contributed" rather than a noisy rejection.
import { getGtdFolderSet, getGtdConfig, gtdTickFolders, sanitizeGtdFoldersDetailed, findGtdFolderCollisions, DEFAULT_GTD_FOLDERS, invalidateGtdConfigCache } from './gtdConfig.js';
import { runGtdTransitions, threadKeysForMessageIds, threadKeysInFolders, runTransitionsForSentMessage, invalidateOwnerAddressesCache } from './gtdTransitions.js';
import { emitGtdIfRelevant } from './gtdSections.js';
import { deleteUserPet } from './gtdPet.js';
import { withGtdDelegationLock } from './gtdDelegationLock.js';
import {
  getAccountConfig,
  getThreadKeyForUid,
  getThreadKeysForMessageIdHeaders,
  getThreadKeysForMessageIds,
  listLabelCopyUids,
  listUserAccounts,
  logger,
  setAccountConfig,
} from '../api.js';
import {
  getAnnotatedThreadKeysMissingFolder,
  getThreadAnnotationRows,
  setThreadAnnotation,
} from '../gtdApi.js';

// Choose the INBOX message ids to run GTD transitions over after a sync batch completes.
//   newInboxIds — the id of every row the sync newly inserted into INBOX, collected REGARDLESS
//     of read state. An inbound reply that arrived already \Seen (read on another device before
//     this sync landed) must still clear its thread's Watch/Delegated label, yet such a row never
//     enters the unread-gated notification list — so that list cannot be reused as the candidate
//     set. Read state is deliberately not consulted here.
//   deletedIds — ids the block-list / inbox rules genuinely DELETED (expunged / dropped) from
//     INBOX; those threads lost this arrival entirely, so they are excluded. A rule-MOVED reply
//     is NOT in this set — its row still lives (in another folder) and its thread must still be
//     re-evaluated, so it stays a candidate.
// Pure, so the candidate selection is unit-testable without the full syncMessages fetch loop.
export function selectGtdReevalIds(newInboxIds, deletedIds) {
  const removed = deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []);
  return newInboxIds.filter((id) => !removed.has(id));
}

// collectHook('relocateExemptFolders'): a labeled GTD message intentionally lives as sibling
// rows across its state folders, so those folders must be exempt from the sync move-detector's
// relocate (which would collapse the siblings). Returns this account's designated GTD folder
// paths, or [] when GTD is disabled (getGtdFolderSet already returns an empty set then), so a
// non-GTD account contributes nothing and the relocate SQL stays byte-identical.
export async function relocateExemptFolders({ accountId }) {
  return [...await getGtdFolderSet(accountId)];
}

// runHook('sectionsChanged'): an ordinary mail mutation (delete/purge/backfill/flag flip) that
// core detected changed the messages table outside the GTD tick. Broadcast gtd_sections_updated
// so GTD clients refetch, but only when GTD is enabled for the account (getGtdConfig is cached,
// so a disabled account adds no query on the hot path, and — per the cache's TTL — an account
// whose GTD was just toggled converges within a tick). changedCount is already > 0 by the time
// core dispatches this, but we re-check defensively. Never throws into core; a config-fetch blip
// degrades to a skipped emit (the next tick still reconciles).
export async function sectionsChanged({ mgr, account, changedCount }) {
  if (!(changedCount > 0)) return;
  try {
    const { enabled } = await getGtdConfig(account.id);
    if (enabled) mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
  } catch (err) {
    logger.debug(`GTD sections refresh emit skipped for ${account.id}: ${err.message}`);
  }
}

// runHook('inboxIngest'): core hands over the ids this sync newly inserted into INBOX plus the
// ids its rules genuinely deleted. Re-evaluate the affected threads so a self-reply strips its
// thread's Watch/Delegated label, an inbound reply re-opens a snoozed thread, etc. Registered
// with a per-hook isActive gate (account.gtd_enabled) so core only collects candidates and
// dispatches this when GTD is on for the account — a non-GTD account issues zero extra queries.
// Never throws into core; a transition failure degrades to a logged skip (the tick reconciles).
export async function inboxIngest({ mgr, account, newInboxIds, deletedIds }) {
  const ids = selectGtdReevalIds(newInboxIds || [], deletedIds);
  if (!ids.length) return;
  try {
    const threadKeys = await threadKeysForMessageIds(account.id, ids);
    await runGtdTransitions(mgr, account, threadKeys);
  } catch (err) {
    logger.debug(`GTD inbox-ingest transitions failed for ${account.id}: ${err.message}`);
  }
}

// True when GTD's account-scoped participation (the inbox-ingest transition run and the periodic
// tick) should be active: GTD is enabled for this account. Kept as a named predicate so the
// manifest hooks and the sync descriptor share one definition. Async because the per-account
// enabled flag now lives in the plugin config store (getGtdConfig), not on the account row — core
// gates on it via registry.hasActiveAsync / an awaited sync.isActive.
export const gtdEnabledForAccount = async (ctx) => {
  const id = ctx?.account?.id;
  if (!id) return false;
  return (await getGtdConfig(id)).enabled;
};

// sync.tick: one GTD tick's body. Sync each designated label folder for a connected account, then
// broadcast a single gtd_sections_updated if any folder actually changed. Folders are synced one
// at a time (not in parallel) so a multi-folder account doesn't grab a handful of pooled
// connections at once, and core's on-demand sync lock is respected so a user-triggered folder open
// and this tick never double-sync the same folder. `mgr` is core's bounded engine facade (see
// mailEngineFacade): only the reviewed sync-capability primitives (isConnected, tryClaim/
// releaseFolderSync, folderFingerprint, syncFolderViaPool, broadcast) — no raw engine. The body is
// wrapped in one try/catch so a config-fetch DB blip is logged with account context instead of
// escaping as an unhandled rejection.
export async function gtdSyncTick({ mgr, account }) {
  try {
    // Live persistent connection is our signal the account is healthy; syncFolderViaPool runs on
    // a pooled connection, so it never disturbs the IDLE sync client.
    if (!mgr.isConnected(account.id)) return;
    const config = await getGtdConfig(account.id);
    const folders = gtdTickFolders(config); // [] when GTD was turned off — inert
    if (folders.length === 0) return;

    const changedFolders = [];
    for (const folder of folders) {
      if (!mgr.tryClaimFolderSync(account.id, folder)) continue; // a user-triggered sync owns this folder
      try {
        const before = await mgr.folderFingerprint(account.id, folder);
        await mgr.syncFolderViaPool(account, folder);
        const after = await mgr.folderFingerprint(account.id, folder);
        if (before !== after) changedFolders.push(folder);
      } catch (err) {
        console.warn(`GTD sync error ${account.id}/${folder}:`, err.message);
      } finally {
        mgr.releaseFolderSync(account.id, folder);
      }
    }

    const delegatedFolder = config.folders?.delegated;
    const clearedDelegations = delegatedFolder
      ? await clearOrphanedDelegations(account.id, delegatedFolder)
      : 0;

    if (changedFolders.length > 0) {
      // A label folder's membership changed (a state added/removed elsewhere — another client or
      // an external automation). Re-run transitions for the threads those folders now touch so a
      // newly-labeled thread whose newest message already satisfies a strip rule converges without
      // waiting for new INBOX mail. Idempotent: re-evaluating a thread the tick just stripped finds
      // nothing left. Runs before the emit so the sections refetch reflects the post-strip state.
      try {
        const threadKeys = await threadKeysInFolders(account.id, changedFolders);
        await runGtdTransitions(mgr, account, threadKeys);
      } catch (err) {
        console.warn(`GTD transitions error ${account.id}:`, err.message);
      }
    }
    if (changedFolders.length > 0 || clearedDelegations > 0) {
      mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
    }
  } catch (err) {
    console.warn(`GTD tick error ${account.id}:`, err.message);
  }
}

// On a non-UIDPLUS COPY the destination sibling row is deferred to syncFolderOnDemand, so the
// early gtd_sections_updated emit (afterLabelCopy below) can leave section data stale until that
// sync lands (up to a GTD tick away). Re-emit once the deferred sync resolves so the data
// converges immediately; on sync failure keep the warn and skip the re-emit (the next tick still
// reconciles). srcUid/fromFolder identify the copied message so the transition engine can be
// re-run over its thread now that the sibling exists: a transition run that raced ahead of the
// deferred insert saw stale thread state, so re-running here applies any needed strip immediately.
// Gated on gtd_enabled; transition failures are debug-level. Uses only generic mgr primitives
// (syncFolderOnDemand, broadcast) plus GTD's own DB read + transition engine.
export function emitAfterDeferredCopySync(
  mgr,
  account,
  toFolder,
  srcUid,
  fromFolder,
  { skipPostCopyTransitions = false } = {},
) {
  return mgr.syncFolderOnDemand(account, toFolder, { freshAfterActive: true })
    .then(async () => {
      mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
      if (skipPostCopyTransitions) return;
      if (!(await getGtdConfig(account.id)).enabled) return;
      try {
        const threadKey = await getThreadKeyForUid(account.id, srcUid, fromFolder);
        if (threadKey) await runGtdTransitions(mgr, account, [threadKey]);
      } catch (err) {
        logger.debug(`post-copy transition re-run failed for ${toFolder}: ${err.message}`);
      }
    })
    .catch(err => console.warn(`post-copy destination sync failed for ${toFolder}:`, err.message));
}

// runHook('afterLabelCopy'): core just COPY'd a message into a label folder. Broadcast the GTD
// section refresh (unconditional, mirroring the pre-plugin manager-level emit — it carries no row
// and is safe on both paths), then, on the deferred (non-UIDPLUS) path where the sibling row isn't
// inserted yet, wait for the deferred reconcile. The copy must not report success before callers
// that require read-after-write consistency can observe the destination row. Never throws into core.
export async function afterLabelCopy({
  mgr, account, toFolder, fromFolder, srcUid, newUid, skipPostCopyTransitions,
}) {
  mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
  if (newUid == null) {
    await emitAfterDeferredCopySync(mgr, account, toFolder, srcUid, fromFolder, {
      skipPostCopyTransitions,
    });
  }
}

// runHook('afterLabelRemove'): core just deleted one folder's copy of a message. Broadcast the
// GTD section refresh so clients refetch — same manager-level emit the pre-plugin code did.
async function reconcileDelegationRemoval(account, folder, threadKey) {
  if (!threadKey) return;
  const config = await getGtdConfig(account.id);
  const delegatedFolder = config.enabled ? config.folders?.delegated : null;
  if (!delegatedFolder || folder !== delegatedFolder) return;
  return withGtdDelegationLock(account.id, threadKey, async () => {
    const remaining = await listLabelCopyUids(account.id, threadKey, delegatedFolder);
    if (remaining.length === 0) {
      await setThreadAnnotation(account.id, threadKey, 'delegation', null);
      return true;
    }
    return false;
  });
}

export async function clearOrphanedDelegations(accountId, delegatedFolder) {
  const threadKeys = await getAnnotatedThreadKeysMissingFolder(
    accountId, delegatedFolder, 'delegation',
  );
  let cleared = 0;
  for (const threadKey of threadKeys) {
    const didClear = await withGtdDelegationLock(accountId, threadKey, async () => {
      if ((await listLabelCopyUids(accountId, threadKey, delegatedFolder)).length > 0) return false;
      await setThreadAnnotation(accountId, threadKey, 'delegation', null);
      return true;
    });
    if (didClear) cleared += 1;
  }
  return cleared;
}

export async function afterLabelRemove({ mgr, account, folder, threadKey }) {
  mgr.broadcast({ type: 'gtd_sections_updated', accountId: account.id }, account.user_id);
  await reconcileDelegationRemoval(account, folder, threadKey);
}

// Reconcile removes rows deleted by another IMAP client without passing through
// removeMessageCopy. Core reports the affected thread keys through this generic hook so the GTD
// snapshot cannot outlive the final Delegated copy.
export async function messageRowsDeleted({ account, folder, threadKeys }) {
  for (const threadKey of new Set(threadKeys || [])) {
    await reconcileDelegationRemoval(account, folder, threadKey);
  }
}

export async function messageRowsIngested({ account, messageIds }) {
  if (!messageIds?.length) return;
  const threadKeys = await getThreadKeysForMessageIds(account.id, messageIds);
  for (const threadKey of threadKeys) {
    // Inheritance may be emitted by the destination sync of a non-UIDPLUS delegation COPY.
    // Do not make that sync wait for the same thread lock held by the delegating request: the
    // request is itself waiting for the destination sync. Queue the durable annotation fan-out
    // behind the writer and let the folder sync finish first.
    void withGtdDelegationLock(account.id, threadKey, async () => {
      const rows = await getThreadAnnotationRows(account.id, [threadKey]);
      const authoritative = rows.find(row => (
        row.thread_key === threadKey && row.plugin_annotations?.gtd?.delegation
      ))?.plugin_annotations.gtd.delegation;
      if (authoritative) {
        await setThreadAnnotation(account.id, threadKey, 'delegation', authoritative);
      }
    }).catch(err => logger.debug(`delegation inheritance failed for ${threadKey}: ${err.message}`));
  }
}

async function clearMissingDelegations(accountId, messageIds) {
  if (!messageIds?.length) return;
  const config = await getGtdConfig(accountId);
  const folder = config.enabled ? config.folders?.delegated : null;
  if (!folder) return;
  const threadKeys = await getThreadKeysForMessageIdHeaders(accountId, messageIds);
  for (const threadKey of threadKeys) {
    await withGtdDelegationLock(accountId, threadKey, async () => {
      if ((await listLabelCopyUids(accountId, threadKey, folder)).length === 0) {
        await setThreadAnnotation(accountId, threadKey, 'delegation', null);
      }
    });
  }
}

// runHook('onMailMutation'): an ordinary mail mutation (archive/delete/move/read/star/snooze)
// acted on a batch of rows in the mail route. Broadcast the GTD section refresh when the mutation
// touched a labelled thread. Thin adapter over emitGtdIfRelevant, which self-gates on gtd_enabled
// and delegates the relevance check + scoped broadcast to core's notifyOnLabelTouch. The route
// fires this per affected account; the hook swallows per-plugin errors so a completed mutation is
// never turned into a 500.
export async function onMailMutation({ imapManager, accountId, userId, messageIds, actedFolders }) {
  await emitGtdIfRelevant(imapManager, accountId, userId, messageIds, actedFolders);
  try {
    await clearMissingDelegations(accountId, messageIds);
  } catch (err) {
    logger.debug(`GTD delegation reconciliation skipped for ${accountId}: ${err.message}`);
  }
}

// runHook('onSentMessage'): a sent message just synced into the Sent folder. Re-run GTD
// transitions for its thread — a reply to a Todo/Someday thread means the owner acted, so that
// label should drop. Self-gates on gtd_enabled inside runTransitionsForSentMessage; a Sent copy
// that hasn't synced yet resolves to an empty thread set (no-op) and a later attempt retries.
export async function onSentMessage({ imapManager, account, messageId }) {
  await runTransitionsForSentMessage(imapManager, account, messageId);
}

// runHook('onUserDelete'): a user was deleted. Remove their imported GTD pet from plugin storage
// (migrated pet rows carry a NULL owner_id, so the plugin_data cascade doesn't reach them).
// Best-effort: the user row is already gone, so a failure here must not surface as an error.
export async function onUserDelete({ userId }) {
  await deleteUserPet(userId).catch(err => console.warn('pet cleanup on delete:', err.message));
}

// collectHook('enrichAccount'): the accounts list/read endpoints let a plugin attach its own
// account-scoped fields onto the response so the client sees them as if they were columns. GTD's
// per-account config (gtd_enabled / gtd_folders) used to be email_accounts columns; now it lives in
// the plugin config store, so re-attach it here. gtd_enabled is the RAW per-account flag (the
// checkbox state), not the effective gate — activation is folded in only on the backend read path
// (getGtdConfig). Read-only; a failure contributes nothing and the account still returns.
export async function enrichAccount({ account }) {
  if (!account?.id) return undefined;
  const cfg = await getAccountConfig('gtd', account.id);
  return {
    gtd_enabled: cfg?.enabled === true,
    gtd_folders: (cfg?.folders && typeof cfg.folders === 'object') ? cfg.folders : {},
  };
}

// collectHook('validateAccountSettings'): the account-settings PATCH endpoint lets a plugin
// validate the fields it owns before anything is persisted. GTD owns `gtd_folders` (the state→
// folder override map) and `gtd_enabled`. Returns undefined (contributes nothing) unless a GTD
// field is being set. On a hard validation failure returns { error: { status, body } } so the route
// aborts with that response; otherwise returns { rejected } (per-field sub-values reset to defaults,
// surfaced to the client) and { requiresReconnect } (a folder remap / enable toggle needs a
// reconnect so connectAccount arms the tick / backfills the newly designated folder). The actual
// write is done in persistAccountSettings (below); this only validates. Async because the
// reconnect-diff reads the stored config.
export async function validateAccountSettings({ updates, accountId }) {
  const touchesGtd = updates && ('gtd_folders' in updates || 'gtd_enabled' in updates);
  if (!touchesGtd) return undefined;
  // Toggling gtd_enabled always needs a reconnect: the sync tick is only armed/torn down at
  // connectAccount, and the persistent-connection account object the transition hooks close over
  // must pick up the new flag.
  let requiresReconnect = 'gtd_enabled' in updates;
  const out = {};
  if ('gtd_folders' in updates) {
    const { folders, rejected, reserved } = sanitizeGtdFoldersDetailed(updates.gtd_folders);
    // A state mapped onto a live system folder (INBOX, Sent, …) is a hard error: /done would
    // permanently delete that folder's real mail.
    if (reserved.length) {
      return { error: { status: 400, body: { error: 'A GTD state cannot map to a reserved system folder', reserved } } };
    }
    const collisions = findGtdFolderCollisions({ ...DEFAULT_GTD_FOLDERS, ...folders });
    if (collisions.length) {
      return { error: { status: 400, body: { error: 'Two GTD states cannot map to the same folder', collisions } } };
    }
    // A folder remap needs a reconnect so connectAccount's backfill pulls the newly designated
    // folder's existing mail into the rail. Canonicalize both sides through the same sanitizer.
    const cfg = await getAccountConfig('gtd', accountId);
    const before = sanitizeGtdFoldersDetailed(cfg?.folders).folders;
    requiresReconnect = requiresReconnect || JSON.stringify(before) !== JSON.stringify(folders);
    out.rejected = { gtd_folders: rejected };
  }
  out.requiresReconnect = requiresReconnect;
  return out;
}

// collectHook('persistAccountSettings'): the account-settings PATCH lets a plugin persist the fields
// it owns into its OWN store rather than core writing columns. GTD writes gtd_enabled / gtd_folders
// into the plugin config store (plugin_account_config) and drops its cache. Returns { patch } — the
// saved values echoed back on the response so the client sees them — or undefined when nothing GTD
// owns changed. Runs after validateAccountSettings has already hard-rejected bad input; the folder
// re-sanitize here is defensive (idempotent) so the stored blob is always canonical.
export async function persistAccountSettings({ accountId, updates }) {
  const touchesGtd = updates && ('gtd_folders' in updates || 'gtd_enabled' in updates);
  if (!touchesGtd) return undefined;
  const cfg = await getAccountConfig('gtd', accountId);
  const next = {
    enabled: 'gtd_enabled' in updates ? !!updates.gtd_enabled : cfg?.enabled === true,
    folders: (cfg?.folders && typeof cfg.folders === 'object') ? cfg.folders : {},
  };
  if ('gtd_folders' in updates) {
    next.folders = sanitizeGtdFoldersDetailed(updates.gtd_folders).folders;
  }
  await setAccountConfig('gtd', accountId, next);
  invalidateGtdConfigCache(accountId);
  return { patch: { gtd_enabled: next.enabled, gtd_folders: next.folders } };
}

// runHook('onAccountIdentityChanged'): the account's aliases/identity changed — invalidate the
// owner-address cache the GTD delegation detector uses to tell "the owner replied" apart from an
// inbound reply.
export async function onAccountIdentityChanged({ accountId }) {
  invalidateOwnerAddressesCache(accountId);
}

// runHook('onPluginActivationChanged'): the user activated/deactivated a plugin. When it's GTD,
// drop the cached { enabled, folders } for ALL this user's accounts — getGtdConfig folds activation
// into its `enabled`, so the live tick, hooks, and classify/done routes must re-read to see the
// flip immediately. The per-account gtd_enabled/folders config in the DB is untouched, so
// reactivating restores everything.
export async function onPluginActivationChanged({ userId, pluginId }) {
  if (pluginId !== 'gtd' || !userId) return;
  const accounts = await listUserAccounts(userId);
  for (const a of accounts) invalidateGtdConfigCache(a.id);
}
