import { Router } from 'express';
import { requireAuth } from '../api.js';
import { getGtdSections } from './gtdSections.js';
import { queueGistGeneration } from './gtdGist.js';
import { importPet, decodeUploadedSheet, getPetMeta, getPetSheet, parsePetSlug, customPetSlug } from './gtdPet.js';
import { getGtdConfig, resolveGtdStateFolder, sanitizeGtdFolders, sanitizeGtdFoldersDetailed, DEFAULT_GTD_FOLDERS, planGtdFolderPersist, invalidateGtdConfigCache } from './gtdConfig.js';
import { applyLabel, hasMessageCopy, resolveLabelCopyUid, removeExactLabelCopy, removeLabel, markThreadRead, markCopySeen, isLabelStoreAccount, supportsUidPlus, ensureLabelFolders, archiveInboxCopy, broadcast, loadOwnedMessage, getOwnedAccount, getMessageCopyFolders, getLabelMetadata, getMessagesByThreadKeys, getAccountConfig, setAccountConfig, resolveAllDraftsPaths, resolveAllTrashPaths, resolveAllSpamPaths } from '../api.js';

// removeMessageCopy refused a label row whose uid holds another message on the server (#665).
const LABEL_CHANGED = 'This label changed on the server and was not removed. Refresh and try again.';

const router = Router();
router.use(requireAuth);

// Message/account ids are always UUIDs; pre-validate before any DB lookup so a malformed
// id is a clean 400 rather than a parametrized query that just finds nothing (404) or a
// driver cast error. Same idiom + regex as mail.js.
const METADATA_STATE_ORDER = ['todo', 'watch', 'delegated', 'reference', 'someday'];
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
    broadcast,
  }).catch(err => console.warn('GTD gist generation error:', err.message));
});

// Bounded, plugin-owned metadata for ordinary message rows. Core supplies only the neutral row
// slot; GTD resolves its configured label folders here without coupling the message-list query to
// any plugin schema or state.
router.post('/metadata', async (req, res) => {
  const { accountId, messageIds } = req.body || {};
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
    return res.status(400).json({ error: 'Invalid account id' });
  }
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 100) {
    return res.status(400).json({ error: 'messageIds must contain 1–100 ids' });
  }
  if (messageIds.some(id => typeof id !== 'string' || !UUID_RE.test(id))) {
    return res.status(400).json({ error: 'Invalid message id' });
  }

  const ids = [...new Set(messageIds)];
  const account = await getOwnedAccount(req.session.userId, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { enabled, folders } = await getGtdConfig(accountId);
  if (!enabled) return res.json({ messages: {} });

  const statesByFolder = new Map();
  for (const state of METADATA_STATE_ORDER) {
    const folder = folders?.[state];
    if (!folder) continue;
    const states = statesByFolder.get(folder) || [];
    states.push(state);
    statesByFolder.set(folder, states);
  }
  const rows = await getLabelMetadata(accountId, ids, [...statesByFolder.keys()]);
  const messages = {};
  for (const row of rows) {
    const states = statesByFolder.get(row.folder);
    if (!states) continue;
    if (!messages[row.messageId]) messages[row.messageId] = { states: [], dates: {}, date: null };
    const entry = messages[row.messageId];
    for (const state of states) {
      if (!entry.states.includes(state)) entry.states.push(state);
      entry.dates[state] = row.date;
    }
    if (row.date && (!entry.date || new Date(row.date) < new Date(entry.date))) entry.date = row.date;
  }
  for (const entry of Object.values(messages)) {
    entry.states.sort((a, b) => METADATA_STATE_ORDER.indexOf(a) - METADATA_STATE_ORDER.indexOf(b));
    entry.dates = Object.fromEntries(entry.states.map(state => [state, entry.dates[state] ?? null]));
  }
  return res.json({ messages });
});

// ── GTD Inbox-Zero pet ────────────────────────────────────────────────────────

