import { Router } from 'express';
import { createHash } from 'node:crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { sanitizeEmail, stripEmailHead, hasRemoteImages, blockRemoteImages, rewriteEbayImageserUrls, rewriteAnchorHrefs } from '../services/emailSanitizer.js';
import { snippetFromBody, decodeMimeWords, parseRawHeaders, buildHeadersFromMessage } from '../services/messageParser.js';
import { resolveTrashFolder, resolveAllTrashPaths, resolveAllDraftsPaths, resolveArchiveFolder, isAllMailFolder, resolveSpamFolder, resolveAllSpamPaths, getDeleteStrategy } from '../utils/mailUtils.js';
import { pluginRegistry } from '../plugins/registry.js';
import { listMessages } from '../services/messageService.js';
import { resolveAccountScope } from '../services/unifiedInbox.js';
import { validateHost } from '../services/hostValidation.js';
import { safeFetch } from '../services/safeFetch.js';
import { safeFilename, attachmentDisposition } from '../utils/contentDisposition.js';
import {
  MessageSnapshotError,
  revalidateLiveMessageSnapshots,
  snapshotFromMessageRow,
} from '../services/messageSnapshots.js';
import { materializeArchiveReceipt } from '../services/archiveInbox.js';

function materializeOrdinaryMove(destinationFolder, allMail = false) {
  return (row, receipt, operation, tx, providerResource) => materializeArchiveReceipt(tx, {
    accountId: row.account_id,
    sourceSnapshot: row,
    destinationFolder,
    receipt,
    operation,
    allMail,
    providerResource,
  });
}

const router = Router();
router.use(requireAuth);

// Whether an account-scoped plugin that maintains label sibling rows (currently GTD) is active for
// this account — the modern replacement for the former email_accounts.gtd_enabled gate on the
// read/star sibling fan-out. Core stays plugin-agnostic: it asks the registry, never GTD directly.
// Folds plugin activation in (strictly safer than the old raw column — a deactivated plugin no
// longer triggers fan-out). The fan-out itself is still additionally gated on the message actually
// having siblings, so a non-plugin account stays byte-identical to pre-GTD.
const accountMaintainsLabelSiblings = (accountId) =>
  pluginRegistry.hasActiveAsync('inboxIngest', { account: { id: accountId } });

async function deliverDesiredFlagToLiveSiblings(account, message, flag, value) {
  if (!message.message_id) return;
  const siblings = await query(
    `SELECT m.id, m.account_id, m.uid, m.folder, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                     AND f.is_present = true AND f.uid_validity IS NOT NULL
      WHERE m.account_id = $1 AND m.message_id = $2 AND m.id <> $3
        AND m.is_deleted = false AND m.metadata_complete = true
      ORDER BY m.id`,
    [message.account_id, message.message_id, message.id],
  );
  let firstError;
  for (const sibling of siblings.rows) {
    try {
      await imapManager.setDesiredFlag(
        account, sibling.id, flag, value, { snapshot: snapshotFromMessageRow(sibling) },
      );
    } catch (err) {
      if (!err?.uncertain) firstError ||= err;
    }
  }
  if (firstError) throw firstError;
}

// Validate a folder name / path component: no control chars, max 255 chars.
function isValidFolderName(name) {
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function areValidUUIDs(ids) {
  return ids.every(id => typeof id === 'string' && UUID_RE.test(id));
}

function validatedRowOperationKeys(ids, value, compatibility) {
  const canonicalIds = ids.map(id => id.toLowerCase());
  if (new Set(canonicalIds).size !== ids.length) return null;
  if (value == null) {
    return new Map(canonicalIds.map(id => {
      const digest = createHash('sha256')
        .update(`${compatibility.userId}\0${compatibility.kind}\0${id}\0${compatibility.destination || ''}`)
        .digest('hex');
      return [id, `compat:${digest}`];
    }));
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const valueEntries = Object.entries(value);
  if (valueEntries.length !== ids.length) return null;
  const valuesByCanonicalId = new Map();
  for (const [id, key] of valueEntries) {
    if (!UUID_RE.test(id)) return null;
    const canonicalId = id.toLowerCase();
    if (valuesByCanonicalId.has(canonicalId)) return null;
    valuesByCanonicalId.set(canonicalId, key);
  }
  const keys = new Map();
  const seen = new Set();
  for (const id of canonicalIds) {
    if (!valuesByCanonicalId.has(id)) return null;
    const key = valuesByCanonicalId.get(id);
    if (typeof key !== 'string' || key.length < 1 || key.length > 128 ||
        key !== key.trim() ||
        // eslint-disable-next-line no-control-regex -- operation keys must be safe text
        /[\x00-\x1f\x7f]/.test(key) || seen.has(key)) return null;
    keys.set(id, key);
    seen.add(key);
  }
  return keys;
}

// Strip NUL bytes from strings before DB writes. PostgreSQL UTF-8 text columns
// reject 0x00, and malformed MIME bodies can contain embedded NUL characters.
function sanitizeDbText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\0/g, '');
}

// Process IMAP operations in bounded batches so a 500-message bulk action
// does not spawn hundreds of parallel temporary IMAP connections.
async function runInBatches(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// Columns copied verbatim when a message row is relocated to a new folder/UID via the
// DELETE + reinsert CTE used by the bulk trash / move / archive paths on UIDPLUS servers.
// The destination uid comes from the UIDPLUS map (u.new_uid) and the destination folder is
// always bound as $4; everything else is carried over from the deleted row (d.*).
//
// Excluded on purpose:
//   - id, synced_at        -> use their column defaults (a fresh UUID and timestamp), which
//                             preserves the historical "row gets a new id on move" behavior.
//   - normalized_subject,
//     search_vector,
//     thread_key           -> GENERATED ALWAYS columns; Postgres computes them, and inserting
//                             an explicit value (even NULL) errors.
//
// IMPORTANT: when a migration adds a data column to `messages`, add it to RELOCATE_COPY_COLS
// or a relocate will silently reset it to its default. This list previously went stale and
// dropped delivery_addresses (0037), plugin_annotations (0044) and sender_name/sender_email
// (0050). A unit test (mail.relocate.test.js) guards the four that regression touched.
const RELOCATE_COPY_COLS = [
  'message_id', 'subject', 'from_name', 'from_email', 'to_addresses', 'cc_addresses',
  'reply_to', 'in_reply_to', 'date', 'snippet', 'is_read', 'is_starred', 'has_attachments',
  'flags', 'body_html', 'body_text', 'attachments', 'thread_references', 'thread_id', 'is_bulk',
  'read_changed_at', 'star_changed_at', 'spam_score_sa', 'spam_score_ml', 'spam_verdict',
  'spam_analyzed_at', 'spam_details', 'spam_user_override', 'category', 'list_unsubscribe',
  'list_unsubscribe_post', 'unsubscribed_at', 'delivery_addresses', 'plugin_annotations',
  'sender_name', 'sender_email', 'metadata_complete',
  'read_revision', 'star_revision', 'provider_modseq',
];
// INSERT target list and the matching SELECT projection. account_id + the carried columns come
// from the deleted row; uid is the UIDPLUS-mapped new uid; folder is the destination ($4).
export const RELOCATE_INSERT_COLS = ['account_id', 'uid', 'folder', ...RELOCATE_COPY_COLS].join(', ');
export const RELOCATE_SELECT_COLS = ['d.account_id', 'u.new_uid', '$4', ...RELOCATE_COPY_COLS.map(c => `d.${c}`)].join(', ');


// Returns true if a snippet contains content that should never appear in plain-text
// preview, indicating it was generated from unclean HTML and needs regeneration:
//   - &entity; — undecoded HTML entities from before the entity-stripping fix
//   - ##marker## — unexpanded template placeholders (UPS, Epsilon marketing mail)
//   - --> — dangling HTML comment end leaked by comment-stripping gap
function snippetIsGarbled(s) {
  return s && (
    /&[a-z][a-z0-9]*;/i.test(s) ||   // undecoded HTML entity
    /##[^#]*##/.test(s) ||             // unexpanded template placeholder
    /-->/.test(s) ||                   // dangling HTML comment fragment
    /\{[^}]*[:;][^}]*\}/.test(s) ||   // stored CSS rule block
    /<[a-z][^>]*>/i.test(s) ||         // raw HTML tag
    /<\/[a-z][a-z0-9:-]*\s*>/i.test(s) || // stray closing HTML tag
    /([=_*#~-])\1{3,}/.test(s) ||      // decorative divider run
    /\[[^\]]+\]\(https?:\/\//.test(s)  // Markdown link syntax from ESP text/plain generators
  );
}

// Fire-and-forget notification to label plugins after an ordinary mail mutation. Groups the
// acted rows by account and dispatches the generic `onMailMutation` hook per account; a label
// plugin (GTD) decides whether the mutation touched one of its labelled threads and broadcasts
// its own scoped refresh — either a live sibling post-mutation, or one of the acted rows sitting
// in a label folder pre-mutation (covers removing the last label copy of a thread, which leaves
// no post-mutation sibling to find). Rows are the pre-mutation message rows so their message_id
// and folder are captured before a move/delete can drop them; the hook swallows per-plugin
// errors, so a completed mutation is never turned into a 500.
function notifyMailMutation(rows, userId) {
  const byAccount = new Map();
  for (const m of rows) {
    if (!m.message_id) continue;
    if (!byAccount.has(m.account_id)) byAccount.set(m.account_id, { mids: new Set(), folders: new Set() });
    const entry = byAccount.get(m.account_id);
    entry.mids.add(m.message_id);
    if (m.folder) entry.folders.add(m.folder);
  }
  for (const [accountId, { mids, folders }] of byAccount) {
    pluginRegistry.runHook('onMailMutation', {
      imapManager: imapManager.pluginFacade, accountId, userId, messageIds: [...mids], actedFolders: [...folders],
    }).catch(err => console.warn('onMailMutation hook failed:', err.message));
  }
}

// Get messages (unified or per-account/folder)
router.get('/messages', async (req, res) => {
  const { accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded, category } = req.query;

  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });

  // Validate category param — only allow known values to prevent SQL injection via the
  // WHERE clause in listMessages (even though it uses parameterised queries, belt-and-suspenders).
  const VALID_CATEGORIES = new Set(['primary', 'newsletter', 'promotion', 'automated', 'social']);
  const safeCategory = VALID_CATEGORIES.has(category) ? category : undefined;

  const { messages, total, threaded: isThreaded, resolvedAccountId } = await listMessages({
    userId: req.session.userId,
    accountId,
    folder,
    limit,
    offset,
    unreadOnly,
    threaded,
    category: safeCategory,
  });

  if (resolvedAccountId && messages.length) {
    imapManager.prefetchFolderBodies(resolvedAccountId, messages.map(r => r.id))
      .catch(err => console.warn('Folder body prefetch error:', err.message));
  }

  res.json({ messages, total, ...(isThreaded ? { threaded: true } : {}) });
});

router.get('/messages/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message ID' });
  try {
    const result = await query(`
      SELECT m.id, m.uid, m.folder, m.message_id, m.subject,
             m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
             m.reply_to, m.in_reply_to,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id, m.category,
             m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses,
             a.name AS account_name, a.email_address AS account_email,
             a.color AS account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      JOIN folders live_folder ON live_folder.account_id = m.account_id
        AND live_folder.path = m.folder AND live_folder.is_present = true
        AND live_folder.uid_validity IS NOT NULL
      WHERE m.id = $1
        AND a.user_id = $2
        AND m.is_deleted = false
        AND m.metadata_complete = true
    `, [id, req.session.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /messages/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load message' });
  }
});

