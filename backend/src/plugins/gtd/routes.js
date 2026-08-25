import { Router } from 'express';
import { requireAuth } from '../api.js';
import { getGtdSections } from './gtdSections.js';
import { queueGistGeneration } from './gtdGist.js';
import { importPet, decodeUploadedSheet, getPetMeta, getPetSheet, parsePetSlug, customPetSlug } from './gtdPet.js';
import { getGtdConfig, resolveGtdStateFolder, sanitizeGtdFolders, sanitizeGtdFoldersDetailed, DEFAULT_GTD_FOLDERS, planGtdFolderPersist, invalidateGtdConfigCache } from './gtdConfig.js';
import {
  applyLabel,
  removeExactLabelCopy,
  removeLabel,
  removeLabelRow,
  markThreadRowsRead,
  ensureLabelFolders,
  archiveInboxCopy,
  broadcast,
  loadOwnedMessage,
  getOwnedAccount,
  getAccountConfig,
  setAccountConfig,
  createOrLoadGtdDoneOperation,
  claimGtdDoneOperation,
  renewGtdDoneOperation,
  advanceGtdDoneOperation,
  releaseGtdDoneOperation,
} from '../api.js';
import { executeGtdDonePhases } from './gtdDonePhases.js';

const router = Router();
router.use(requireAuth);

// Message/account ids are always UUIDs; pre-validate before any DB lookup so a malformed
// id is a clean 400 rather than a parametrized query that just finds nothing (404) or a
// driver cast error. Same idiom + regex as mail.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shared classify precondition: an account must have GTD enabled and the request's
// state must resolve to a designated folder. Returns { folder } to proceed, or
// { status, error } to reject. Pure — exported for unit tests.
export function classifyTarget({ enabled, folders, state }) {
  if (!enabled) return { status: 400, error: 'GTD is not enabled for this account' };
  const folder = resolveGtdStateFolder(state, folders);
  if (!folder) return { status: 400, error: `Unknown GTD state: ${state}` };
  return { folder };
}

// The "done" action's precondition, resolving the GTD label folders a done request must
// strip. Two contracts, per the caller:
//   • Explicit `states` array (GTD sidebar entry): resolve each state to its designated folder, in
//     order, deduped — a merged Waiting row carries both watch and delegated. Unknown state
//     rejects. Mirrors classifyTarget but plural.
//   • `states === 'all'` (inbox checkmark): strip every designated GTD label the thread
//     actually carries. `existing` is the set of folder paths a live copy was found in; we
//     intersect it with the account's designated GTD folders (map order, deduped). Absent
//     labels are skipped, never an error; a thread with none resolves to { folders: [] } so
//     the route degrades to mark-read + archive.
// Returns { folders } to proceed, or { status, error } to reject. Pure — exported for tests.
export function resolveDoneFolders({ enabled, folders, states, existing }) {
  if (!enabled) return { status: 400, error: 'GTD is not enabled for this account' };
  if (states === 'all') {
    const present = new Set(Array.isArray(existing) ? existing : []);
    const resolved = [];
    for (const folder of Object.values(folders || {})) {
      if (present.has(folder) && !resolved.includes(folder)) resolved.push(folder);
    }
    return { folders: resolved };
  }
  if (!Array.isArray(states) || states.length === 0) {
    return { status: 400, error: 'states must be a non-empty array' };
  }
  const resolved = [];
  for (const state of states) {
    const folder = resolveGtdStateFolder(state, folders);
    if (!folder) return { status: 400, error: `Unknown GTD state: ${state}` };
    if (!resolved.includes(folder)) resolved.push(folder);
  }
  return { folders: resolved };
}