// POST /api/gtd/pet/import { petJson, sheet } — import a user's OWN pet by uploading the
// two files directly: pet.json as text, the spritesheet as a base64 / data-URL string.
// The image type is decided by magic bytes inside importPet, so the payload's declared
// mime is irrelevant. The storage slug is derived server-side from the session user (one
// custom slot per user), so the client cannot choose the storage key. Defense is the
// route body limit (middleware/bodyParsers.js) + the size/magic-byte/parse checks inside
// importPet. The chosen slug is persisted separately as a user preference (gtdPetSlug via
// PATCH /auth/preferences); this route only acquires the assets.
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
// POST /api/gtd/classify { messageId, state } — keep one GTD state per thread.
// Copy first so a selected label-folder row remains a valid source, then remove
// other GTD copies. Ordinary labels and the Inbox copy are never removed.
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

  const account = await getOwnedAccount(req.session.userId, msg.account_id);

  let result;
  let oldCopies = [];
  let sourceRemoved = false;
  try {
    const oldStateFolders = new Set(Object.entries(folders)
      .filter(([otherState, folder]) => otherState !== state && folder !== toFolder)
      .map(([, folder]) => folder));
    const threadCopies = msg.thread_key
      ? await getMessagesByThreadKeys(msg.account_id, [msg.thread_key])
      : [];
    if (threadCopies.length) {
      oldCopies = threadCopies
        .filter(copy => oldStateFolders.has(copy.folder))
        .map(copy => ({ message: { ...copy, account_id: msg.account_id }, folder: copy.folder }));
      if (oldStateFolders.has(msg.folder) && !oldCopies.some(copy => copy.message.uid === msg.uid && copy.folder === msg.folder)) {
        oldCopies.push({ message: msg, folder: msg.folder });
      }
    } else {
      // A missing thread key or unindexed thread still gets the same-message
      // labels. The selected row's folder remains known without Message-ID.
      const present = new Set(msg.message_id
        ? await getMessageCopyFolders(msg.account_id, msg.message_id)
        : []);
      present.add(msg.folder);
      for (const folder of oldStateFolders) {
        if (!present.has(folder)) continue;
        const uid = await resolveLabelCopyUid(msg, folder);
        if (uid != null) oldCopies.push({ message: { ...msg, uid, folder }, folder });
      }
    }

    // A failed later removal must leave the selected message id available for
    // retry. The selected old-state row is the last copy we strip.
    const isSelectedCopy = copy => copy.folder === msg.folder && copy.message.uid === msg.uid;
    oldCopies = [
      ...oldCopies.filter(copy => !isSelectedCopy(copy)),
      ...oldCopies.filter(isSelectedCopy),
    ];

    result = await applyLabel(account, msg, toFolder, { forceCopy: oldCopies.length > 0 });
    // A cache-only destination can already be gone on IMAP. Confirm a fresh
    // COPY for each email before expunging any old state, accepting duplicates.
    // An arbitrary stored Message-ID must not collide with a headerless source.
    const identity = message => message.message_id
      ? `rfc:${message.message_id}`
      : `physical:${message.folder}:${message.uid}`;
    const confirmsIdentity = async (message, uid, folder) => {
      if (!message.message_id) return true;
      try {
        return await hasMessageCopy(account, uid, folder, message.message_id);
      } catch (err) {
        console.warn(`GTD classify could not verify copy ${folder}: ${err.message}`);
        return false;
      }
    };
    const preserved = new Set();
    // COPYUID confirms a physical copy, but cached Message-ID metadata may be
    // stale. Reusing that copy for another source requires live identity proof
    // on both sides; unavailable proof falls back to copying each source.
    if (oldCopies.length && result.applied && result.uid != null && await confirmsIdentity(msg, result.uid, toFolder)) {
      preserved.add(identity(msg));
    }
    for (const copy of oldCopies) {
      const key = identity(copy.message);
      if (preserved.has(key) && await confirmsIdentity(copy.message, copy.message.uid, copy.folder)) continue;
      const copied = await applyLabel(account, copy.message, toFolder, { forceCopy: true });
      // Without COPYUID, an OK response may have copied no stale source UID.
      // Copy each physical sibling unless this request confirmed a destination.
      if (copied.uid != null && await confirmsIdentity(copy.message, copied.uid, toFolder)) preserved.add(key);
    }
    // Removal can throw after EXPUNGE. Keep every confirmed target copy;
    // compensation by deletion could erase the last surviving email.
    for (const copy of oldCopies) {
      const { removed } = await removeLabel(copy.message, copy.folder);
      if (removed && isSelectedCopy(copy)) sourceRemoved = true;
    }
  } catch (err) {
    console.error(`GTD classify failed for message ${messageId} -> ${toFolder}:`, err.message);
    // An old label row named another message on the server, so that label was not removed (see
    // DELETE /classify). The new label stays; a retry after the refresh removes the old one.
    if (err.copyChanged) {
      return res.status(409).json({ error: LABEL_CHANGED, changed: true });
    }
    return res.status(500).json({ error: 'Failed to apply GTD label' });
  }

  // The existing undo token can only remove the new copy. A state switch also
  // removed the old state, so offering that token would silently lose it.
  const undoToken = !oldCopies.length && result.applied && result.uid != null && msg.message_id
    ? { messageId, state, folder: toFolder, uid: result.uid }
    : null;
  res.json({ ok: true, folder: toFolder, applied: result.applied, undoToken,
    ...(oldCopies.length ? { switched: true, sourceRemoved } : {}),
  });
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
    // The copy's row named another message on the server, so nothing was removed (as for
    // DELETE /classify): a refusal to say, not a server error.
    if (err.copyChanged) {
      return res.status(409).json({ error: LABEL_CHANGED, changed: true });
    }
    return res.status(500).json({ error: 'Failed to undo GTD classification' });
  }
});