// Resolve a message by a DURABLE reference, for deep links (#270). The row's UUID PK is
// regenerated when an email is moved/resynced (rows are purged + re-inserted), so a deep
// link keyed on the UUID dies once the email changes folder. We instead match the stable
// RFC Message-ID header first, then fall back to the UUID for legacy links and push
// notifications (which still embed the UUID and are short-lived anyway). Columns and the
// user-scoping (a.user_id, is_deleted) mirror GET /messages/:id. Distinct path so it never
// collides with the greedy /messages/:id route.
router.get('/resolve-message', async (req, res) => {
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return res.status(400).json({ error: 'Missing ref' });
  const rawAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
  if (rawAccountId && !UUID_RE.test(rawAccountId)) {
    return res.status(400).json({ error: 'Invalid accountId' });
  }
  const accountId = rawAccountId || null;
  const COLS = `m.id, m.uid, m.folder, m.message_id, m.subject,
             m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
             m.reply_to, m.in_reply_to,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id, m.category,
             m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses,
             a.name AS account_name, a.email_address AS account_email,
             a.color AS account_color`;
  try {
    // Durable match on the stable Message-ID header. When the same email exists in more
    // than one folder (e.g. INBOX + Archive), prefer the INBOX copy, then the most recent.
    let result = await query(`
      SELECT ${COLS}
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      JOIN folders live_folder ON live_folder.account_id = m.account_id
        AND live_folder.path = m.folder AND live_folder.is_present = true
        AND live_folder.uid_validity IS NOT NULL
      WHERE m.message_id = $1
        AND a.user_id = $2
        AND m.is_deleted = false
        AND m.metadata_complete = true
        AND ($3::uuid IS NULL OR m.account_id = $3)
      ORDER BY (m.folder = 'INBOX') DESC, m.date DESC NULLS LAST
      LIMIT 1
    `, [ref, req.session.userId, accountId]);
    // Legacy links / push notifications carry the UUID primary key.
    if (result.rows.length === 0 && UUID_RE.test(ref)) {
      result = await query(`
        SELECT ${COLS}
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        JOIN folders live_folder ON live_folder.account_id = m.account_id
          AND live_folder.path = m.folder AND live_folder.is_present = true
          AND live_folder.uid_validity IS NOT NULL
        WHERE m.id = $1
          AND a.user_id = $2
          AND m.is_deleted = false
          AND m.metadata_complete = true
          AND ($3::uuid IS NULL OR m.account_id = $3)
      `, [ref, req.session.userId, accountId]);
    }
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /resolve-message error:', err.message);
    res.status(500).json({ error: 'Failed to resolve message' });
  }
});

// Returns true if remote images should be blocked for this message given the user's preferences.
// Default behaviour (no preference set) is to block.
function shouldBlockImages(prefs, message) {
  if (prefs?.blockRemoteImages === false) return false;
  const senderEmail = (message.from_email || '').toLowerCase();
  const atIdx = senderEmail.indexOf('@');
  const senderDomain = atIdx >= 0 ? senderEmail.slice(atIdx + 1) : '';
  const whitelist = prefs?.imageWhitelist || {};
  const allowedAddresses = Array.isArray(whitelist.addresses) ? whitelist.addresses.filter(a => typeof a === 'string').map(a => a.toLowerCase()) : [];
  const allowedDomains   = Array.isArray(whitelist.domains)   ? whitelist.domains.filter(d => typeof d === 'string').map(d => d.toLowerCase())   : [];
  if (senderEmail && allowedAddresses.includes(senderEmail)) return false;
  if (senderDomain && allowedDomains.some(d => senderDomain === d || senderDomain.endsWith('.' + d))) return false;
  return true;
}

// Get all messages belonging to a thread (for threaded view expansion)
router.get('/thread/:threadId', async (req, res) => {
  const { threadId } = req.params;
  if (!threadId) return res.status(400).json({ error: 'threadId required' });

  try {
    const accountsResult = await query(
      'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
      [req.session.userId]
    );
    const accountIds = req.query.unified === 'true'
      ? resolveAccountScope(accountsResult.rows).accountIds
      : accountsResult.rows.map(row => row.id);
    if (!accountIds.length) return res.json({ messages: [] });

    // Show all non-deleted messages in the thread regardless of folder. This includes
    // Sent replies (which have distinct message_ids) alongside received messages.
    // DISTINCT ON (m.message_id) deduplicates the same message appearing in multiple
    // folders (e.g. Gmail's All Mail), preferring the INBOX copy.
    const result = await query(`
      WITH deduped AS (
        SELECT DISTINCT ON (m.message_id)
               m.id, m.uid, m.folder, m.message_id, m.thread_id, m.subject,
               m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
               m.reply_to, m.in_reply_to,
               m.date, m.snippet, m.is_read, m.is_starred,
               m.has_attachments, m.account_id, m.category,
               m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at, m.delivery_addresses,
               a.name AS account_name, a.email_address AS account_email, a.color AS account_color
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        JOIN folders live_folder ON live_folder.account_id = m.account_id
          AND live_folder.path = m.folder AND live_folder.is_present = true
          AND live_folder.uid_validity IS NOT NULL
        WHERE m.is_deleted = false
          AND m.metadata_complete = true
          AND m.account_id = ANY($1)
          AND m.thread_key = $2
        ORDER BY m.message_id,
                 CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                 m.date ASC
      )
      SELECT * FROM deduped ORDER BY date ASC
    `, [accountIds, threadId]);

    res.json({ messages: result.rows });
  } catch (err) {
    console.error('Thread fetch error:', err);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

// Unread counts
// Reads directly from the messages table (source of truth) rather than the
// folders.unread_count cache. The cache is updated at the START of each sync
// cycle, before new messages are inserted, so it lags by one full sync interval
// (~60 s) after new mail arrives. Querying messages directly means the count
// returned immediately after the new_messages WS event is always authoritative.
router.get('/unread-counts', async (req, res) => {
  const result = await query(`
    SELECT m.account_id, a.include_in_unified_inbox, COUNT(*) AS count
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE a.user_id = $1 AND a.enabled = true
      AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false
      AND m.metadata_complete = true
    GROUP BY m.account_id, a.include_in_unified_inbox
  `, [req.session.userId]);

  const byAccount = {};
  let total = 0;
  for (const row of result.rows) {
    byAccount[row.account_id] = parseInt(row.count);
    if (row.include_in_unified_inbox !== false) total += parseInt(row.count);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ total, byAccount });
});

// Hard cap on a live IMAP body fetch. Connection acquisition is already bounded at 30s
// inside imapManager, but the FETCH itself is not — on a half-open/stalled connection
// (e.g. an account mid-reconnect, as happens on large flaky mailboxes) it can hang
// indefinitely, and with no response the client's body spinner spins forever. 40s sits
// above the 30s connect bound so a legitimately slow connect still completes.
const BODY_FETCH_TIMEOUT_MS = 40000;

// Reject with a tagged error if `promise` doesn't settle within `ms`. The underlying
// fetch keeps running and releases its pooled client via withFreshClient's own cleanup;
// we just stop making the HTTP request wait on it. clearTimeout avoids keeping the
// event loop alive after the race settles.
function fetchWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('BODY_FETCH_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Get full message body + attachments list
router.get('/messages/:id/body', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.*, a.user_id, u.preferences,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    JOIN users u ON u.id = a.user_id
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];
  const messageSnapshot = snapshotFromMessageRow(message);

  // Return cached body if available — but re-fetch when the cached HTML still
  // contains unresolved cid: references, or http:// image URLs that were cached
  // before the http→https upgrade was added (would be blocked as mixed content).
  const hasCidRefs  = message.body_html && /\bcid:/i.test(message.body_html);
  const hasHttpImgs = message.body_html && (
    // <img src="http://"> cached before the http→https upgrade
    /<img[^>]+src=["']http:\/\//i.test(message.body_html) ||
    // background="http://" on table/td/tr elements (marketing email table layouts)
    /background=["']http:\/\//i.test(message.body_html) ||
    // CSS url(http://) in inline style attributes or <style> blocks
    /url\(\s*['"]?http:\/\//i.test(message.body_html)
  );
  if ((message.body_html || message.body_text) && !hasCidRefs && !hasHttpImgs) {
    const attachments = message.attachments
      ? (typeof message.attachments === 'string' ? JSON.parse(message.attachments) : message.attachments)
      : [];
    // Apply head-stripping to already-cached HTML so emails stored before this
    // fix was deployed are cleaned up immediately on first view.
    let html = message.body_html ? stripEmailHead(message.body_html) : null;
    if (html !== message.body_html) {
      // Update cache so subsequent views don't need to re-strip
      query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
    }
    // Rewrite eBay imageser URLs to direct image URLs for emails cached before this fix.
    // imageser requires eBay session cookies (never sent cross-site) and returns 1 byte
    // without them; the real image is always in the `imageUrl` query parameter.
    if (html && html.includes('svcs.ebay.com/imageser')) {
      const rewritten = rewriteEbayImageserUrls(html);
      if (rewritten !== html) {
        html = rewritten;
        query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
      }
    }
    // Normalise bare-domain hrefs (e.g. href="benchmade.com") cached before href
    // normalisation was added to sanitizeEmail().  Without this, clicking such links
    // in the sandboxed iframe resolves them against the mailflow origin and opens a
    // new mailflow tab instead of the sender's website.
    if (html && /<a\b[^>]*\shref=["'](?!https?:\/\/|mailto:|cid:|tel:|\/\/|[#/.])/i.test(html)) {
      const rewritten = rewriteAnchorHrefs(html);
      if (rewritten !== html) {
        html = rewritten;
        query('UPDATE messages SET body_html = $1 WHERE id = $2', [sanitizeDbText(html), id]).catch(() => {});
      }
    }
    // Backfill snippet when absent, or regenerate if garbled (undecoded HTML entities
    // from before the entity-stripping fix — e.g. "&zwnj;" in preview text).
    if (!message.snippet || snippetIsGarbled(message.snippet)) {
      const snip = snippetFromBody(message.body_text, html);
      if (snip) {
        query('UPDATE messages SET snippet = $1 WHERE id = $2', [sanitizeDbText(snip), id]).catch(() => {});
      }
    }

    // Apply remote-image blocking at response time — never write the blocked variant
    // back to the DB so the canonical cached HTML always has images intact.
    const skipBlocking = req.query.remoteImages === '1';
    let responseHtml = html;
    let hasBlockedRemoteImages = false;
    if (!skipBlocking && html && shouldBlockImages(message.preferences, message) && hasRemoteImages(html)) {
      responseHtml = blockRemoteImages(html);
      hasBlockedRemoteImages = true;
    }
    return res.json({ html: responseHtml, text: message.body_text, attachments, hasBlockedRemoteImages, senderEmail: message.sender_email, senderName: message.sender_name });
  }

  // Fetch from IMAP — signal user activity so background jobs back off during this request.
  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];
    imapManager.noteUserActivity(account.id);

    const { html, text, attachments } = await fetchWithTimeout(
      imapManager.fetchMessageBody(account, message.uid, message.folder, { snapshot: messageSnapshot }),
      BODY_FETCH_TIMEOUT_MS
    );

    const safeHtml = html ? sanitizeDbText(sanitizeEmail(html)) : null;
    const safeText = sanitizeDbText(text);
    const snip = sanitizeDbText(snippetFromBody(safeText, safeHtml || html));

    // Only cache when we actually got body content — don't overwrite a prior
    // successful cache with null if a transient IMAP fetch returns nothing.
    if (safeHtml || text || (attachments && attachments.length > 0)) {
      const cached = await query(
        `UPDATE messages
         SET body_html = $1, body_text = $2, attachments = $3,
             snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
         WHERE id = $4 AND account_id = $6 AND uid = $7 AND folder = $8
           AND is_deleted = false AND metadata_complete = true
           AND EXISTS (
             SELECT 1 FROM folders f
              WHERE f.account_id = messages.account_id AND f.path = messages.folder
                AND f.is_present = true AND f.uid_validity = $9
                AND f.observation_generation = $10
           )
         RETURNING id`,
        [
          safeHtml, safeText, JSON.stringify(attachments || []), id, snip,
          messageSnapshot.accountId, messageSnapshot.uid, messageSnapshot.folder,
          messageSnapshot.uidValidity, messageSnapshot.folderGeneration,
        ]
      );
      if (cached.rowCount === 0) {
        throw new MessageSnapshotError('Message relocated before body publication');
      }
    }

    await revalidateLiveMessageSnapshots(message.account_id, [messageSnapshot]);

    // Apply remote-image blocking at response time — safeHtml (unblocked) is what
    // was written to the DB cache above, preserving the canonical body.
    const skipBlocking = req.query.remoteImages === '1';
    let responseHtml = safeHtml;
    let hasBlockedRemoteImages = false;
    if (!skipBlocking && safeHtml && shouldBlockImages(message.preferences, message) && hasRemoteImages(safeHtml)) {
      responseHtml = blockRemoteImages(safeHtml);
      hasBlockedRemoteImages = true;
    }
    res.json({ html: responseHtml, text: safeText, attachments: attachments || [], hasBlockedRemoteImages, senderEmail: message.sender_email, senderName: message.sender_name });
  } catch (err) {
    const msg = err.message || 'Unknown error';
    console.error('Body fetch error:', msg);
    // Detect Gmail/IMAP throttling and surface a helpful message
    const isThrottle = /THROTTL/i.test(msg);
    if (isThrottle) {
      return res.status(503).json({
        error: 'The mail server is temporarily throttling access. Please wait a few minutes and try again.',
        throttled: true,
      });
    }
    if (msg === 'BODY_FETCH_TIMEOUT') {
      return res.status(504).json({
        error: 'This message is taking too long to load — the mail server may be temporarily unreachable. Please try again.',
        timeout: true,
      });
    }
    if (err?.code === 'MESSAGE_SNAPSHOT_SUPERSEDED') {
      return res.status(409).json({ error: msg, code: err.code, retryable: true });
    }
    res.status(500).json({ error: msg });
  }
});

// Get full raw headers
router.get('/messages/:id/headers', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.*, a.user_id,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];
  const messageSnapshot = snapshotFromMessageRow(message);

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];

    let headers = '';
    try {
      headers = await imapManager.fetchHeaders(
        account, message.uid, message.folder, { snapshot: messageSnapshot },
      );
    } catch (fetchErr) {
      if (fetchErr?.code === 'MESSAGE_SNAPSHOT_SUPERSEDED') throw fetchErr;
      console.warn('Headers IMAP fetch failed:', fetchErr.message);
    }

    if (!headers?.trim()) {
      headers = buildHeadersFromMessage(message);
    }

    await revalidateLiveMessageSnapshots(message.account_id, [messageSnapshot]);

    let resolvedSubject = message.subject;
    if (headers?.trim()) {
      const parsed = parseRawHeaders(headers);
      const imapSubject = decodeMimeWords(parsed.subject || '').trim();
      if (imapSubject && imapSubject !== '(no subject)') {
        resolvedSubject = imapSubject;
        if (!message.subject || message.subject === '(no subject)') {
          await query('UPDATE messages SET subject = $1 WHERE id = $2', [imapSubject, id]);
        }
      }
    }

    res.json({ headers, subject: resolvedSubject });
  } catch (err) {
    console.error('Headers fetch error:', err);
    if (err?.code === 'MESSAGE_SNAPSHOT_SUPERSEDED') {
      return res.status(409).json({ error: err.message, code: err.code, retryable: true });
    }
    res.status(500).json({ error: 'Failed to fetch message headers' });
  }
});