function summarizeDoneOperation(operation, outcome = {}) {
  const plan = operation.plan;
  const entries = operation.outcomes || [];
  const archiveUnconfirmedCount = Number(outcome.archiveUnconfirmedCount || 0);
  const labelUnconfirmedCount = Number(outcome.labelUnconfirmedCount || 0);
  const archiveEntries = entries.filter(entry => entry.phase === 'archive' && entry.rowId);
  const labelEntries = entries.filter(entry => entry.phase === 'labels' && entry.rowId);
  const archivedCount = archiveEntries.filter(entry => entry.archived === true).length;
  const archiveAlreadyGoneCount = archiveEntries.filter(entry => entry.alreadyGone === true).length;
  const removedEntries = labelEntries.filter(entry => entry.removed === true);
  const labelAlreadyGoneEntries = labelEntries.filter(entry => entry.alreadyGone === true);
  const removedIds = new Set([...removedEntries, ...labelAlreadyGoneEntries]
    .filter(entry => entry.removed === true || entry.alreadyGone === true)
    .map(entry => entry.rowId));
  const removed = [...new Set(plan.labelRows
    .filter(row => removedIds.has(row.id))
    .map(row => row.folder))];
  const inboxCleared = outcome.inboxCleared === true
    || plan.inboxRows.length === 0
    || archiveEntries.length === plan.inboxRows.length
    || outcome.phase === 'labels'
    || outcome.phase === 'completed';
  return {
    inboxCleared,
    archiveTargetCount: plan.inboxRows.length,
    archivedCount,
    archiveAlreadyGoneCount,
    archiveFailedCount: 0,
    archiveUnconfirmedCount,
    archivePendingCount: Math.max(
      0,
      plan.inboxRows.length - archiveEntries.length - archiveUnconfirmedCount,
    ),
    labelTargetCount: plan.labelRows.length,
    removed,
    removedCount: removedEntries.length,
    labelAlreadyGoneCount: labelAlreadyGoneEntries.length,
    labelUnconfirmedCount,
    labelPendingCount: Math.max(
      0,
      plan.labelRows.length - labelEntries.length - labelUnconfirmedCount,
    ),
    archived: inboxCleared && plan.inboxRows.length > 0,
  };
}

