import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getGtdSections } from '../services/gtdSections.js';
import { queueGistGeneration } from '../services/gtdGist.js';
import { importPet, decodeUploadedSheet, getPetMeta, getPetSheet, parsePetSlug, customPetSlug } from '../services/gtdPet.js';
import { getGtdConfig, resolveGtdStateFolder, sanitizeGtdFolders, sanitizeGtdFoldersDetailed, DEFAULT_GTD_FOLDERS, planGtdFolderPersist, invalidateGtdConfigCache } from '../services/gtdConfig.js';
import { fanOutReadToSiblings } from '../utils/mailUtils.js';
import { archiveInboxCopy } from '../services/archiveInbox.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

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
    broadcast: (payload, uid) => imapManager.broadcast(payload, uid),
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
async function loadOwnedMessage(userId, messageId) {
  const result = await query(
    `SELECT m.*
     FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId]
  );
  return result.rows[0] || null;
}

// POST /api/gtd/classify { messageId, state } — apply a GTD label by COPYing the
// message into the state's designated folder (the message stays in its current
// folder; classify never removes it from the inbox). Thin: resolve the folder,
// ensure it exists (callers own folder existence), then delegate to
// imapManager.copyMessage, which also emits gtd_sections_updated.
router.post('/classify', async (req, res) => {
  const { messageId, state } = req.body || {};
  if (!messageId || !state) return res.status(400).json({ error: 'messageId and state are required' });
  if (!UUID_RE.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });

  const msg = await loadOwnedMessage(req.session.userId, messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const { enabled, folders } = await getGtdConfig(msg.account_id);
  const target = classifyTarget({ enabled, folders, state });
  if (target.error) return res.status(target.status).json({ error: target.error });
  const toFolder = target.folder;

  // Already labelled with this state — nothing to copy.
  if (msg.folder === toFolder) return res.json({ ok: true, folder: toFolder });

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  try {
    await imapManager.ensureFolder(account, toFolder);
    await imapManager.copyMessage(msg.account_id, msg.uid, msg.folder, toFolder);
  } catch (err) {
    console.error(`GTD classify failed for message ${messageId} -> ${toFolder}:`, err.message);
    return res.status(500).json({ error: 'Failed to apply GTD label' });
  }

  res.json({ ok: true, folder: toFolder });
});

// Resolve the folder-copy uid a message has in `folder` for this account, or null. The
// acted row is used directly when it already lives there; otherwise the shared RFC
// Message-ID (COPY duplicates it verbatim) joins to the sibling copy. Shared by DELETE
// /classify (below) and POST /done's label strip.
async function resolveCopyUid(msg, folder) {
  if (msg.folder === folder) return msg.uid;
  const sib = await query(
    'SELECT uid FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false LIMIT 1',
    [msg.account_id, folder, msg.message_id]
  );
  return sib.rows[0]?.uid ?? null;
}

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
  const siblingUid = await resolveCopyUid(msg, stateFolder);
  if (siblingUid == null) return res.json({ ok: true, removed: false });

  try {
    await imapManager.removeMessageCopy(msg.account_id, siblingUid, stateFolder);
  } catch (err) {
    console.error(`GTD unclassify failed for message ${messageId} in ${stateFolder}:`, err.message);
    return res.status(500).json({ error: 'Failed to remove GTD label' });
  }

  res.json({ ok: true, removed: true, folder: stateFolder });
});

// POST /api/gtd/done { id, states? } — the GTD "done" action. Two callers: the GTD sidebar passes
// an explicit `states` array (strip that section's labels); the inbox checkmark omits states
// (or sends 'all') for "done from anywhere" — strip every GTD label the thread carries. The
// id is its GTD-label-folder copy for the sidebar, or the INBOX copy from the inbox; either way
// the archive step resolves the INBOX copy from the shared Message-ID rather than acting on
// `id` directly. In one round trip this: (a) marks the whole thread read (DB fan-out across
// sibling copies, \Seen on the INBOX copy so it rides the archive move); (b) strips the
// row's own GTD label copies named in `states` — a merged Waiting row passes both
// watch+delegated — leaving any GTD labels in OTHER sections intact; (c) archives the INBOX
// copy if one exists (reusing resolveArchiveFolder + moveMessage, snooze's in-place UPDATE).
// One terminal gtd_sections_updated broadcast makes the row disappear cleanly on refetch.
router.post('/done', async (req, res) => {
  const { id, states } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const msg = await loadOwnedMessage(req.session.userId, id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!msg.message_id) return res.status(400).json({ error: 'Message has no Message-ID — cannot mark done' });

  const { enabled, folders } = await getGtdConfig(msg.account_id);

  // All-states mode (inbox checkmark) resolves against the label copies that actually exist
  // for this thread; the GTD sidebar's explicit-states path is untouched. Only look copies up when
  // we'll use them (enabled + all-states); resolveDoneFolders still owns the gtd_enabled gate.
  const allStates = states == null || states === 'all';
  let existing;
  if (allStates && enabled) {
    const copies = await query(
      'SELECT DISTINCT folder FROM messages WHERE account_id = $1 AND message_id = $2 AND is_deleted = false',
      [msg.account_id, msg.message_id]
    );
    existing = copies.rows.map(r => r.folder);
  }
  const target = allStates
    ? resolveDoneFolders({ enabled, folders, states: 'all', existing })
    : resolveDoneFolders({ enabled, folders, states });
  if (target.error) return res.status(target.status).json({ error: target.error });

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  // (a) Mark the whole thread read. The DB fan-out (by Message-ID) covers every sibling
  // copy and adjusts each folder's unread count; \Seen is set on the durable INBOX copy
  // only (it rides the archive move; Gmail propagates message-wide) — the same per-copy
  // asymmetry the ordinary read route accepts. A best-effort flag push is never fatal.
  const inbox = await query(
    'SELECT id, uid, is_read FROM messages WHERE account_id = $1 AND folder = $2 AND message_id = $3 AND is_deleted = false LIMIT 1',
    [msg.account_id, 'INBOX', msg.message_id]
  );
  const inboxCopy = inbox.rows[0] || null;
  try {
    await fanOutReadToSiblings(msg.account_id, msg.message_id, true);
    if (inboxCopy && !inboxCopy.is_read) {
      await imapManager.setFlag(account, inboxCopy.uid, 'INBOX', '\\Seen', true);
    }
  } catch (err) {
    console.warn(`GTD done: mark-read for ${id} degraded:`, err.message);
  }

  // (b) Strip this row's GTD label copies. Each is a distinct folder copy resolved from
  // the shared Message-ID; removeMessageCopy deletes the IMAP + DB copy and adjusts that
  // label folder's counts, leaving INBOX and other-section labels untouched.
  //
  // Strip the acted row's OWN folder (msg.folder) LAST. A merged Waiting done passes both
  // watch+delegated, and if an earlier copy's removal throws we 500 — but the same-id retry
  // must still resolve the acted message via loadOwnedMessage. Deleting the acted row first
  // would 404 that retry and orphan the copies not yet stripped, so keep it alive until every
  // other copy is gone. (msg.folder is absent from target.folders in the inbox 'all' case —
  // the acted INBOX row is never stripped anyway — so the ordering is a no-op there.)
  const stripOrder = [
    ...target.folders.filter(f => f !== msg.folder),
    ...target.folders.filter(f => f === msg.folder),
  ];
  const removed = [];
  try {
    for (const folder of stripOrder) {
      const uid = await resolveCopyUid(msg, folder);
      if (uid == null) continue; // already gone
      await imapManager.removeMessageCopy(msg.account_id, uid, folder);
      removed.push(folder);
    }
  } catch (err) {
    console.error(`GTD done: label strip for ${id} failed:`, err.message);
    return res.status(500).json({ error: 'Failed to mark done' });
  }

  // (c) Archive the INBOX copy if one is present, via the shared per-copy archive primitive
  // (resolveArchiveFolder + guarded moveMessage + race-safe DB repoint + count adjust, with
  // the Gmail All-Mail DELETE branch). No archive folder configured is a soft outcome, not a
  // failure — the GTD labels are already gone, so the thread has left all GTD sections regardless.
  let archived = false;
  let noArchiveFolder = false;
  let archiveFailed = false;
  if (inboxCopy) {
    try {
      const result = await archiveInboxCopy(imapManager, account, inboxCopy);
      archived = result.archived;
      noArchiveFolder = result.noArchiveFolder;
    } catch (err) {
      // Step (b) already stripped the labels (or had nothing to strip). A failed archive must
      // not 500: that misreports a mostly-successful action, and — with the label row now
      // gone — a retry by the same id would 404. Report a partial success (200, archiveFailed
      // true, archived false) so the client can surface it and the id stays retryable.
      console.error(`GTD done: archive of INBOX copy for ${id} failed:`, err.message);
      archiveFailed = true;
    }
  }

  // One terminal refresh so GTD section data converges to the post-done state (removeMessageCopy
  // also emits mid-op, but this covers the archive that follows it).
  imapManager.broadcast({ type: 'gtd_sections_updated', accountId: msg.account_id }, account.user_id);

  res.json({ ok: true, removed, archived, noArchiveFolder, archiveFailed });
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

  const accountResult = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  const account = accountResult.rows[0];
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Reject a form mapping onto a reserved system folder before creating anything — the same
  // /done permanent-delete hazard the account settings save path guards against.
  const { folders: formFolders, reserved } = sanitizeGtdFoldersDetailed(folders);
  if (reserved.length) return res.status(400).json({ error: 'A GTD state cannot map to a reserved system folder', reserved });
  const merged = { ...DEFAULT_GTD_FOLDERS, ...formFolders };
  const paths = [...new Set(Object.values(merged))];

  const results = [];
  for (const folder of paths) {
    try {
      // ensureFolder returns the REAL server path (e.g. 'INBOX.Todo' on a prefixed IMAP
      // server) alongside whether this call created it; report `path` so the settings UI
      // shows where the label folder actually landed, not just the bare requested name.
      // resolvePath makes an already-existing folder resolve its true server casing too,
      // since this route persists `path` (planGtdFolderPersist).
      const { path, created } = await imapManager.ensureFolder(account, folder, { resolvePath: true });
      results.push({ folder, path, created });
    } catch (err) {
      console.error(`GTD ensureFolder failed for ${folder}:`, err.message);
      results.push({ folder, error: true });
    }
  }

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
  const storedMerged = { ...DEFAULT_GTD_FOLDERS, ...sanitizeGtdFolders(account.gtd_folders) };
  const plan = planGtdFolderPersist({ merged: storedMerged, stored: account.gtd_folders, results });
  if (plan.collisions) {
    return res.status(400).json({ error: 'Two GTD states cannot map to the same folder', collisions: plan.collisions });
  }
  if (plan.changed) {
    await query('UPDATE email_accounts SET gtd_folders = $1 WHERE id = $2', [plan.folders, accountId]);
    invalidateGtdConfigCache(accountId);
  }

  res.json(plan.changed ? { results, folders: plan.folders } : { results });
});

export default router;