const ZIP_MAX_FILES = 100;
const ZIP_MAX_TOTAL_BYTES = 150 * 1024 * 1024; // 150 MB
const ZIP_MAX_FILE_BYTES  =  50 * 1024 * 1024; //  50 MB per file

// Download all attachments as a ZIP archive
router.get('/messages/:id/attachments.zip', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.*, a.user_id,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];
  const messageSnapshot = snapshotFromMessageRow(message);

  const attachments = typeof message.attachments === 'string'
    ? JSON.parse(message.attachments || '[]')
    : (message.attachments || []);

  if (attachments.length === 0) return res.status(404).json({ error: 'No attachments' });
  if (attachments.length > ZIP_MAX_FILES) return res.status(400).json({ error: `Too many attachments (max ${ZIP_MAX_FILES})` });

  const knownTotal = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
  if (knownTotal > ZIP_MAX_TOTAL_BYTES) {
    return res.status(413).json({ error: 'Total attachment size exceeds the 150 MB ZIP limit.' });
  }

  // Exclude per-file oversize items; unknown-size (0) are allowed through.
  const eligible = attachments.filter(a => !a.size || a.size <= ZIP_MAX_FILE_BYTES);
  if (eligible.length === 0) return res.status(413).json({ error: 'All attachments exceed the 50 MB per-file limit.' });

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    const account = accountResult.rows[0];

    const bufferMap = await imapManager.fetchMultipleAttachments(
      account, message.uid, message.folder, eligible, { snapshot: messageSnapshot },
    );
    if (bufferMap.size === 0) return res.status(404).json({ error: 'Could not fetch attachments' });

    // Deduplicate filenames: invoice.pdf → invoice (2).pdf
    const usedNames = new Map();
    const entries = [];
    for (const att of eligible) {
      const buf = bufferMap.get(att.part);
      if (!buf) continue;
      let name = safeFilename(att.filename);
      if (usedNames.has(name)) {
        const n = usedNames.get(name) + 1;
        usedNames.set(name, n);
        const dot = name.lastIndexOf('.');
        name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      } else {
        usedNames.set(name, 1);
      }
      entries.push({ name, buf });
    }

    if (entries.length === 0) return res.status(404).json({ error: 'Could not fetch attachments' });

    await revalidateLiveMessageSnapshots(message.account_id, [messageSnapshot]);

    const zipName = (message.subject || 'attachments').substring(0, 100) + '-attachments.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(zipName));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => {
      console.error('ZIP archive error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to create ZIP' });
    });
    archive.pipe(res);
    for (const { name, buf } of entries) {
      archive.append(buf, { name });
    }
    archive.finalize();
  } catch (err) {
    console.error('ZIP fetch error:', err);
    if (!res.headersSent && err?.code === 'MESSAGE_SNAPSHOT_SUPERSEDED') {
      return res.status(409).json({ error: err.message, code: err.code, retryable: true });
    }
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create ZIP' });
  }
});

// Download attachment
router.get('/messages/:id/attachments/:part', async (req, res) => {
  const { id, part } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  let partNum;
  try {
    partNum = decodeURIComponent(part);
  } catch {
    return res.status(400).json({ error: 'Invalid attachment part identifier' });
  }

  const result = await query(`
    SELECT m.*, a.user_id,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];
  const messageSnapshot = snapshotFromMessageRow(message);

  // Find attachment metadata
  const attachments = typeof message.attachments === 'string'
    ? JSON.parse(message.attachments || '[]')
    : (message.attachments || []);
  const att = attachments.find(a => a.part === partNum);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });

  // Reject oversized attachments before opening an IMAP connection.
  // att.size comes from the IMAP BODYSTRUCTURE response and is generally accurate.
  // A size of 0 means unknown — allow the fetch to proceed in that case.
  const ATTACHMENT_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
  if (att.size > ATTACHMENT_SIZE_LIMIT) {
    return res.status(413).json({ error: 'Attachment exceeds the 50 MB download limit.' });
  }

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });
    const buffer = await imapManager.fetchAttachment(
      accountResult.rows[0], message.uid, message.folder, partNum,
      { snapshot: messageSnapshot },
    );

    if (!buffer) return res.status(404).json({ error: 'Could not fetch attachment' });

    await revalidateLiveMessageSnapshots(message.account_id, [messageSnapshot]);

    res.setHeader('Content-Type', att.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', attachmentDisposition(att.filename));
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Attachment fetch error:', err);
    if (err?.code === 'MESSAGE_SNAPSHOT_SUPERSEDED') {
      return res.status(409).json({ error: err.message, code: err.code, retryable: true });
    }
    res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

// Mark read/unread
router.patch('/messages/:id/read', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { read } = req.body;

  const result = await query(`
    SELECT m.*, a.user_id,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];
  const messageSnapshot = snapshotFromMessageRow(message);

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];
  try {
    await imapManager.setDesiredFlag(
      account, id, '\\Seen', read, { snapshot: messageSnapshot },
    );
  } catch (err) {
    if (!err?.uncertain) throw err;
    console.error('IMAP desired read delivery remains uncertain:', err.message);
  }

  if (!!message.is_read !== !!read) {
    // Notify the user's OTHER sessions so a read/unread on one device reflects on the rest
    // in place, without a full folder refetch (the originating device already applied it).
    imapManager.broadcast({ type: 'message_flags', accountId: message.account_id, changes: [{ id, is_read: read }] }, req.session.userId);
  }

  // A label-aware account owns one provider row per folder. Resolve every live sibling,
  // then accept an independent exact-row desired delivery so counts, revisions, and retries
  // remain ordered even on providers that do not propagate Seen between copies.
  if (Number(message.sibling_count) > 1 && await accountMaintainsLabelSiblings(message.account_id)) {
    await deliverDesiredFlagToLiveSiblings(account, message, '\\Seen', read);
  }

  // Refresh GTD section data if this message's thread carries a GTD label (its head shows read state).
  notifyMailMutation([message], req.session.userId);

  res.json({ ok: true, is_read: read });
});