// Whether a message keeps a live copy once the GTD copies in `removing` are deleted. Removing a
// GTD copy deletes it, and a GTD folder can hold a message's only copy: mail the user filed there
// by moving it. Drafts, Trash and Junk do not count, since those get emptied. A row can outlive
// its message for a while after another client moves it, so a copy counts only once the server
// confirms it; a failed check counts as no copy, which keeps the mail. Without a Message-ID the
// other copies cannot be found, so it answers no. On Gmail it is always yes: a GTD folder is a
// label, and removing it leaves the message in All Mail, which MailFlow does not sync.
async function hasSurvivingCopy(account, msg, removing) {
  return await findSurvivingCopy(account, msg, removing) === true;
}

// hasSurvivingCopy's check, answering null when no copy was confirmed but a check failed, so a
// caller can tell "no other copy" from "could not verify".
async function findSurvivingCopy(account, msg, removing) {
  if (isLabelStoreAccount(account)) return true;
  if (!msg.message_id) return false;
  const [drafts, trash, spam, copies] = await Promise.all([
    resolveAllDraftsPaths(account.id, account.folder_mappings),
    resolveAllTrashPaths(account.id, account.folder_mappings),
    resolveAllSpamPaths(account.id, account.folder_mappings),
    getMessageCopyFolders(account.id, msg.message_id),
  ]);
  const unsafe = new Set([...removing, ...drafts, ...trash, ...spam]);
  let unverified = false;
  for (const folder of copies) {
    if (unsafe.has(folder)) continue;
    const uid = await resolveLabelCopyUid(msg, folder);
    if (uid == null) continue;
    try {
      if (await hasMessageCopy(account, uid, folder, msg.message_id)) return true;
    } catch (err) {
      console.warn(`GTD: could not confirm the copy in ${folder}: ${err.message}`);
      unverified = true;
    }
  }
  return unverified ? null : false;
}

// Whether a copy of the acted message about to be archived still reads as unread: done archives
// the acted message read. markThreadRead's `error` cannot
// tell a failed DB fan-out from a failed \Seen push, and the thread's rows can miss a copy filed
// under another thread key, so the copy itself is read back by id. A failed read counts as unread
// and keeps the copy where it is. A row that is gone has nothing to move; the archive's guarded
// write then applies nothing.
async function copyStillUnread(account, copy) {
  try {
    const row = await loadOwnedMessage(account.user_id, copy.id);
    return row ? row.is_read !== true : false;
  } catch (err) {
    console.warn(`GTD done: could not confirm a copy in ${copy.folder || 'INBOX'} was marked read: ${err.message}`);
    return true;
  }
}

