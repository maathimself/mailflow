import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getGtdSections } from '../services/gtdSections.js';
import { queueGistGeneration } from '../services/gtdGist.js';
import { importPet, decodeUploadedSheet, getPetMeta, getPetSheet, parsePetSlug, customPetSlug } from '../services/gtdPet.js';
import { sanitizeGtdFolders, sanitizeGtdFoldersDetailed, DEFAULT_GTD_FOLDERS, planGtdFolderPersist, invalidateGtdConfigCache } from '../services/gtdConfig.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import {
  classifyTarget,
  gtdClassify,
  gtdDone,
  gtdUnclassify,
  resolveDoneFolders,
} from '../services/gtd/actions.js';

const router = Router();
router.use(requireAuth);

export { classifyTarget, resolveDoneFolders };

// Message/account ids are always UUIDs; pre-validate before any DB lookup so a malformed
// id is a clean 400 rather than a parametrized query that just finds nothing (404) or a
// driver cast error. Same idiom + regex as mail.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


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

// Apply a GTD label by copying the message into the state folder.
router.post('/classify', async (req, res) => {
  const { messageId, state } = req.body || {};
  if (!messageId || !state) return res.status(400).json({ error: 'messageId and state are required' });
  if (!UUID_RE.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await gtdClassify(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    messageId,
    state,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// Remove a GTD label copy while leaving all other message copies intact.
router.delete('/classify', async (req, res) => {
  const { messageId, state } = req.body || {};
  if (!messageId || !state) return res.status(400).json({ error: 'messageId and state are required' });
  if (!UUID_RE.test(messageId)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await gtdUnclassify(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    messageId,
    state,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// Mark a GTD message done, strip labels, and archive its INBOX copy when available.
router.post('/done', async (req, res) => {
  const { id, states } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await gtdDone(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
    states,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
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