// GET /api/gtd/sections — thread heads + counts per GTD state for GTD display surfaces.
// accountId absent => unified across the user's gtd_enabled accounts; present => scoped
// to that owned account. Ownership + gtd_enabled filtering happen in the service.
// (Router is mounted at /api/gtd, so the paths here omit the gtd/ prefix.)
router.get('/sections', async (req, res) => {
  const { accountId, limit } = req.query;
  if (accountId && !UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  const result = await getGtdSections({
    userId: req.session.userId,
    accountId: accountId || null,
    limit,
  });
  res.json(result);

  // Fire-and-forget: lazily generate AI gists for waiting heads that lack one, when
  // a provider is configured. Never blocks the response; broadcasts gtd_sections_updated
  // per account when its batch completes so clients upgrade on the next refetch.
  queueGistGeneration({
    sections: result.sections,
    userId: req.session.userId,
    broadcast,
  }).catch(err => console.warn('GTD gist generation error:', err.message));
});

// ── GTD Inbox-Zero pet ────────────────────────────────────────────────────────

// POST /api/gtd/pet/import { petJson, sheet } — import a user's OWN pet by uploading the
// two files directly: pet.json as text, the spritesheet as a base64 / data-URL string.
// The image type is decided by magic bytes inside importPet, so the payload's declared
// mime is irrelevant. The storage slug is derived server-side from the session user (one
// custom slot per user), so the client cannot choose the storage key. Defense is the
// route body limit (index.js) + the size/magic-byte/parse checks inside importPet. The
// chosen slug is persisted separately as a user preference (gtdPetSlug via PATCH
// /auth/preferences); this route only acquires the assets.
router.post('/pet/import', async (req, res) => {
  const { petJson, sheet } = req.body || {};
  if (typeof petJson !== 'string' || typeof sheet !== 'string') {
    return res.status(400).json({ error: 'petJson and sheet are required' });
  }
  const bytes = decodeUploadedSheet(sheet);
  if (!bytes) return res.status(400).json({ error: 'Spritesheet could not be decoded' });
  try {
    const pet = await importPet({ petJsonText: petJson, sheet: bytes, userId: req.session.userId });
    res.json(pet);
  } catch (err) {
    if (err.code) return res.status(400).json({ error: err.message });
    console.error('GTD pet import failed:', err.message);
    res.status(500).json({ error: 'Failed to import pet' });
  }
});

// A public (non-custom) pet row is readable by everyone; a user-IMPORTED pet is private
// to its importer. Ownership is the row's is_custom provenance flag (migrations/0031) —
// written by importPet, never inferred from slug shape, so a public pet whose slug merely
// starts with custom- stays readable. The owner check recomputes the requester's own slug
// the same way importPet derives it. A non-owner gets the same 404 as an unknown slug
// (never 403) so the response can't confirm another user's pet exists.
function petRowReadable(row, rawSlug, userId) {
  if (!row) return false;
  return !row.isCustom || parsePetSlug(rawSlug) === customPetSlug(userId);
}

// GET /api/gtd/pet/:slug/meta — the cached animation descriptor for the frontend.
router.get('/pet/:slug/meta', async (req, res) => {
  const meta = await getPetMeta(req.params.slug);
  if (!petRowReadable(meta, req.params.slug, req.session.userId)) return res.status(404).json({ error: 'Pet not found' });
  res.json({ slug: meta.slug, displayName: meta.displayName, descriptor: meta.descriptor });
});

// GET /api/gtd/pet/:slug/sheet — the cached spritesheet bytes.
router.get('/pet/:slug/sheet', async (req, res) => {
  const sheet = await getPetSheet(req.params.slug);
  if (!petRowReadable(sheet, req.params.slug, req.session.userId)) return res.status(404).end();
  res.set('Content-Type', sheet.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(sheet.data);
});

// Load a message the caller owns, or send a 404. The email_accounts join is the
// ownership filter (a.user_id = $2); the message row itself carries everything the
// callers need (account_id, uid, folder, message_id), so no account column is selected.
// POST /api/gtd/classify { messageId, state } — apply a GTD label by COPYing the
// message into the state's designated folder (the message stays in its current
// folder; classify never removes it from the inbox). Thin: resolve the folder,
// ensure it exists (callers own folder existence), then delegate to
// imapManager.copyMessage, which also emits gtd_sections_updated.
router.post('/classify', async (req, res) => {
  const { messageId, state } = req.body || {};
  if (!messageId || !state) return res.status(400).json({ error: 'messageId and state are required' });
  if (!UUID_RE.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });
  const requestKey = req.get('X-Idempotency-Key')?.trim();
  if (!requestKey) return res.status(400).json({ error: 'X-Idempotency-Key required' });

  const msg = await loadOwnedMessage(req.session.userId, messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const { enabled, folders } = await getGtdConfig(msg.account_id);
  const target = classifyTarget({ enabled, folders, state });
  if (target.error) return res.status(target.status).json({ error: target.error });
  const toFolder = target.folder;

  const account = await getOwnedAccount(req.session.userId, msg.account_id);

  let result;
  try {
    result = await applyLabel(account, msg, toFolder, {
      operationKey: `gtd-classify:${req.session.userId}:${requestKey}`,
    });
  } catch (err) {
    console.error(`GTD classify failed for message ${messageId} -> ${toFolder}:`, err.message);
    return res.status(500).json({ error: 'Failed to apply GTD label' });
  }

  const undoToken = result.applied && result.uid != null && msg.message_id
    ? { messageId, state, folder: toFolder, uid: result.uid }
    : null;
  res.json({ ok: true, folder: toFolder, applied: result.applied, undoToken });
});

// POST /api/gtd/classify/undo — remove only the exact UID created by the classify request.
// The state is resolved again so a later folder remap invalidates the token instead of deleting
// from its stale path. removeExactLabelCopy additionally proves the UID still belongs to the
// source message by RFC Message-ID; replay and stale-token misses are safe no-ops.
router.post('/classify/undo', async (req, res) => {
  const { messageId, state, folder, uid } = req.body || {};
  if (!messageId || !state || typeof folder !== 'string' || !folder) {
    return res.status(400).json({ error: 'messageId, state, folder, and uid are required' });
  }
  if (!UUID_RE.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });
  if (!Number.isSafeInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Invalid copy uid' });

  const msg = await loadOwnedMessage(req.session.userId, messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const { enabled, folders } = await getGtdConfig(msg.account_id);
  const target = classifyTarget({ enabled, folders, state });
  if (target.error) return res.status(target.status).json({ error: target.error });
  if (target.folder !== folder) {
    return res.status(409).json({ error: 'GTD state folder changed — undo token is stale' });
  }

  try {
    const { removed } = await removeExactLabelCopy(msg, folder, uid);
    return res.json({ ok: true, removed, folder });
  } catch (err) {
    console.error(`GTD classify undo failed for message ${messageId} in ${folder}:`, err.message);
    return res.status(500).json({ error: 'Failed to undo GTD classification' });
  }
});

// DELETE /api/gtd/classify { messageId, state } — remove a GTD label by deleting
// the message's copy that lives in the state folder, leaving all other copies
// (INBOX, other labels) intact. The acted message id identifies the thread member
// by its RFC Message-ID; the copy in the state folder is resolved from that.
router.delete('/classify', async (req, res) => {
  const { messageId, state } = req.body || {};
  if (!messageId || !state) return res.status(400).json({ error: 'messageId and state are required' });
  if (!UUID_RE.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });

  const msg = await loadOwnedMessage(req.session.userId, messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const { enabled, folders } = await getGtdConfig(msg.account_id);
  const target = classifyTarget({ enabled, folders, state });
  if (target.error) return res.status(target.status).json({ error: target.error });
  const stateFolder = target.folder;

  // Find the copy that lives in the state folder via resolveCopyUid: the acted row when it
  // already lives there, else the shared RFC Message-ID (COPY duplicates it verbatim) joins to
  // the sibling. A missing Message-ID only blocks that sibling lookup — the acted-row case
  // needs no Message-ID — so guard it there and keep the explicit 400 the client relies on.
  if (msg.folder !== stateFolder && !msg.message_id) {
    return res.status(400).json({ error: 'Message has no Message-ID — cannot resolve GTD copy' });
  }
  try {
    const { removed } = await removeLabel(msg, stateFolder);
    if (!removed) return res.json({ ok: true, removed: false });
  } catch (err) {
    console.error(`GTD unclassify failed for message ${messageId} in ${stateFolder}:`, err.message);
    return res.status(500).json({ error: 'Failed to remove GTD label' });
  }

  res.json({ ok: true, removed: true, folder: stateFolder });
});

// POST /api/gtd/done { id, states? } — the GTD "done" action. Two callers: the GTD sidebar passes
// Thread-wide Done. GTD section rows are heads for (account, thread_key), so the displayed row's
// Message-ID is not a safe mutation identity: another reply may own the requested label or still
// live in INBOX. Authorize through the acted UUID, freeze all live rows for its account+thread,
// then mutate only that immutable worklist. Late arrivals are deliberately left for the next
// action/sync. Core capabilities own SQL/IMAP; this plugin only orchestrates them.
router.post('/done', async (req, res) => {
  const { id, states } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const lifecycleKey = req.get('X-Idempotency-Key')?.trim();
  if (!lifecycleKey) return res.status(400).json({ error: 'X-Idempotency-Key required' });
  // Inbox Done has no section context, so the backend derives every actual GTD label from the
  // frozen row set. Sidebar callers send their explicit section intent.
  const intent = states == null ? 'all' : states;
  let operation;
  let account;
  try {
    operation = await createOrLoadGtdDoneOperation({
      userId: req.session.userId,
      actedMessageId: id,
      intent,
      lifecycleKey,
      deriveTargetFolders: ({ enabled, folders, states: frozenStates, existing }) => {
        const resolvedFolders = { ...DEFAULT_GTD_FOLDERS, ...(folders || {}) };
        return resolveDoneFolders({
          enabled,
          folders: resolvedFolders,
          states: frozenStates,
          existing,
        });
      },
    });
    account = await getOwnedAccount(req.session.userId, operation.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const outcome = await executeGtdDonePhases(operation, {
      claim: claimGtdDoneOperation,
      renew: renewGtdDoneOperation,
      release: releaseGtdDoneOperation,
      advance: advanceGtdDoneOperation,
      markSeen: rows => markThreadRowsRead(account, rows),
      archive: row => archiveInboxCopy(account, row, {
        archiveFolder: operation.plan.archiveFolder,
        archiveAllMail: operation.plan.archiveAllMail,
        archiveObservation: operation.plan.archiveObservation,
      }),
      removeLabel: row => removeLabelRow(row, { notify: false }),
    });
    const completedOperation = outcome.operation || operation;
    const summary = summarizeDoneOperation(completedOperation, outcome);
    try {
      broadcast({ type: 'gtd_sections_updated', accountId: operation.accountId }, account.user_id);
    } catch (error) {
      console.warn(`GTD done terminal broadcast failed for ${operation.key}:`, error.message);
    }
    const response = {
      ok: outcome.complete,
      phase: outcome.phase,
      retryable: !outcome.complete,
      uncertain: !outcome.complete,
      ...summary,
      seenFailedCount: outcome.seenFailedCount || 0,
      noArchiveFolder: outcome.noArchiveFolder === true,
      archiveFailed: !outcome.complete && outcome.phase === 'archive',
      archiveSkippedNoFolderCount: outcome.noArchiveFolder === true ? 1 : 0,
    };
    return res.status(outcome.phase === 'seen' ? 503 : 200).json(response);
  } catch (err) {
    console.error(`GTD done for ${id} failed:`, err.message);
    const failedOperation = err.gtdDoneOperation || operation;
    const phase = err.gtdDonePhase || failedOperation?.phase || 'snapshot';
    const summary = failedOperation?.plan
      ? summarizeDoneOperation(failedOperation, {
          phase,
          inboxCleared: err.inboxCleared === true,
        })
      : { inboxCleared: err.inboxCleared === true };
    if (operation && account) {
      try {
        broadcast({ type: 'gtd_sections_updated', accountId: operation.accountId }, account.user_id);
      } catch (broadcastError) {
        console.warn(`GTD done terminal broadcast failed for ${operation.key}:`, broadcastError.message);
      }
    }
    return res.status(err.status || 500).json({
      error: err.message || 'Failed to mark done',
      code: err.code,
      phase,
      ...summary,
      retryable: err.retryable !== false,
      uncertain: true,
    });
  }
});

// POST /api/gtd/folders/ensure { accountId, folders } — create any of the account's
// designated GTD label folders that are missing on the IMAP server, reporting per
// folder whether it was created now or already existed. `folders` is the (possibly
// unsaved) overrides map from the settings form; it is merged over the defaults and
// sanitized before use. Thin over imapManager.ensureFolder.
// Intentionally NOT gated on gtd_enabled: pre-creating the label folders before
// flipping GTD on is a legitimate setup step (unlike classify, which requires it on).
router.post('/folders/ensure', async (req, res) => {
  const { accountId, folders } = req.body || {};
  if (!accountId) return res.status(400).json({ error: 'accountId is required' });
  if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });

  const account = await getOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Reject a form mapping onto a reserved system folder before creating anything — the same
  // /done permanent-delete hazard the account settings save path guards against.
  const { folders: formFolders, reserved } = sanitizeGtdFoldersDetailed(folders);
  if (reserved.length) return res.status(400).json({ error: 'A GTD state cannot map to a reserved system folder', reserved });
  const merged = { ...DEFAULT_GTD_FOLDERS, ...formFolders };
  const paths = [...new Set(Object.values(merged))];

  // Delegate the IMAP folder-ensuring to the generic labels capability; it resolves each to its
  // REAL server path (e.g. 'INBOX.Todo' on a prefixed server) and reports whether it created it.
  // GTD keeps ownership of the config reconciliation below, which is keyed off these results.
  const results = await ensureLabelFolders(account, paths);

  // Reconcile stored config with where the folders actually landed. On a prefixed namespace
  // the configured bare name resolves to a different real path (INBOX.Todo), so persist that
  // effective path onto exactly the affected state keys — otherwise the GTD pipeline keeps
  // keying on 'Todo' while the folder list (and the copies classify/done make) live at
  // 'INBOX.Todo'. Flat servers (Gmail, modern Fastmail) land every folder where configured,
  // so this is a no-op there: no write, no cache invalidation, response shape unchanged.
  //
  // Persist planning keys off the SAVED config, not `merged` (the request body's possibly
  // unsaved form overrides) — `folders` were still created against `merged` above (a form
  // edit the user hasn't hit Save on should still get its folder created), but a relocation
  // may only be persisted for a state whose *stored* configured name is what actually got
  // ensured this call. Otherwise clicking "Create missing folders" with an unsaved edit would
  // silently write that edit's effective path to the DB, bypassing Save.
  const gtdCfg = await getAccountConfig('gtd', accountId);
  const storedFolders = gtdCfg?.folders && typeof gtdCfg.folders === 'object' ? gtdCfg.folders : {};
  const storedMerged = { ...DEFAULT_GTD_FOLDERS, ...sanitizeGtdFolders(storedFolders) };
  const plan = planGtdFolderPersist({ merged: storedMerged, stored: storedFolders, results });
  if (plan.collisions) {
    return res.status(400).json({ error: 'Two GTD states cannot map to the same folder', collisions: plan.collisions });
  }
  if (plan.changed) {
    await setAccountConfig('gtd', accountId, { ...gtdCfg, folders: plan.folders });
    invalidateGtdConfigCache(accountId);
  }

  res.json(plan.changed ? { results, folders: plan.folders } : { results });
});

export default router;