// A removal that found nothing to remove means the copy changed after the thread was read. It
// still keeps the thread in the section unless both the cache and the server have lost it; a
// failed check counts as still there.
async function copyIsGone(account, copy) {
  try {
    const folders = await getMessageCopyFolders(account.id, copy.message_id);
    if (folders.includes(copy.folder)) {
      console.warn(`GTD done: a thread copy in ${copy.folder} no longer matches its message, leaving it`);
      return false;
    }
    if (await hasMessageCopy(account, copy.uid, copy.folder, copy.message_id)) {
      console.warn(`GTD done: a thread copy in ${copy.folder} is still on the server, leaving it`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`GTD done: could not check a thread copy in ${copy.folder}: ${err.message}`);
    return false;
  }
}

// Clear another message's copy out of a GTD folder /done is stripping. A thread stays in a
// section while any of its messages has a copy there, so these go too, but each belongs to a
// message the user never acted on and may be its only copy. It is deleted only once the server
// confirms the cached copy is that message and that another copy keeps it; with none, it is
// archived. A copy that cannot be verified, or has no Message-ID to verify, is left where it is.
// Its read state is left as it is: an unread reply the user has not opened stays unread, also
// once archived. Returns { cleared }; a copy left behind keeps the thread in its section, which
// the caller reports as threadRemains. On Gmail the message stays in All Mail, as in hasSurvivingCopy, but
// the uid must still carry the message's Message-ID.
async function clearOtherThreadCopy(account, copy, removing, moves) {
  if (moves.stale) {
    console.warn(`GTD done: a move in this request left a row on an unknown uid, leaving a thread copy in ${copy.folder}`);
    return { cleared: false };
  }
  if (!copy.message_id) {
    console.warn(`GTD done: a thread copy in ${copy.folder} has no Message-ID to verify, leaving it`);
    return { cleared: false };
  }
  let confirmed;
  try {
    confirmed = await hasMessageCopy(account, copy.uid, copy.folder, copy.message_id);
  } catch (err) {
    console.warn(`GTD done: could not verify a thread copy in ${copy.folder}, leaving it: ${err.message}`);
    return { cleared: false };
  }
  if (!confirmed) {
    console.warn(`GTD done: a thread copy in ${copy.folder} is not on the server as cached, leaving it`);
    return { cleared: false };
  }
  if (isLabelStoreAccount(account)) {
    const { removed } = await removeExactLabelCopy(copy, copy.folder, copy.uid);
    return { cleared: removed || await copyIsGone(account, copy), removed };
  }
  const survivor = await findSurvivingCopy(account, copy, removing);
  if (survivor === null) {
    console.warn(`GTD done: could not verify another copy of a thread message in ${copy.folder}, leaving it`);
    return { cleared: false };
  }
  if (survivor) {
    const { removed } = await removeLabel(copy, copy.folder);
    return { cleared: removed || await copyIsGone(account, copy), removed };
  }
  if (!moves.allowed) {
    console.warn(`GTD done: the only copy of a thread message stays in ${copy.folder}; the server cannot name a moved uid`);
    return { cleared: false };
  }
  try {
    const { archived, noArchiveFolder, uidKnown } = await archiveInboxCopy(account, copy, copy.folder);
    if (archived && !uidKnown) moves.stale = true;
    if (noArchiveFolder) {
      console.warn(`GTD done: the only copy of a thread message stays in ${copy.folder}; no archive folder`);
      return { cleared: false };
    }
    return { cleared: true, removed: archived };
  } catch (err) {
    moves.stale = true;
    console.error(`GTD done: archive of a thread copy in ${copy.folder} failed:`, err.message);
    return { cleared: false };
  }
}

// Archive INBOX rows of a message. Every row other than `flaggedId`, the row markThreadRead
// resolved and flagged \Seen, is moved only once the server confirms it. With `markRead` (the
// acted message, which done marks read) a row not marked read stays, and a confirmed row takes
// \Seen here, unless markThreadRead already wrote it (`pushedIds`), so it does not sync back
// unread from the archive. Without it (another message in the conversation) the row moves with
// its read state as it is. No row moves when `moves` forbids it (see /done). One row failing
// does not stop the rest. Returns { archived } when any row moved, { failed } when one was left behind, and
// { noArchiveFolder }.
async function archiveInboxRows(account, rows, flaggedId, moves, { markRead = true, pushedIds = [] } = {}) {
  const outcome = { archived: false, failed: false, noArchiveFolder: false };
  for (const row of rows) {
    if (!moves.allowed || moves.stale) {
      console.warn('GTD done: leaving a thread copy in INBOX; a move could leave its row on another message\'s uid');
      outcome.failed = true;
      continue;
    }
    try {
      if (markRead && await copyStillUnread(account, row)) {
        console.warn('GTD done: an INBOX copy was not marked read, leaving it');
        outcome.failed = true;
        continue;
      }
      if (row.id !== flaggedId) {
        let confirmed;
        try {
          confirmed = await hasMessageCopy(account, row.uid, 'INBOX', row.message_id);
        } catch (err) {
          console.warn(`GTD done: could not verify a duplicate INBOX copy, leaving it: ${err.message}`);
        }
        if (!confirmed) {
          if (confirmed === false) console.warn('GTD done: a duplicate INBOX copy is not on the server as cached, leaving it');
          outcome.failed = true;
          continue;
        }
        if (markRead && !pushedIds.includes(row.id)) {
          const { error } = await markCopySeen(account, { ...row, folder: 'INBOX' });
          if (error) console.warn(`GTD done: \\Seen for a thread copy in INBOX degraded: ${error.message}`);
        }
      }
      const result = await archiveInboxCopy(account, row, 'INBOX');
      if (result.archived && !result.uidKnown) moves.stale = true;
      if (result.archived) outcome.archived = true;
      if (result.noArchiveFolder) {
        outcome.noArchiveFolder = true;
        break;
      }
    } catch (err) {
      moves.stale = true;
      console.error('GTD done: archive of a thread copy in INBOX failed:', err.message);
      outcome.failed = true;
    }
  }
  return outcome;
}

// Archive another thread message's INBOX rows, so done takes the whole conversation out of the
// Inbox. Each row is confirmed on the server first, and keeps its read state: a reply the user
// has not opened stays unread in the archive. A headerless copy cannot be confirmed by
// Message-ID, so it stays. Returns as archiveInboxRows.
async function archiveOtherInboxCopies(account, rows, moves) {
  if (!rows[0].message_id) {
    console.warn('GTD done: a thread copy in INBOX has no Message-ID to resolve, leaving it');
    return { failed: true };
  }
  return archiveInboxRows(account, rows, null, moves, { markRead: false });
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
  const account = await getOwnedAccount(req.session.userId, msg.account_id);
  if (!await hasSurvivingCopy(account, msg, [stateFolder])) {
    return res.status(409).json({ error: 'This is the only copy of the message. Archive or move it instead.', onlyCopy: true });
  }
  try {
    const { removed } = await removeLabel(msg, stateFolder);
    if (!removed) return res.json({ ok: true, removed: false });
  } catch (err) {
    console.error(`GTD unclassify failed for message ${messageId} in ${stateFolder}:`, err.message);
    // The label row named another message on the server. Nothing was removed; the row was dropped
    // and the folder pulled, so a retry after the refresh finds the copy where it really is.
    if (err.copyChanged) {
      return res.status(409).json({ error: LABEL_CHANGED, changed: true });
    }
    return res.status(500).json({ error: 'Failed to remove GTD label' });
  }

  res.json({ ok: true, removed: true, folder: stateFolder });
});