// Star/unstar
router.patch('/messages/:id/star', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { starred } = req.body;

  const result = await query(`
    SELECT m.*, a.user_id,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];
  const messageSnapshot = snapshotFromMessageRow(message);

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];
  try {
    await imapManager.setDesiredFlag(
      account, id, '\\Flagged', starred, { snapshot: messageSnapshot },
    );
  } catch (err) {
    if (!err?.uncertain) throw err;
    console.error('IMAP desired star delivery remains uncertain:', err.message);
  }

  // Stars use the same independent exact-row sibling delivery as reads; the desired-flag
  // repository intentionally performs no folder-count adjustment for Flagged changes.
  if (Number(message.sibling_count) > 1 && await accountMaintainsLabelSiblings(message.account_id)) {
    await deliverDesiredFlagToLiveSiblings(account, message, '\\Flagged', starred);
  }

  // Refresh GTD section data if this message's thread carries a GTD label (its head shows star state).
  notifyMailMutation([message], req.session.userId);
  // Reflect the star change on the user's other sessions in place (no full refetch).
  if (!!message.is_starred !== !!starred) {
    imapManager.broadcast({ type: 'message_flags', accountId: message.account_id, changes: [{ id, is_starred: starred }] }, req.session.userId);
  }

  res.json({ ok: true, is_starred: starred });
});

// Manual sync (INBOX)
router.post('/sync', async (req, res) => {
  const { accountId } = req.body; // optional — omit for all accounts
  if (accountId) {
    if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
    const check = await query(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [accountId, req.session.userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  }
  // Run sync in background so response returns immediately
  imapManager.syncNow(req.session.userId, accountId || null)
    .catch(err => console.error('syncNow error:', err.message));
  res.json({ ok: true });
});

// Manual folder-structure resync ("Sync folders now" in the sidebar account menu
// and on the accounts settings page). Refreshes the folder LIST so folders
// created or renamed in other clients appear without waiting for a reconnect.
router.post('/sync-folders', async (req, res) => {
  const { accountId } = req.body; // optional — omit for all accounts
  if (accountId) {
    if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
    const check = await query(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
      [accountId, req.session.userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  }
  // Run in background so the response returns immediately; the folders_synced
  // broadcast tells clients when to refetch the folder list.
  imapManager.syncFoldersNow(req.session.userId, accountId || null)
    .catch(err => console.error('syncFoldersNow error:', err.message));
  res.json({ ok: true });
});

// On-demand folder sync — called when the user navigates to a folder with no local messages
router.post('/sync-folder', async (req, res) => {
  const { accountId, folder } = req.body;
  if (!accountId || !folder) return res.status(400).json({ error: 'accountId and folder required' });
  if (!UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });

  const check = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  // Fire-and-forget — response returns immediately, WebSocket sync_complete notifies frontend
  imapManager.syncFolderOnDemand(check.rows[0], folder)
    .catch(err => console.error('syncFolderOnDemand error:', err.message));

  res.json({ ok: true });
});

// Mark all read (DB + IMAP)
router.post('/mark-all-read', async (req, res) => {
  const { accountId, folder = 'INBOX' } = req.body;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'Invalid account id' });
  if (!isValidFolderName(folder)) return res.status(400).json({ error: 'Invalid folder name' });
  const check = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  const unread = await query(
    `SELECT m.id, m.account_id, m.uid, m.folder, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         AND f.is_present = true AND f.uid_validity IS NOT NULL
      WHERE m.account_id = $1 AND m.folder = $2 AND m.is_read = false
        AND m.is_deleted = false AND m.metadata_complete = true
      ORDER BY m.id`,
    [accountId, folder],
  );
  try {
    for (const row of unread.rows) {
      const outcome = await imapManager.setDesiredFlag(
        check.rows[0], row.id, 'read', true, { snapshot: snapshotFromMessageRow(row) },
      );
      if (outcome?.delivery?.state !== 'confirmed') {
        throw new Error(`Read delivery for ${row.id} was not confirmed`);
      }
    }
  } catch (err) {
    console.error('mark-all-read exact delivery failed:', err.message);
    return res.status(503).json({ error: 'Failed to mark all messages read' });
  }
  imapManager.broadcast({ type: 'sync_complete', accountId }, check.rows[0].user_id);
  res.json({ ok: true });
});

// Create folder
router.post('/folders', async (req, res) => {
  const { accountId, name, parentPath } = req.body;
  if (!accountId || !name?.trim()) return res.status(400).json({ error: 'accountId and name required' });
  if (!isValidFolderName(name.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (parentPath && !isValidFolderName(parentPath)) return res.status(400).json({ error: 'Invalid parent path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  // Build path: if parentPath given, look up the delimiter used by this account's folders
  let path = name.trim();
  if (parentPath) {
    const delimResult = await query('SELECT delimiter FROM folders WHERE account_id = $1 LIMIT 1', [accountId]);
    const delim = delimResult.rows[0]?.delimiter || '/';
    path = `${parentPath}${delim}${name.trim()}`;
  }

  try {
    const created = await imapManager.createFolder(check.rows[0], path);
    res.json({ ok: true, path: created?.path || path });
  } catch (err) {
    console.error('Create folder error:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// Delete folder
router.post('/folders/delete', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    await imapManager.deleteFolder(check.rows[0], path);
  } catch (err) {
    console.error(`IMAP deleteFolder failed for ${path}:`, err.message);
    return res.status(500).json({ error: 'Failed to delete folder on server' });
  }
  res.json({ ok: true });
});

// Rename folder
router.post('/folders/rename', async (req, res) => {
  const { accountId, oldPath, newName } = req.body;
  if (!accountId || !oldPath || !newName?.trim()) return res.status(400).json({ error: 'Missing required fields' });
  if (!isValidFolderName(newName.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (!isValidFolderName(oldPath)) return res.status(400).json({ error: 'Invalid folder path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  // Build the new path by replacing only the last path component
  const delimResult = await query('SELECT delimiter FROM folders WHERE account_id = $1 AND path = $2', [accountId, oldPath]);
  const delim = delimResult.rows[0]?.delimiter || '/';
  const parts = oldPath.split(delim);
  parts[parts.length - 1] = newName.trim();
  const newPath = parts.join(delim);

  try {
    await imapManager.renameFolder(check.rows[0], oldPath, newPath);
    res.json({ ok: true, newPath });
  } catch (err) {
    console.error('Rename folder error:', err);
    res.status(500).json({ error: 'Failed to rename folder' });
  }
});

// Guards against two overlapping empties of the same (account, folder) — a double-click or a
// second device would otherwise start two background deletes over the same folder.
const emptyInFlight = new Set();

// Empty folder (delete all messages). Emptying a large folder is a slow IMAP operation (chunked
// delete + expunge over the provider), so it runs in the BACKGROUND: the request returns 202
// immediately and the outcome is reported over WebSocket (folder_emptied). This keeps the UI from
// hanging on big folders. On failure the DB rows are left in place so the next sync reconciles.
router.post('/folders/empty', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  const account = check.rows[0];
  const folderState = await query(
    `SELECT backfill_incomplete
       FROM folders WHERE account_id = $1 AND path = $2
        AND is_present = true AND uid_validity IS NOT NULL`,
    [accountId, path],
  );
  if (!folderState.rows.length || folderState.rows[0].backfill_incomplete) {
    return res.status(409).json({ error: 'Folder sync is incomplete — try again after sync finishes' });
  }
  const candidates = await query(
    `SELECT m.id, m.account_id, m.uid, m.folder, m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         AND f.is_present = true AND f.uid_validity IS NOT NULL
      WHERE m.account_id = $1 AND m.folder = $2
        AND m.is_deleted = false AND m.metadata_complete = true
      ORDER BY m.id`,
    [accountId, path],
  );

  const inflightKey = `${accountId}:${path}`;
  if (emptyInFlight.has(inflightKey)) return res.status(409).json({ error: 'This folder is already being emptied' });
  emptyInFlight.add(inflightKey);

  res.status(202).json({ ok: true, started: true });

  (async () => {
    try {
      for (const row of candidates.rows) {
        await imapManager.removeMessageCopy(accountId, row.uid, path, {
          expectedId: row.id,
          expectedUidValidity: row.folder_uid_validity,
          snapshot: snapshotFromMessageRow(row),
          notify: false,
        });
      }
      imapManager.broadcast({ type: 'folder_emptied', accountId, folder: path, ok: true }, account.user_id);
      imapManager.broadcast({ type: 'sync_complete', accountId }, account.user_id);
    } catch (err) {
      console.error(`Async emptyFolder failed for ${path}:`, err.message);
      imapManager.broadcast({ type: 'folder_emptied', accountId, folder: path, ok: false }, account.user_id);
    } finally {
      emptyInFlight.delete(inflightKey);
    }
  })();
});

// Bulk mark read/unread
router.post('/messages/bulk-read', async (req, res) => {
  const { ids, read } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message IDs' });
  }
  if (typeof read !== 'boolean') {
    return res.status(400).json({ error: 'read must be a boolean' });
  }

  try {
    const result = await query(
      `SELECT m.id, m.uid, m.folder, m.is_read, m.account_id, m.message_id,
              m.read_revision, m.star_revision,
              live_folder.uid_validity AS folder_uid_validity,
              live_folder.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       JOIN folders live_folder ON live_folder.account_id = m.account_id
         AND live_folder.path = m.folder AND live_folder.is_present = true
         AND live_folder.uid_validity IS NOT NULL
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1
         AND m.is_deleted = false AND m.metadata_complete = true`,
      [req.session.userId, ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, updated: [] });

    // Skip messages whose state already matches — avoid spurious DB writes and IMAP round-trips.
    const toUpdate = owned.filter(m => !!m.is_read !== !!read);
    if (!toUpdate.length) return res.json({ ok: true, updated: [] });

    const acctIds = [...new Set(toUpdate.map(m => m.account_id))];
    const gtdAccts = new Set();
    await Promise.all(acctIds.map(async (aid) => {
      if (await accountMaintainsLabelSiblings(aid)) gtdAccts.add(aid);
    }));
    const byAccount = {};
    for (const msg of toUpdate) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }
    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const results = await runInBatches(
        msgs, 3,
        msg => imapManager.setDesiredFlag(
          account, msg.id, '\\Seen', read,
          { snapshot: snapshotFromMessageRow(msg) },
        )
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          if (!r.reason?.uncertain) throw r.reason;
          console.error(`bulk-read desired delivery ${msgs[i].id}:`, r.reason.message);
        }
      });
    }

    // Label siblings are independent provider rows. Resolve them descriptively by Message-ID,
    // then immediately convert each match into an exact row/UID/epoch desired delivery.
    const gtdRows = toUpdate.filter(m => gtdAccts.has(m.account_id) && m.message_id);
    if (gtdRows.length > 0) {
      const siblings = await query(
        `WITH acted AS (
           SELECT DISTINCT account_id, message_id
             FROM messages
            WHERE id = ANY($1::uuid[]) AND message_id IS NOT NULL
         )
         SELECT m.id, m.account_id, m.uid, m.folder, m.is_read,
                m.read_revision, m.star_revision,
                f.uid_validity AS folder_uid_validity,
                f.observation_generation AS folder_observation_generation
           FROM messages m
           JOIN acted ON acted.account_id = m.account_id AND acted.message_id = m.message_id
           JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                         AND f.is_present = true AND f.uid_validity IS NOT NULL
          WHERE m.id <> ALL($1::uuid[])
            AND m.is_deleted = false AND m.metadata_complete = true`,
        [gtdRows.map(row => row.id)],
      );
      for (const sibling of siblings.rows) {
        const account = (await query(
          'SELECT * FROM email_accounts WHERE id = $1', [sibling.account_id],
        )).rows[0];
        try {
          await imapManager.setDesiredFlag(
            account, sibling.id, '\\Seen', read,
            { snapshot: snapshotFromMessageRow(sibling) },
          );
        } catch (err) {
          if (!err?.uncertain) throw err;
        }
      }
    }

    // Reflect the bulk read/unread change on the user's other sessions in place (no full refetch).
    imapManager.broadcast({ type: 'message_flags', changes: toUpdate.map(m => ({ id: m.id, is_read: read })) }, req.session.userId);

    // Refresh GTD section data for any updated thread that carries a GTD label.
    notifyMailMutation(toUpdate, req.session.userId);

    res.json({ ok: true, updated: toUpdate.map(m => m.id) });
  } catch (err) {
    console.error('bulk-read error:', err);
    res.status(500).json({ error: 'Failed to update messages' });
  }
});

// Bulk delete (move to trash)
router.post('/messages/bulk-delete', async (req, res) => {
  const { ids, operationKeys } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message id format' });
  }
  const rowOperationKeys = validatedRowOperationKeys(ids, operationKeys, {
    userId: req.session.userId, kind: 'bulk-delete',
  });
  if (!rowOperationKeys) return res.status(400).json({ error: 'One valid operation key per id is required' });
  const canonicalIds = ids.map(id => id.toLowerCase());

  const moveGuards = [];
  try {
    const result = await query(
      `SELECT m.*, a.user_id, a.folder_mappings,
              live_folder.uid_validity AS folder_uid_validity,
              live_folder.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       JOIN folders live_folder ON live_folder.account_id = m.account_id
         AND live_folder.path = m.folder AND live_folder.is_present = true
         AND live_folder.uid_validity IS NOT NULL
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1
         AND m.is_deleted = false AND m.metadata_complete = true`,
      [req.session.userId, canonicalIds]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, deleted: [] });

    const completedMoveResult = await query(
      `WITH requested(source_message_id, request_key) AS (
         SELECT * FROM unnest($1::uuid[], $2::text[])
       )
       SELECT po.account_id, po.source_message_id, po.request_key,
              po.destination_folder, po.receipt
         FROM provider_operations po
         JOIN requested r
           ON r.source_message_id = po.source_message_id
          AND r.request_key = po.request_key
        WHERE po.kind = 'move' AND po.state = 'completed'`,
      [owned.map(msg => msg.id), owned.map(msg => rowOperationKeys.get(msg.id))],
    );
    const completedMoves = new Map((completedMoveResult.rows || []).map(operation => [
      `${operation.account_id}:${operation.source_message_id}:${operation.request_key}`,
      operation,
    ]));

    // Guard source UIDs for the whole operation so reconcileDeletes can't delete a
    // trash-move source row between the IMAP move and the re-INSERT CTE (message vanishing
    // from both folders). Harmless for the expunge path (those rows are deleted anyway).
    // Released in the finally below.
    for (const m of owned) {
      moveGuards.push({ accountId: m.account_id, folder: m.folder, uid: m.uid });
      imapManager._guardMoveUid(m.account_id, m.folder, m.uid);
    }

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    // expungeSucceeded: permanently deleted (already in Trash, or no Trash folder on account).
    // trashMoveSucceeded: moved from a non-Trash folder into Trash.
    const expungeSucceeded = [];
    const trashMoveSucceeded = []; // { msg, trashPath, newUid }
    const replaySucceeded = [];
    const accountsById = {};

    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      accountsById[accountId] = account;
      const trashPath = await resolveTrashFolder(accountId, msgs[0].folder_mappings);
      const allTrashPaths = await resolveAllTrashPaths(accountId, msgs[0].folder_mappings);
      const allDraftsPaths = await resolveAllDraftsPaths(accountId, msgs[0].folder_mappings);

      if (!trashPath) {
        console.error(`bulk-delete: no Trash folder found for account ${accountId} — skipping ${msgs.length} messages`);
        continue;
      }

      // A retry can load the row after its first attempt already moved it into Trash. A completed
      // durable MOVE is terminal for this exact logical row/request key: replay success only when
      // the current row is the receipt destination, and otherwise fail closed instead of treating
      // the relocated row as a fresh expunge request.
      const actionable = msgs.filter(msg => {
        const requestKey = rowOperationKeys.get(msg.id);
        const completed = completedMoves.get(`${accountId}:${msg.id}:${requestKey}`);
        if (!completed) return true;
        const receipt = completed.receipt || {};
        const exactDestination = completed.destination_folder === trashPath &&
          receipt.folder === trashPath && msg.folder === receipt.folder &&
          Number(msg.uid) === Number(receipt.uid) &&
          receipt.uidValidity != null &&
          String(msg.folder_uid_validity) === String(receipt.uidValidity);
        if (exactDestination) replaySucceeded.push(msg);
        else console.error(`bulk-delete: completed MOVE identity no longer matches row ${msg.id}`);
        return false;
      });

      // Drafts and messages already in Trash are permanently deleted; others move to Trash.
      const toExpunge = actionable.filter(m => allTrashPaths.has(m.folder) || allDraftsPaths.has(m.folder));
      const toMove    = actionable.filter(m => !allTrashPaths.has(m.folder) && !allDraftsPaths.has(m.folder));

      // Permanently delete messages already in a trash-like folder (grouped by actual folder).
      if (toExpunge.length) {
        const byExpungeFolder = {};
        for (const msg of toExpunge) {
          (byExpungeFolder[msg.folder] = byExpungeFolder[msg.folder] || []).push(msg);
        }
        for (const [expungeFolder, folderMsgs] of Object.entries(byExpungeFolder)) {
          for (const msg of folderMsgs) {
            try {
              await imapManager.removeMessageCopy(accountId, msg.uid, expungeFolder, {
                expectedId: msg.id,
                expectedUidValidity: msg.folder_uid_validity,
                snapshot: snapshotFromMessageRow(msg),
              });
              expungeSucceeded.push(msg);
            } catch (err) {
              console.error(`bulk-delete IMAP expunge uid ${msg.uid} from ${expungeFolder}: ${err.message}`);
            }
          }
        }
      }

      // Move messages from non-Trash folders into Trash.
      if (toMove.length) {
        const byFolder = {};
        for (const msg of toMove) {
          (byFolder[msg.folder] = byFolder[msg.folder] || []).push(msg);
        }
        for (const [srcFolder, folderMsgs] of Object.entries(byFolder)) {
          const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
          const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(
            account, folderMsgs.map(m => m.uid), srcFolder, trashPath,
            {
              operationKey: 'bulk-delete',
              operationKeys: new Map(folderMsgs.map(m => [
                Number(m.uid), rowOperationKeys.get(m.id),
              ])),
              sourceSnapshots: new Map(folderMsgs.map(m => [
                Number(m.uid), snapshotFromMessageRow(m),
              ])),
              sourceRows: new Map(folderMsgs.map(m => [Number(m.uid), m])),
              materialize: materializeOrdinaryMove(trashPath),
            },
          );
          for (const uid of succeeded) {
            trashMoveSucceeded.push({ msg: uidToMsg.get(String(uid)), trashPath, newUid: uidMap.get(Number(uid)) || null });
          }
          for (const uid of failed) console.error(`bulk-delete IMAP move uid ${uid}: IMAP move failed`);
        }
      }
    }

    // Exact deletion/relocation and count changes commit inside their provider fence.
    const allSucceeded = [
      ...expungeSucceeded.map(m => m.id),
      ...trashMoveSucceeded.map(u => u.msg.id),
      ...replaySucceeded.map(m => m.id),
    ];
    if (allSucceeded.length) {
      const dstDeltas = {};
      for (const { msg, trashPath } of trashMoveSucceeded) {
        const key = `${msg.account_id}:${trashPath}`;
        if (!dstDeltas[key]) dstDeltas[key] = { accountId: msg.account_id, path: trashPath, total: 0, unread: 0 };
        dstDeltas[key].total++;
      }
      // Notify clients viewing each Trash folder to refresh silently.
      for (const { accountId, path } of Object.values(dstDeltas)) {
        imapManager.broadcast({ type: 'folder_updated', folder: path, accountId }, req.session.userId);
      }
    }

    // Refresh GTD section data for any deleted thread that still carries a GTD label sibling.
    notifyMailMutation(owned, req.session.userId);

    res.json({ ok: true, deleted: allSucceeded });
  } catch (err) {
    console.error('bulk-delete error:', err);
    res.status(500).json({ error: 'Failed to delete messages' });
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
});

// ── Mailbox cleanup (bloat analysis + per-sender preview) ──────────────────────
// Both routes are READ-ONLY and strictly scoped to the caller's own account. Nothing here
// deletes: the actual cleanup is performed by the client feeding the returned ids to the
// existing /messages/bulk-delete (move-to-Trash) endpoint in <=500 batches.

// Analyze an INBOX for "bloat": how much is bulk mail, the top bulk senders (Tier 1 cleanup
// targets, exact from_email addresses), and promo-keyword buckets (Tier 2 guidance).
router.get('/mailbox-usage', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'valid accountId required' });
  const acct = await query('SELECT id, folder_mappings FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });
  // Whether Archive is a usable cleanup action for this account (#403): the client
  // offers Archive vs Trash and needs to know if an archive folder can be resolved.
  const archiveFolder = await resolveArchiveFolder(accountId, acct.rows[0].folder_mappings);

  const summary = await query(
    `SELECT count(*)::int AS inbox_total, count(*) FILTER (WHERE is_bulk)::int AS bulk_total
     FROM messages WHERE account_id = $1 AND folder = 'INBOX'
       AND is_deleted = false AND metadata_complete = true`,
    [accountId]
  );
  // Group senders case-insensitively so a sender that uses mixed-case addresses
  // (Promo@x vs promo@x) is one row whose count matches the delete — cleanup-preview
  // matches lower(from_email), so a case-sensitive count here would understate what
  // clicking the row actually trashes. min(from_email) is a real observed casing for
  // display; the delete lower-matches it and so still captures every case variant.
  const senders = await query(
    `SELECT min(from_email) AS from_email, max(from_name) AS from_name, count(*)::int AS count
     FROM messages
     WHERE account_id = $1 AND folder = 'INBOX' AND is_bulk
       AND is_deleted = false AND metadata_complete = true
       AND from_email IS NOT NULL AND from_email <> ''
     GROUP BY lower(from_email) ORDER BY count DESC, lower(min(from_email)) LIMIT 25`,
    [accountId]
  );

  // Tier 2 promo keyword buckets (fixed set), counted over INBOX in one pass. Informational only.
  const KEYWORDS = ['% off', 'deal', 'sale', 'newsletter', 'coupon', 'webinar', 'last chance'];
  const filters = KEYWORDS
    .map((_, i) => `count(*) FILTER (WHERE subject ILIKE $${i + 2} OR coalesce(snippet,'') ILIKE $${i + 2})::int AS k${i}`)
    .join(', ');
  const kw = await query(
    `SELECT ${filters} FROM messages WHERE account_id = $1 AND folder = 'INBOX'
       AND is_deleted = false AND metadata_complete = true`,
    [accountId, ...KEYWORDS.map(k => `%${k}%`)]
  );

  res.json({
    accountId,
    inboxTotal: summary.rows[0].inbox_total,
    bulkTotal: summary.rows[0].bulk_total,
    archiveAvailable: Boolean(archiveFolder),
    tier1Senders: senders.rows.map(r => ({ fromEmail: r.from_email, fromName: r.from_name || '', count: r.count })),
    tier2Keywords: KEYWORDS.map((k, i) => ({ keyword: k, count: kw.rows[0][`k${i}`] })),
  });
});

// Return the INBOX message ids for ONE specific sender, so the client can move exactly those to
// Trash via /messages/bulk-delete. Read-only; strictly scoped to the caller's account, INBOX, and
// an EXACT (case-insensitive) from_email match — never a wildcard, never another folder. Scoped to
// is_bulk so it trashes exactly the bulk messages the sender list counted (mailbox-usage counts
// bulk-only): a non-bulk message from that sender (a receipt, a personal note) is never surprise-
// trashed. Idempotent: once those messages are trashed, a re-run returns an empty set.
router.get('/cleanup-preview', async (req, res) => {
  const { accountId, fromEmail } = req.query;
  if (!accountId || !UUID_RE.test(accountId)) return res.status(400).json({ error: 'valid accountId required' });
  if (!fromEmail || typeof fromEmail !== 'string' || !fromEmail.trim()) return res.status(400).json({ error: 'fromEmail required' });
  const acct = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });

  const rows = await query(
    `SELECT id FROM messages
     WHERE account_id = $1 AND folder = 'INBOX' AND is_bulk
       AND is_deleted = false AND metadata_complete = true AND lower(from_email) = lower($2)`,
    [accountId, fromEmail.trim()]
  );
  res.json({ accountId, fromEmail: fromEmail.trim(), count: rows.rows.length, ids: rows.rows.map(r => r.id) });
});

// Bulk move to folder
router.post('/messages/bulk-move', async (req, res) => {
  const { ids, folder, operationKeys } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || !folder) {
    return res.status(400).json({ error: 'ids array and folder required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!isValidFolderName(folder)) {
    return res.status(400).json({ error: 'Invalid destination folder' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message id format' });
  }
  const rowOperationKeys = validatedRowOperationKeys(ids, operationKeys, {
    userId: req.session.userId, kind: 'bulk-move', destination: folder,
  });
  if (!rowOperationKeys) return res.status(400).json({ error: 'One valid operation key per id is required' });
  const canonicalIds = ids.map(id => id.toLowerCase());

  const moveGuards = [];
  try {
    const result = await query(
      `SELECT m.*, a.user_id,
              live_folder.uid_validity AS folder_uid_validity,
              live_folder.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       JOIN folders live_folder ON live_folder.account_id = m.account_id
         AND live_folder.path = m.folder AND live_folder.is_present = true
         AND live_folder.uid_validity IS NOT NULL
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1
         AND m.is_deleted = false AND m.metadata_complete = true`,
      [req.session.userId, canonicalIds]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, moved: [] });

    // Guard every source (account, folder, uid) for the whole bulk move. bulkMoveMessages
    // removes the UIDs from the server (seconds of wall-clock), and a concurrent
    // reconcileDeletes tick would otherwise see the source rows as orphans and delete them
    // before the DELETE...RETURNING CTE re-inserts them at the destination — dropping the
    // message from BOTH folders. Unguarded in the finally once the CTE has committed.
    // Mirrors the single-message move paths.
    for (const m of owned) {
      moveGuards.push({ accountId: m.account_id, folder: m.folder, uid: m.uid });
      imapManager._guardMoveUid(m.account_id, m.folder, m.uid);
    }

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const movedIds = [];
    for (const [accountId, msgs] of Object.entries(byAccount)) {
      // Verify the destination folder exists for this account
      const folderCheck = await query(
        'SELECT 1 FROM folders WHERE account_id = $1 AND path = $2',
        [accountId, folder]
      );
      if (!folderCheck.rows.length) {
        console.warn(`bulk-move: folder "${folder}" not found for account ${accountId}, skipping`);
        continue;
      }
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const byFolder = {};
      for (const msg of msgs) {
        (byFolder[msg.folder] = byFolder[msg.folder] || []).push(msg);
      }
      for (const [srcFolder, folderMsgs] of Object.entries(byFolder)) {
        const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
        const { succeeded, failed } = await imapManager.bulkMoveMessages(
          account, folderMsgs.map(m => m.uid), srcFolder, folder,
          {
            operationKey: 'bulk-move',
            operationKeys: new Map(folderMsgs.map(m => [
              Number(m.uid), rowOperationKeys.get(m.id),
            ])),
            sourceSnapshots: new Map(folderMsgs.map(m => [
              Number(m.uid), snapshotFromMessageRow(m),
            ])),
            sourceRows: new Map(folderMsgs.map(m => [Number(m.uid), m])),
            materialize: materializeOrdinaryMove(folder),
          },
        );
        for (const uid of succeeded) {
          const msg = uidToMsg.get(String(uid));
          movedIds.push(msg.id);
        }
        for (const uid of failed) console.error(`bulk-move IMAP uid ${uid}: IMAP move failed`);
      }
    }

    if (movedIds.length > 0) {
      // Each exact relocation and its count changes committed inside the durable
      // provider-operation completion transaction. The route only broadcasts the receipt.
      const movedSet = new Set(movedIds);
      const srcTotals = {};
      for (const msg of owned) {
        if (!movedSet.has(msg.id)) continue;
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcTotals[key]) srcTotals[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcTotals[key].total++;
        if (!msg.is_read) srcTotals[key].unread++;
      }
      // Notify clients that the destination folder has new content so they
      // refresh without sounds or alerts (unlike new_messages).
      for (const accountId of Object.keys(srcTotals).map(k => k.split(':')[0])) {
        imapManager.broadcast({ type: 'folder_updated', folder, accountId }, req.session.userId);
      }
    }

    // Refresh GTD section data for any moved thread that still carries a GTD label sibling.
    notifyMailMutation(owned, req.session.userId);

    res.json({ ok: true, moved: movedIds });
  } catch (err) {
    console.error('bulk-move error:', err);
    res.status(500).json({ error: 'Failed to move messages' });
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
});

// Bulk archive — moves messages to the archive folder for each account
router.post('/messages/bulk-archive', async (req, res) => {
  const { ids, operationKeys } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message IDs' });
  }
  const rowOperationKeys = validatedRowOperationKeys(ids, operationKeys, {
    userId: req.session.userId, kind: 'bulk-archive',
  });
  if (!rowOperationKeys) return res.status(400).json({ error: 'One valid operation key per id is required' });
  const canonicalIds = ids.map(id => id.toLowerCase());

  const moveGuards = [];
  try {
    const result = await query(
      `SELECT m.*, a.user_id, a.folder_mappings,
              live_folder.uid_validity AS folder_uid_validity,
              live_folder.observation_generation AS folder_observation_generation
       FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       JOIN folders live_folder ON live_folder.account_id = m.account_id
         AND live_folder.path = m.folder AND live_folder.is_present = true
         AND live_folder.uid_validity IS NOT NULL
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1
         AND m.is_deleted = false AND m.metadata_complete = true`,
      [req.session.userId, canonicalIds]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, archived: [], noArchiveFolder: [] });

    // Guard source UIDs for the whole operation so reconcileDeletes can't delete a source
    // row between the IMAP move and the re-INSERT CTE (message vanishing from both folders).
    // Released in the finally below.
    for (const m of owned) {
      moveGuards.push({ accountId: m.account_id, folder: m.folder, uid: m.uid });
      imapManager._guardMoveUid(m.account_id, m.folder, m.uid);
    }

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const archivedIds = [];
    const noArchiveFolder = [];
    const accountsById = {};
    // Archive-folder paths that resolved to Gmail's All Mail (special_use '\All').
    // All Mail is excluded from sync/backfill and the relocate guard (imapManager.js),
    // so messages archived there get their DB row deleted below instead of re-homed.
    const allMailDestFolders = new Set();

    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const archiveFolder = await resolveArchiveFolder(accountId, msgs[0].folder_mappings);
      if (!archiveFolder) {
        noArchiveFolder.push(accountId);
        continue;
      }
      if (await isAllMailFolder(accountId, archiveFolder)) {
        allMailDestFolders.add(archiveFolder);
      }

      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      accountsById[accountId] = account;
      const byFolder = {};
      for (const msg of msgs) {
        (byFolder[msg.folder] = byFolder[msg.folder] || []).push(msg);
      }
      for (const [srcFolder, folderMsgs] of Object.entries(byFolder)) {
        const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
        const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(
          account, folderMsgs.map(m => m.uid), srcFolder, archiveFolder,
          {
            operationKey: 'bulk-archive',
            operationKeys: new Map(folderMsgs.map(m => [
              Number(m.uid), rowOperationKeys.get(m.id),
            ])),
            sourceSnapshots: new Map(folderMsgs.map(m => [
              Number(m.uid), snapshotFromMessageRow(m),
            ])),
            sourceRows: new Map(folderMsgs.map(m => [Number(m.uid), m])),
            materialize: materializeOrdinaryMove(
              archiveFolder, allMailDestFolders.has(archiveFolder),
            ),
          },
        );
        for (const uid of succeeded) {
          const msg = uidToMsg.get(String(uid));
          archivedIds.push({ id: msg.id, accountId, folder: archiveFolder, newUid: uidMap.get(Number(uid)) || null });
        }
        for (const uid of failed) console.error(`bulk-archive IMAP uid ${uid}: IMAP move failed`);
      }
    }

    // Exact row relocation and count changes are part of durable completion. Only notify.
    if (archivedIds.length > 0) {
      // Notify clients viewing each destination folder to refresh silently.
      const destFolders = [...new Set(archivedIds.map(a => a.folder))].filter(f => !allMailDestFolders.has(f));
      for (const dest of destFolders) {
        const accountIds = [...new Set(archivedIds.filter(a => a.folder === dest).map(a => {
          const msg = owned.find(m => m.id === a.id);
          return msg?.account_id;
        }).filter(Boolean))];
        for (const accountId of accountIds) {
          imapManager.broadcast({ type: 'folder_updated', folder: dest, accountId }, req.session.userId);
        }
      }
    }

    // Refresh GTD section data for any archived thread that still carries a GTD label sibling.
    notifyMailMutation(owned, req.session.userId);

    res.json({ ok: true, archived: archivedIds.map(a => a.id), noArchiveFolder });
  } catch (err) {
    console.error('bulk-archive error:', err);
    res.status(500).json({ error: 'Failed to archive messages' });
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
});

// Gather the reply-chain conversation that should be snoozed alongside `msg`.
//
// Snoozing a single message doesn't work on Gmail: Gmail groups the inbox by
// conversation, so moving one message to Snoozed only strips \Inbox from that
// message — its thread siblings keep \Inbox and the whole conversation stays in
// the inbox (#271). MailFlow's own inbox is thread-grouped too. So we snooze the
// entire conversation, but bounded to the RFC 5322 reply chain (Message-ID /
// In-Reply-To / References links) rather than thread_id: thread_id falls back to
// subject grouping and can lump hundreds of unrelated messages together (e.g.
// identical automated-notification emails), which must never be swept into Snoozed.
//
// Returns the messages in `msg`'s source folder reachable from `msg` through
// header links (always including `msg` itself); excludes already-snoozed messages.
export async function gatherSnoozeConversation(msg) {
  if (!msg.thread_id) return [msg];

  // Load the whole thread across ALL folders. thread_id is a superset of the true
  // conversation, and the messages that hold a real conversation together — the
  // other party's replies, your own Sent messages, the thread root — frequently
  // live in Sent / All Mail rather than the inbox. They must be present as graph
  // connectors or a genuine thread fragments and only part of it snoozes. The
  // reply-chain walk below filters out the subject-only collisions that thread_id
  // also collects (e.g. identical automated-notification emails).
  const pool = (await query(
    `SELECT m.id, m.uid, m.account_id, m.folder, m.message_id, m.in_reply_to,
            m.thread_references, m.is_read, m.is_deleted, m.metadata_complete,
            m.read_revision, m.star_revision,
            f.uid_validity AS folder_uid_validity,
            f.observation_generation AS folder_observation_generation
     FROM messages m
     LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
                        AND f.is_present = true AND f.uid_validity IS NOT NULL
     WHERE m.account_id = $1 AND m.thread_id = $2 AND m.message_id IS NOT NULL`,
    [msg.account_id, msg.thread_id]
  )).rows;

  // Ensure the triggering message is present (the query above could miss it on a
  // transient read skew).
  if (!pool.some(r => r.message_id === msg.message_id)) pool.push(msg);

  const refsOf = (r) => {
    const ids = (r.thread_references || '').match(/<[^>]+>/g) || [];
    if (r.in_reply_to) ids.push(r.in_reply_to);
    return ids;
  };

  // Undirected reply-chain graph over the whole thread; take the connected
  // component containing `msg`. Messages with no header link into that component
  // (subject-only collisions) are left out.
  const adj = new Map();
  const node = (m) => { let s = adj.get(m); if (!s) { s = new Set(); adj.set(m, s); } return s; };
  for (const r of pool) node(r.message_id);
  for (const r of pool) {
    for (const ref of refsOf(r)) {
      if (adj.has(ref)) { node(r.message_id).add(ref); node(ref).add(r.message_id); }
    }
  }
  const seen = new Set([msg.message_id]);
  const queue = [msg.message_id];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  }

  // Snooze only the conversation members in the acted-on message's source folder
  // (the inbox copies — Sent copies carry no \Inbox and shouldn't move), skipping
  // any already snoozed. Already-snoozed messages stay valid graph connectors above.
  const already = new Set(
    (await query(
      'SELECT message_id_header FROM snoozed_messages WHERE account_id = $1 AND message_id_header = ANY($2)',
      [msg.account_id, [...seen]]
    )).rows.map(r => r.message_id_header)
  );
  // Dedupe by Message-ID so a message that somehow has two rows in the source
  // folder isn't moved (and recorded) twice.
  const picked = new Map();
  for (const r of pool) {
    if (seen.has(r.message_id) && r.folder === msg.folder
        && r.is_deleted === false && r.metadata_complete === true
        && !already.has(r.message_id) && !picked.has(r.message_id)) {
      picked.set(r.message_id, r);
    }
  }
  // Return the acted-on message first so the caller can treat a failure moving it
  // as fatal before any sibling has been touched (no partial snooze on error).
  const rest = [...picked.values()].filter(r => r.message_id !== msg.message_id);
  // msg always qualifies (it's the acted-on, not-yet-snoozed message in its own
  // folder); fall back to it directly if the pool row for it was missed.
  const self = picked.get(msg.message_id) || msg;
  return [self, ...rest];
}

// Snooze a message: move it to a Snoozed IMAP folder and record when to restore it
router.post('/messages/:id/snooze', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const { until } = req.body;
  if (!until) return res.status(400).json({ error: 'until is required' });

  const untilDate = new Date(until);
  if (isNaN(untilDate.getTime())) return res.status(400).json({ error: 'until must be a valid ISO date' });
  if (untilDate <= new Date()) return res.status(400).json({ error: 'until must be in the future' });
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);
  if (untilDate > maxDate) return res.status(400).json({ error: 'until must be within 30 days' });

  // Ownership check
  const msgResult = await query(
    `SELECT m.*, a.user_id,
            live_folder.uid_validity AS folder_uid_validity,
            live_folder.observation_generation AS folder_observation_generation
     FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     JOIN folders live_folder ON live_folder.account_id = m.account_id
       AND live_folder.path = m.folder AND live_folder.is_present = true
       AND live_folder.uid_validity IS NOT NULL
     WHERE m.id = $1 AND a.user_id = $2
       AND m.is_deleted = false AND m.metadata_complete = true`,
    [id, req.session.userId]
  );
  if (!msgResult.rows.length) return res.status(404).json({ error: 'Message not found' });
  const msg = msgResult.rows[0];

  if (!msg.message_id) return res.status(400).json({ error: 'Message has no Message-ID header — cannot snooze' });

  const snoozedFolder = 'Snoozed';

  if (msg.folder === snoozedFolder) {
    return res.status(400).json({ error: 'Message is already in Snoozed folder' });
  }

  // Check if already snoozed
  const existing = await query(
    'SELECT id FROM snoozed_messages WHERE account_id = $1 AND message_id_header = $2',
    [msg.account_id, msg.message_id]
  );
  if (existing.rows.length) return res.status(400).json({ error: 'Message is already snoozed' });

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
  const account = accountResult.rows[0];

  // Snooze the whole reply-chain conversation, not just this message (see
  // gatherSnoozeConversation for why Gmail requires this and why it's bounded
  // to the header reply chain rather than thread_id).
  const convo = await gatherSnoozeConversation(msg);

  try {
    await imapManager.ensureFolder(account, snoozedFolder);
  } catch (err) {
    console.error(`Snooze ensureFolder failed for message ${id}:`, err.message);
    return res.status(500).json({ error: 'Failed to move message to Snoozed folder' });
  }

  for (const tm of convo) {
    if (tm.folder_uid_validity == null || tm.folder_observation_generation == null) {
      if (tm.id === msg.id) return res.status(409).json({ error: 'Message snapshot is no longer actionable' });
      continue;
    }
    imapManager._guardMoveUid(tm.account_id, tm.folder, tm.uid);
    try {
      try {
        await imapManager.moveMessage(account, tm.uid, tm.folder, snoozedFolder, {
          operationKey: `snooze:${tm.id}:${untilDate.toISOString()}`,
          expectedUidValidity: tm.folder_uid_validity,
          snapshot: snapshotFromMessageRow(tm),
          materialize: async (receipt, operation, tx) => {
            await materializeArchiveReceipt(tx, {
              accountId: tm.account_id,
              sourceSnapshot: tm,
              destinationFolder: snoozedFolder,
              receipt,
              operation,
            });
            const snoozeInsert = await tx.query(
              `INSERT INTO snoozed_messages (
                 user_id, account_id, message_row_id, message_id_header,
                 original_folder, snooze_until, snoozed_folder
               ) VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (account_id, message_id_header) DO NOTHING
               RETURNING id`,
              [req.session.userId, tm.account_id, tm.id, tm.message_id,
                tm.folder, untilDate.toISOString(), snoozedFolder],
            );
            if (snoozeInsert.rowCount !== 1) {
              const exact = await tx.query(
                `SELECT 1 FROM snoozed_messages
                  WHERE account_id = $1 AND message_id_header = $2
                    AND message_row_id = $3 AND original_folder = $4
                    AND snooze_until = $5::timestamptz AND snoozed_folder = $6
                    AND resolution_state = 'active'`,
                [tm.account_id, tm.message_id, tm.id, tm.folder,
                  untilDate.toISOString(), snoozedFolder],
              );
              if (exact.rows.length !== 1) {
                throw new Error('Conflicting snooze record prevented exact receipt materialization');
              }
            }
          },
        });
      } catch (err) {
        console.error(`Snooze IMAP move failed for message ${tm.id}:`, err.message);
        // The message the user acted on must succeed; a failed sibling is logged
        // and skipped so the rest of the conversation still snoozes.
        if (tm.id === msg.id) return res.status(500).json({ error: 'Failed to move message to Snoozed folder' });
        continue;
      }
    } finally {
      imapManager._unguardMoveUid(tm.account_id, tm.folder, tm.uid);
    }
  }

  // Refresh GTD section data if the snoozed conversation carries a GTD label (its in_inbox flips).
  notifyMailMutation(convo, req.session.userId);

  res.json({ ok: true });
});

// Delete (move to trash; drafts are permanently deleted)
router.delete('/messages/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.*, a.user_id,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];

  // Drafts bypass Trash and are permanently deleted (consistent with all major email clients).
  const allDraftsPaths = await resolveAllDraftsPaths(message.account_id, account.folder_mappings);
  if (allDraftsPaths.has(message.folder)) {
    try {
      await imapManager.removeMessageCopy(message.account_id, message.uid, message.folder, {
        expectedId: message.id,
        expectedUidValidity: message.folder_uid_validity,
        snapshot: snapshotFromMessageRow(message),
      });
    } catch (err) {
      console.error('IMAP permanent delete (draft) failed:', err.message);
      return res.status(500).json({ error: 'Failed to delete draft' });
    }
    imapManager.broadcast({ type: 'folder_updated', folder: message.folder, accountId: message.account_id }, req.session.userId);
    return res.json({ ok: true });
  }

  const trashPath = await resolveTrashFolder(message.account_id, account.folder_mappings);
  const allTrashPaths = await resolveAllTrashPaths(message.account_id, account.folder_mappings);
  const strategy = getDeleteStrategy(message.folder, trashPath, allTrashPaths);

  if (strategy.action === 'no_trash') {
    return res.status(422).json({ error: 'No Trash folder configured for this account' });
  }

  if (strategy.action === 'move') {
    // Guard the source UID before the IMAP move so reconcileDeletes cannot delete
    // the DB row if an EXPUNGE arrives while the move is in flight.
    imapManager._guardMoveUid(message.account_id, message.folder, message.uid);
    try {
      try {
        await imapManager.moveMessage(account, message.uid, message.folder, trashPath, {
          operationKey: `delete:${id}:${message.folder}:${trashPath}`,
          expectedUidValidity: message.folder_uid_validity,
          snapshot: snapshotFromMessageRow(message),
          materialize: (receipt, operation, tx) => materializeArchiveReceipt(tx, {
            accountId: message.account_id,
            sourceSnapshot: message,
            destinationFolder: trashPath,
            receipt,
            operation,
          }),
        });
      } catch (err) {
        console.error('IMAP move to trash failed:', err.message);
        return res.status(500).json({ error: 'Failed to delete message' });
      }
    } finally {
      imapManager._unguardMoveUid(message.account_id, message.folder, message.uid);
    }
  } else {
    // strategy.action === 'expunge': message is already in Trash — permanently delete.
    try {
      await imapManager.removeMessageCopy(message.account_id, message.uid, message.folder, {
        expectedId: message.id,
        expectedUidValidity: message.folder_uid_validity,
        snapshot: snapshotFromMessageRow(message),
      });
    } catch (err) {
      console.error('IMAP permanent delete failed:', err.message);
      return res.status(500).json({ error: 'Failed to delete message' });
    }
  }
  imapManager.broadcast({ type: 'folder_updated', folder: message.folder, accountId: message.account_id }, req.session.userId);
  // Refresh GTD section data if this thread still carries a GTD label sibling (same staleness the
  // bulk-delete route addresses, reached via the single-message delete button).
  notifyMailMutation([message], req.session.userId);
  res.json({ ok: true });
});

// ── Antispam (v0.1) ─────────────────────────────────────────────────────────
// Manual "Mark as Spam" / "Mark as Not Spam" endpoints.
// They move the message to the account's spam folder (or back to INBOX for
// ham) via IMAP, persist the user override in messages.spam_user_override,
// and log the decision to spam_training_log so future releases can train
// per-user models on it.
//
// No automatic classification runs here — that ships in v0.2 (ML) and v0.3 (SA).

// Helper: move a single message to a destination folder, update DB, log to
// training_log, and broadcast folder_updated. Shared between /spam and /ham.
async function moveForSpamLabel(messageId, userId, destinationFolder, label) {
  const result = await query(`
    SELECT m.*, a.user_id, a.folder_mappings,
           live_folder.uid_validity AS folder_uid_validity,
           live_folder.observation_generation AS folder_observation_generation
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [messageId, userId]);

  if (!result.rows.length) return { ok: false, status: 404, error: 'Message not found' };
  const message = result.rows[0];

  // No-op: message already in the destination folder.
  if (message.folder === destinationFolder) {
    // Still record the training label so the user's intent is captured
    // (e.g. re-confirming a verdict), but skip the IMAP move.
    await query(
      `INSERT INTO spam_training_log
         (user_id, account_id, message_id_header, message_uid, folder, label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, message.account_id, message.message_id, message.uid, message.folder, label]
    );
    await query(
      `UPDATE messages SET spam_user_override = $1, spam_verdict = $1, spam_analyzed_at = NOW() WHERE id = $2`,
      [label, messageId]
    );
    return { ok: true, status: 200, body: { ok: true, alreadyInFolder: true, folder: destinationFolder } };
  }

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];

  // Guard the source UID before the IMAP move so reconcileDeletes cannot
  // delete the DB row if an EXPUNGE arrives while the move is in flight.
  imapManager._guardMoveUid(account.id, message.folder, message.uid);
  let newUid;
  try {
    try {
      newUid = await imapManager.moveMessage(account, message.uid, message.folder, destinationFolder, {
        operationKey: `spam:${messageId}:${message.folder}:${destinationFolder}:${label}`,
        expectedUidValidity: message.folder_uid_validity,
        snapshot: snapshotFromMessageRow(message),
        materialize: async (receipt, operation, tx) => {
          await materializeArchiveReceipt(tx, {
            accountId: account.id,
            sourceSnapshot: message,
            destinationFolder,
            receipt,
            operation,
          });
          await tx.query(
            `UPDATE messages SET spam_user_override = $1, spam_verdict = $1,
                    spam_analyzed_at = NOW()
              WHERE id = $2 AND account_id = $3 AND folder = $4 AND uid = $5`,
            [label, messageId, account.id, destinationFolder, receipt.uid],
          );
          await tx.query(
            `INSERT INTO spam_training_log
               (user_id, account_id, message_id_header, message_uid, folder, label, source)
             VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
            [userId, account.id, message.message_id, receipt.uid, destinationFolder, label],
          );
        },
      });
    } catch (err) {
      console.error(`IMAP move for /${label} failed:`, err.message);
      return { ok: false, status: 502, error: `IMAP move failed: ${err.message}` };
    }
  } finally {
    imapManager._unguardMoveUid(account.id, message.folder, message.uid);
  }

  // If folder_mappings.spam is not yet configured, learn from the discovered folder.
  if (label === 'spam' && !account.folder_mappings?.spam) {
    await query(
      `UPDATE email_accounts SET folder_mappings = folder_mappings || jsonb_build_object('spam', $1::text)
       WHERE id = $2 AND NOT (folder_mappings ? 'spam')`,
      [destinationFolder, account.id]
    ).catch(err => console.warn('Failed to auto-persist folder_mappings.spam:', err.message));
  }

  imapManager.broadcast(
    { type: 'folder_updated', folder: destinationFolder, accountId: account.id },
    userId
  );

  // Refresh GTD section data if the (un)spammed message's thread carries a GTD label. Covers both
  // /spam and /ham, which share this mover. The already-in-folder no-op path above returns
  // early without a move, so GTD section data is untouched there.
  notifyMailMutation([message], userId);

  return { ok: true, status: 200, body: { ok: true, folder: destinationFolder, newUid: newUid || null } };
}