// POST /api/gtd/done { id, states? } — the GTD "done" action. Two callers: the GTD sidebar passes
// an explicit `states` array (strip that section's labels); the inbox checkmark omits states
// (or sends 'all') for "done from anywhere" — strip every GTD label the thread carries. The
// id is its GTD-label-folder copy for the sidebar, or the INBOX copy from the inbox; either way
// the archive step resolves the INBOX copy from the shared Message-ID rather than acting on
// `id` directly. In one round trip this: (a) strips the thread's GTD label copies named in
// `states` — a merged Waiting row passes both watch+delegated — leaving any GTD labels in OTHER
// sections intact; (b) marks the acted message read (DB fan-out across its surviving copies,
// \Seen on the INBOX copy so it rides the archive move); (c) archives its INBOX copy and, from
// the sidebar, every other INBOX copy in the thread, whose read state is left as it is.
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
  // Only a GTD section row (explicit states) stands for a whole conversation, so only it clears
  // and archives the other messages. The inbox checkmark acts on one message: in the flat list
  // its thread-mates are rows of their own, which the user may not have seen.
  const threadCopies = enabled && !allStates && msg.thread_key
    ? await getMessagesByThreadKeys(msg.account_id, [msg.thread_key])
    : [];
  const copyFolders = enabled ? await getMessageCopyFolders(msg.account_id, msg.message_id) : [];
  let existing;
  if (allStates && enabled) existing = copyFolders;
  const target = allStates
    ? resolveDoneFolders({ enabled, folders, states: 'all', existing })
    : resolveDoneFolders({ enabled, folders, states });
  if (target.error) return res.status(target.status).json({ error: target.error });

  const account = await getOwnedAccount(req.session.userId, msg.account_id);

  // (a) Strip the thread's GTD label copies: the acted message's, resolved from its Message-ID,
  // and every other message's copy in those folders (clearOtherThreadCopy).
  // removeMessageCopy deletes the IMAP + DB copy and adjusts that label folder's counts,
  // leaving INBOX and other-section labels untouched.
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

  // When nothing else keeps the message, the acted GTD copy is archived instead of deleted: it
  // is the message's only copy (see hasSurvivingCopy). Without an acted GTD copy to keep, refuse
  // rather than delete them all.
  let keepActed = false;
  if (stripOrder.length && !await hasSurvivingCopy(account, msg, stripOrder)) {
    if (!stripOrder.includes(msg.folder)) {
      return res.status(409).json({ error: 'This is the only copy of the message. Archive or move it instead.', onlyCopy: true });
    }
    // The kept copy is what makes deleting the others safe, so it has to be on the server, not
    // only in the cache: another client may have moved the message into a folder done strips.
    let keptLive = false;
    try {
      keptLive = await hasMessageCopy(account, msg.uid, msg.folder, msg.message_id);
    } catch (err) {
      console.warn(`GTD done: could not confirm the kept copy of ${id}: ${err.message}`);
    }
    if (!keptLive) return res.status(409).json({ error: 'This is the only copy of the message. Archive or move it instead.', onlyCopy: true });
    keepActed = true;
  }

  // Mark the acted message read before anything is stripped, while its row still vouches for the
  // copies the server keeps per copy. The DB fan-out (by Message-ID) covers every sibling copy and
  // adjusts each folder's unread count; \Seen goes to the INBOX copy, which rides the archive
  // move, and to the copies that stay, never to the ones about to be stripped (`excludeFolders`).
  // `pushedIds` lists the copies whose \Seen was confirmed, so none of them is written twice
  // below. A best-effort flag push is never fatal; a failed INBOX lookup throws before any write,
  // so done stops there and a retry starts clean.
  let inboxCopy;
  let pushedIds;
  try {
    const result = await markThreadRead(account, msg, { excludeFolders: stripOrder });
    inboxCopy = result.inboxCopy;
    pushedIds = result.pushedIds || [];
    if (result.error) console.warn(`GTD done: mark-read for ${id} degraded:`, result.error.message);
  } catch (err) {
    console.error(`GTD done: INBOX lookup for ${id} failed:`, err.message);
    return res.status(500).json({ error: 'Failed to mark done' });
  }

  // The thread's other messages' copies go first, so the acted row is still the last one stripped.
  const otherCopies = threadCopies
    .filter(copy => copy.message_id !== msg.message_id && stripOrder.includes(copy.folder))
    .map(copy => ({ ...copy, account_id: msg.account_id }));

  // Without UIDPLUS a moved row keeps its old uid in Archive, where it can name another message,
  // and a second move in the same request can land on it. Done then moves only the acted
  // message's own copy: another message's copy that would need a move stays where it is. A
  // server that claims UIDPLUS but answers a move without the new uid stops every later move,
  // and every later change to another message's copies, in this request. Deleting another
  // message's GTD copy without UIDPLUS is still allowed: it happens before any move.
  const moves = { allowed: true, stale: false };
  if (otherCopies.length || threadCopies.some(copy => copy.folder === 'INBOX')) {
    moves.allowed = await supportsUidPlus(account);
  }

  const removed = [];
  let threadRemains = false;
  // Another message's copy that fails to clear is left where it is; only the acted message's own
  // strip below 500s, since its row is what a same-id retry resolves.
  for (const copy of otherCopies) {
    try {
      const result = await clearOtherThreadCopy(account, copy, stripOrder, moves);
      if (!result.cleared) threadRemains = true;
      if (result.removed && !removed.includes(copy.folder)) removed.push(copy.folder);
    } catch (err) {
      console.error(`GTD done: clearing a thread copy in ${copy.folder} failed, leaving it:`, err.message);
      threadRemains = true;
    }
  }
  // removeLabel removes one copy per folder. A second row with the acted Message-ID in a stripped
  // folder stays: some senders reuse a Message-ID for different mail, so it may not be a duplicate
  // at all. The re-check below reports it as threadRemains.
  // A label row that names another message on the server is skipped, not fatal: nothing was
  // removed for it, its row was dropped and its folder pulled, and the rest of done (the other
  // labels, the archive) acts on copies checked on their own. Stopping here instead would leave
  // the labels already stripped and the INBOX copy unarchived. The thread stays in that section
  // until the copy is re-filed, so it is reported as threadRemains and in `changed`.
  const changed = [];
  try {
    for (const folder of stripOrder) {
      if (keepActed && folder === msg.folder) continue;
      let didRemove;
      try {
        ({ removed: didRemove } = await removeLabel(msg, folder));
      } catch (err) {
        if (!err.copyChanged) throw err;
        console.warn(`GTD done: the ${folder} copy of ${id} changed on the server, leaving it:`, err.message);
        changed.push(folder);
        threadRemains = true;
        continue;
      }
      if (didRemove && !removed.includes(folder)) removed.push(folder);
    }
  } catch (err) {
    // The acted row is stripped last, so a retry by the same id still resolves it.
    console.error(`GTD done: label strip for ${id} failed:`, err.message);
    return res.status(500).json({ error: 'Failed to mark done' });
  }

  // A copy of the acted message still in a stripped folder keeps the thread in its section. The
  // kept copy's own folder is expected to hold it until the archive below.
  try {
    const left = await getMessageCopyFolders(account.id, msg.message_id);
    if (left.some(folder => stripOrder.includes(folder) && !(keepActed && folder === msg.folder))) {
      console.warn(`GTD done: a copy of ${id} is still in a stripped GTD folder`);
      threadRemains = true;
    }
  } catch (err) {
    console.warn(`GTD done: could not re-check the copies of ${id}: ${err.message}`);
    threadRemains = true;
  }

  // (c) Archive the acted message's INBOX copy if one is present, then every other thread
  // message's INBOX rows (archiveInboxRows, archiveOtherInboxCopies), via the shared per-copy archive primitive
  // (resolveArchiveFolder + guarded moveMessage + race-safe DB repoint + count adjust, with
  // the Gmail All-Mail DELETE branch). No archive folder configured is a soft outcome, not a
  // failure — the GTD labels are already gone, so the thread has left all GTD sections regardless.
  let archived = false;
  let noArchiveFolder = false;
  let archiveFailed = false;
  // An INBOX copy that appeared after the only-copy check leaves the kept GTD copy in its folder.
  if (keepActed && inboxCopy) threadRemains = true;
  // Likewise a kept copy the DB never marked read: done archives the acted message read.
  const keptUnmarked = keepActed && !inboxCopy
    && await copyStillUnread(account, msg);
  if (keptUnmarked) {
    console.error(`GTD done: ${id} was not marked read, leaving its only copy in ${msg.folder}`);
    archiveFailed = true;
    threadRemains = true;
  }
  // An INBOX copy whose message the DB never marked read stays, for the same reason.
  const inboxUnmarked = Boolean(inboxCopy) && await copyStillUnread(account, { ...inboxCopy, folder: 'INBOX' });
  if (inboxUnmarked) {
    console.error(`GTD done: ${id} was not marked read, leaving its INBOX copy`);
    archiveFailed = true;
  }
  const toArchive = inboxCopy
    ? (inboxUnmarked ? null : inboxCopy)
    : (keepActed && !keptUnmarked ? msg : null);
  if (toArchive) {
    try {
      // A kept GTD copy is archived from its own folder; with no archive folder it stays put. It
      // is now the durable copy, so it takes \Seen unless (b) already wrote it.
      if (!inboxCopy && !pushedIds.includes(msg.id)) {
        const { error } = await markCopySeen(account, msg);
        if (error) console.warn(`GTD done: mark-read for ${id} degraded:`, error.message);
      }
      const result = await archiveInboxCopy(account, toArchive, inboxCopy ? 'INBOX' : msg.folder);
      if (result.archived && !result.uidKnown) moves.stale = true;
      archived = result.archived;
      noArchiveFolder = result.noArchiveFolder;
      // A kept GTD copy with nowhere to go stays in its folder, and the thread in its section.
      if (!inboxCopy && noArchiveFolder) threadRemains = true;
    } catch (err) {
      // Step (a) already stripped the labels (or had nothing to strip). A failed archive must
      // not 500: that misreports a mostly-successful action, and — with the label row now
      // gone — a retry by the same id would 404. Report a partial success (200, archiveFailed
      // true, archived false) so the client can surface it and the id stays retryable.
      console.error(`GTD done: archive of INBOX copy for ${id} failed:`, err.message);
      moves.stale = true;
      archiveFailed = true;
      // A kept GTD copy that failed to move is still in its folder, so is the thread.
      if (!inboxCopy) threadRemains = true;
    }
  }

  // With the kept copy moved out, its folder no longer needs to hold the message. A duplicate there
  // was not stripped (the kept copy was the only one outside the stripped folders), so it keeps the
  // thread in its section. (A kept copy that stayed put already set threadRemains above.)
  if (keepActed && !inboxCopy && archived) {
    try {
      const left = await getMessageCopyFolders(account.id, msg.message_id);
      if (left.some(folder => stripOrder.includes(folder))) {
        console.warn(`GTD done: a copy of ${id} is still in a stripped GTD folder beside the kept copy`);
        threadRemains = true;
      }
    } catch (err) {
      console.warn(`GTD done: could not re-check the copies of ${id}: ${err.message}`);
      threadRemains = true;
    }
  }

  // Done on a section row archives the whole conversation: the acted message's other INBOX rows (a
  // duplicate under the same Message-ID; markThreadRead resolved only one), then every other
  // message's. The inbox checkmark loaded no thread rows, so it archives only the acted message.
  const inboxRows = threadCopies
    .filter(copy => copy.folder === 'INBOX')
    .map(copy => ({ ...copy, account_id: msg.account_id }));
  const actedExtras = inboxRows.filter(copy => copy.message_id === msg.message_id && copy.id !== inboxCopy?.id);
  if (inboxCopy && actedExtras.length) {
    const result = await archiveInboxRows(account, actedExtras, inboxCopy.id, moves, { pushedIds });
    if (result.failed) archiveFailed = true;
    if (result.noArchiveFolder) noArchiveFolder = true;
    if (result.archived) archived = true;
  }
  const otherMessages = new Map();
  for (const copy of inboxRows) {
    if (copy.message_id === msg.message_id) continue;
    const key = copy.message_id || Symbol('headerless');
    if (!otherMessages.has(key)) otherMessages.set(key, []);
    otherMessages.get(key).push(copy);
  }
  for (const rows of otherMessages.values()) {
    const result = await archiveOtherInboxCopies(account, rows, moves);
    if (result.failed) archiveFailed = true;
    if (result.noArchiveFolder) noArchiveFolder = true;
    if (result.archived) archived = true;
  }

  // One terminal refresh so GTD section data converges to the post-done state (removeMessageCopy
  // also emits mid-op, but this covers the archive that follows it).
  broadcast({ type: 'gtd_sections_updated', accountId: msg.account_id }, account.user_id);

  res.json({ ok: true, removed, archived, noArchiveFolder, archiveFailed, threadRemains, changed });
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