// POST /api/mail/messages/:id/spam
// Moves the message to the account's spam/junk folder and records the user
// override as spam. Coexists with the future ML/SA auto-classification:
// spam_user_override always wins over auto verdicts.
router.post('/messages/:id/spam', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const lookup = await query(`
    SELECT m.account_id, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!lookup.rows.length) return res.status(404).json({ error: 'Message not found' });
  const spamFolder = await resolveSpamFolder(lookup.rows[0].account_id, lookup.rows[0].folder_mappings);
  if (!spamFolder) return res.status(422).json({ error: 'No spam folder configured for this account' });

  const result = await moveForSpamLabel(id, req.session.userId, spamFolder, 'spam');
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.body);
});

// GET /api/mail/category-counts
// Returns unread message counts per category for the INBOX. Used by the
// category tab bar to show unread badges. Scoped to the user; optionally
// filtered to a single account via ?accountId=.
router.get('/category-counts', async (req, res) => {
  const { accountId } = req.query;
  if (accountId && !UUID_RE.test(accountId)) {
    return res.status(400).json({ error: 'Invalid account id' });
  }

  const accountsResult = await query(
    'SELECT id, include_in_unified_inbox FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const { accountIds: scopedIds } = resolveAccountScope(accountsResult.rows, accountId);
  if (!scopedIds.length) return res.json({ counts: {} });

  const result = await query(`
    SELECT COALESCE(m.category, 'primary') AS category,
           COUNT(*) FILTER (WHERE m.is_read = false)::int AS unread_count
    FROM messages m
    WHERE m.account_id = ANY($1)
      AND m.folder = 'INBOX'
      AND m.is_deleted = false
      AND m.metadata_complete = true
    GROUP BY COALESCE(m.category, 'primary')
  `, [scopedIds]);

  const counts = {};
  for (const row of result.rows) {
    counts[row.category] = row.unread_count;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ counts });
});

// PATCH /api/mail/messages/:id/category
// Manually override the computed category for a single message.
router.patch('/messages/:id/category', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const { category } = req.body;
  const VALID_CATEGORIES = new Set(['primary', 'newsletter', 'promotion', 'automated', 'social']);
  if (!VALID_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  const result = await query(
    `UPDATE messages SET category = $1
     FROM email_accounts a
     JOIN folders live_folder ON live_folder.account_id = a.id
     WHERE messages.id = $2
       AND messages.account_id = a.id
       AND live_folder.path = messages.folder
       AND live_folder.is_present = true
       AND live_folder.uid_validity IS NOT NULL
       AND a.user_id = $3
       AND messages.is_deleted = false
       AND messages.metadata_complete = true
     RETURNING messages.id`,
    [category === 'primary' ? null : category, id, req.session.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true, category });
});

// POST /api/mail/messages/:id/unsubscribe
// Processes a one-click unsubscribe (RFC 8058) or returns parsed
// unsubscribe options for the frontend to handle (URL open, mailto compose).
router.post('/messages/:id/unsubscribe', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.list_unsubscribe, m.list_unsubscribe_post
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const { list_unsubscribe: rawUnsub, list_unsubscribe_post: rawUnsubPost } = result.rows[0];
  if (!rawUnsub) return res.status(400).json({ error: 'No unsubscribe header' });
  const list_unsubscribe = decodeMimeWords(rawUnsub);
  const list_unsubscribe_post = rawUnsubPost ? decodeMimeWords(rawUnsubPost) : rawUnsubPost;

  // Parse angle-bracket-wrapped URLs/mailtos from the header value.
  // e.g. "<https://example.com/unsub>, <mailto:list@example.com?subject=unsubscribe>"
  const refs = [...list_unsubscribe.matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
  const httpsUrl = refs.find(r => /^https:\/\//i.test(r));
  const mailtoUrl = refs.find(r => /^mailto:/i.test(r));

  const isOneClick = /List-Unsubscribe=One-Click/i.test(list_unsubscribe_post || '');

  // RFC 8058 one-click: POST to the https URL on behalf of the user.
  if (isOneClick && httpsUrl) {
    // Validate the URL host — DNS-resolved check blocks hostnames that resolve to private IPs.
    let parsed;
    try { parsed = new URL(httpsUrl); } catch {
      return res.status(400).json({ error: 'Invalid unsubscribe URL' });
    }
    const hostErr = await validateHost(parsed.hostname);
    if (hostErr) return res.status(400).json({ error: 'Unsubscribe URL not allowed' });

    try {
      // safeFetch validates the resolved IP of the initial host AND every redirect
      // hop, so an attacker-supplied List-Unsubscribe URL can't redirect to an
      // internal address. (The validateHost above stays as a fast pre-check.)
      const unsub = await safeFetch(httpsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mailflow/1.0' },
        body: 'List-Unsubscribe=One-Click',
        signal: AbortSignal.timeout(10000),
      });
      if (unsub.ok) {
        await query('UPDATE messages SET unsubscribed_at = NOW() WHERE id = $1', [id]);
        return res.json({ ok: true, type: 'one-click' });
      }
      console.warn(`One-click unsubscribe returned ${unsub.status} for ${httpsUrl}`);
      // Fall through to URL/mailto fallback
    } catch (err) {
      console.warn('One-click unsubscribe failed:', err.message);
      // Fall through to URL/mailto options instead
    }
  }

  // Return parsed options for the frontend to handle.
  // Mark unsubscribed_at optimistically — the user has been given the mechanism to complete it.
  await query('UPDATE messages SET unsubscribed_at = NOW() WHERE id = $1', [id]);
  res.json({
    ok: true,
    type: httpsUrl ? 'url' : 'mailto',
    url: httpsUrl || null,
    mailto: mailtoUrl || null,
  });
});

// POST /api/mail/messages/:id/ham
// Moves a message back from the spam folder to INBOX and records the override
// as ham (not spam). Only meaningful when the message is currently in a
// spam-like folder; returns 400 otherwise.
router.post('/messages/:id/ham', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const lookup = await query(`
    SELECT m.account_id, m.folder, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN folders live_folder ON live_folder.account_id = m.account_id
      AND live_folder.path = m.folder AND live_folder.is_present = true
      AND live_folder.uid_validity IS NOT NULL
    WHERE m.id = $1 AND a.user_id = $2
      AND m.is_deleted = false AND m.metadata_complete = true
  `, [id, req.session.userId]);

  if (!lookup.rows.length) return res.status(404).json({ error: 'Message not found' });
  const allSpam = await resolveAllSpamPaths(lookup.rows[0].account_id, lookup.rows[0].folder_mappings);
  if (!allSpam.has(lookup.rows[0].folder)) {
    return res.status(400).json({ error: 'Message is not in the spam folder' });
  }

  // Resolve inbox folder per account — Gmail, Exchange and others may not use
  // the literal 'INBOX' (e.g. 'Inbox' on Dovecot, 'Posteingang', etc.).
  // Same pattern as folder_mappings.sent / .drafts in send.js and draft.js.
  const inboxFolder = lookup.rows[0].folder_mappings?.inbox || 'INBOX';
  const result = await moveForSpamLabel(id, req.session.userId, inboxFolder, 'ham');
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.body);
});

export default router;
