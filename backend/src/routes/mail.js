import { Router } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { sanitizeEmail, stripEmailHead, hasRemoteImages, blockRemoteImages, rewriteEbayImageserUrls, rewriteAnchorHrefs } from '../services/emailSanitizer.js';
import { snippetFromBody, decodeMimeWords, parseRawHeaders, buildHeadersFromMessage } from '../services/messageParser.js';
import { resolveTrashFolder, resolveAllTrashPaths, resolveAllDraftsPaths, getDeleteStrategy, adjustFolderCounts } from '../utils/mailUtils.js';
import { emitGtdIfRelevant } from '../services/gtdSections.js';
import { listMessages } from '../services/messageService.js';
import { resolveAccountScope } from '../services/unifiedInbox.js';
import { validateHost } from '../services/hostValidation.js';
import { safeFetch } from '../services/safeFetch.js';
import { DELEGATION_SELECT_SQL, delegationJoinSql, mapDelegationRow } from '../services/gtdDelegations.js';
import { bulkSetRead, setRead, setStarred } from '../services/mailbox/flags.js';
import { bulkMoveToFolder } from '../services/mailbox/move.js';
import { bulkArchive } from '../services/mailbox/archive.js';
import { bulkTrash } from '../services/mailbox/trash.js';
import { createFolder, deleteFolder, renameFolder } from '../services/mailbox/folders.js';
import { setCategory } from '../services/mailbox/category.js';
import {
  gatherSnoozeConversation,
  snoozeConversation,
  unsnoozeConversation,
} from '../services/mailbox/snooze.js';
import { markNotSpam, markSpam } from '../services/mailbox/spamLabel.js';
import { UUID_RE, areValidUUIDs, isValidFolderName } from '../utils/validation.js';

const router = Router();
router.use(requireAuth);

export { gatherSnoozeConversation };

// Sanitize an attachment filename for use in Content-Disposition.
// Strips path separators and control characters; falls back to 'attachment'.
function safeFilename(name) {
  if (!name) return 'attachment';
  // Strip path separators, control chars, and Unicode bidi override chars that could
  // spoof displayed file extensions (e.g. U+202E reverses the filename visually).
  const cleaned = String(name)
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex -- intentionally stripping control characters
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[‪-‮⁦-⁩‏؜]/g, '')
    .trim()
    .substring(0, 255);
  return cleaned || 'attachment';
}

// Strip NUL bytes from strings before DB writes. PostgreSQL UTF-8 text columns
// reject 0x00, and malformed MIME bodies can contain embedded NUL characters.
function sanitizeDbText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\0/g, '');
}

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

// Fire-and-forget GTD sections refresh after an ordinary mail mutation. Groups the acted
// rows by account and asks emitGtdIfRelevant to broadcast gtd_sections_updated per
// account whose messages still touch a designated GTD folder — either a live sibling
// post-mutation, or one of the acted rows sitting in a GTD folder pre-mutation (covers
// removing the last GTD-folder copy of a thread, which leaves no post-mutation sibling
// to find). Rows are the pre-mutation message rows so their message_id and folder are
// captured before a move/delete can drop them; a failed emit is logged, never surfaced,
// so it can't turn a completed mutation into a 500.
function emitGtdSectionsRefresh(rows, userId) {
  const byAccount = new Map();
  for (const m of rows) {
    if (!m.message_id) continue;
    if (!byAccount.has(m.account_id)) byAccount.set(m.account_id, { mids: new Set(), folders: new Set() });
    const entry = byAccount.get(m.account_id);
    entry.mids.add(m.message_id);
    if (m.folder) entry.folders.add(m.folder);
  }
  for (const [accountId, { mids, folders }] of byAccount) {
    emitGtdIfRelevant(imapManager, accountId, userId, [...mids], [...folders])
      .catch(err => console.warn('GTD sections refresh emit failed:', err.message));
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
    excludeClaimedSourceDrafts: true,
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
             a.color AS account_color,
             ${DELEGATION_SELECT_SQL}
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      ${delegationJoinSql('m', 'a')}
      WHERE m.id = $1
        AND a.user_id = $2
        AND m.is_deleted = false
    `, [id, req.session.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ ...result.rows[0], delegation: mapDelegationRow(result.rows[0]) });
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
             a.color AS account_color,
             ${DELEGATION_SELECT_SQL}`;
  try {
    // Durable match on the stable Message-ID header. When the same email exists in more
    // than one folder (e.g. INBOX + Archive), prefer the INBOX copy, then the most recent.
    let result = await query(`
      SELECT ${COLS}
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      ${delegationJoinSql('m', 'a')}
      WHERE m.message_id = $1
        AND a.user_id = $2
        AND m.is_deleted = false
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
        ${delegationJoinSql('m', 'a')}
        WHERE m.id = $1
          AND a.user_id = $2
          AND m.is_deleted = false
          AND ($3::uuid IS NULL OR m.account_id = $3)
      `, [ref, req.session.userId, accountId]);
    }
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
    res.json({ ...result.rows[0], delegation: mapDelegationRow(result.rows[0]) });
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
               a.name AS account_name, a.email_address AS account_email, a.color AS account_color,
               ${DELEGATION_SELECT_SQL}
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        ${delegationJoinSql('m', 'a')}
        WHERE m.is_deleted = false
          AND m.account_id = ANY($1)
          AND m.thread_key = $2
        ORDER BY m.message_id,
                 CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                 m.date ASC
      )
      SELECT * FROM deduped ORDER BY date ASC
    `, [accountIds, threadId]);

    res.json({ messages: result.rows.map(row => ({ ...row, delegation: mapDelegationRow(row) })) });
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
    WHERE a.user_id = $1 AND a.enabled = true
      AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false
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
    SELECT m.*, a.user_id, u.preferences FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    JOIN users u ON u.id = a.user_id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

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
    return res.json({ html: responseHtml, text: message.body_text, attachments, hasBlockedRemoteImages });
  }

  // Fetch from IMAP — signal user activity so background jobs back off during this request.
  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];
    imapManager.noteUserActivity(account.id);

    const { html, text, attachments } = await fetchWithTimeout(
      imapManager.fetchMessageBody(account, message.uid, message.folder),
      BODY_FETCH_TIMEOUT_MS
    );

    const safeHtml = html ? sanitizeDbText(sanitizeEmail(html)) : null;
    const safeText = sanitizeDbText(text);
    const snip = sanitizeDbText(snippetFromBody(safeText, safeHtml || html));

    // Only cache when we actually got body content — don't overwrite a prior
    // successful cache with null if a transient IMAP fetch returns nothing.
    if (safeHtml || text || (attachments && attachments.length > 0)) {
      await query(
        `UPDATE messages
         SET body_html = $1, body_text = $2, attachments = $3,
             snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
         WHERE id = $4`,
        [safeHtml, safeText, JSON.stringify(attachments || []), id, snip]
      );
    }

    // Apply remote-image blocking at response time — safeHtml (unblocked) is what
    // was written to the DB cache above, preserving the canonical body.
    const skipBlocking = req.query.remoteImages === '1';
    let responseHtml = safeHtml;
    let hasBlockedRemoteImages = false;
    if (!skipBlocking && safeHtml && shouldBlockImages(message.preferences, message) && hasRemoteImages(safeHtml)) {
      responseHtml = blockRemoteImages(safeHtml);
      hasBlockedRemoteImages = true;
    }
    res.json({ html: responseHtml, text: safeText, attachments: attachments || [], hasBlockedRemoteImages });
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
    res.status(500).json({ error: msg });
  }
});

// Get full raw headers
router.get('/messages/:id/headers', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];

    let headers = '';
    try {
      headers = await imapManager.fetchHeaders(account, message.uid, message.folder);
    } catch (fetchErr) {
      console.warn('Headers IMAP fetch failed:', fetchErr.message);
    }

    if (!headers?.trim()) {
      headers = buildHeadersFromMessage(message);
    }

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
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

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

    const bufferMap = await imapManager.fetchMultipleAttachments(account, message.uid, message.folder, eligible);
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

    const zipName = safeFilename((message.subject || 'attachments').substring(0, 100)) + '-attachments.zip';
    const encoded = encodeURIComponent(zipName);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"; filename*=UTF-8''${encoded}`);

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
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

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
    const buffer = await imapManager.fetchAttachment(accountResult.rows[0], message.uid, message.folder, partNum);

    if (!buffer) return res.status(404).json({ error: 'Could not fetch attachment' });

    const safe = safeFilename(att.filename);
    const encoded = encodeURIComponent(att.filename || 'attachment');
    res.setHeader('Content-Type', att.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Attachment fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

// Mark read/unread
router.patch('/messages/:id/read', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { read } = req.body;
  const result = await setRead(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
    read,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// Star/unstar
router.patch('/messages/:id/star', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { starred } = req.body;
  const result = await setStarred(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
    starred,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
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
  await query('UPDATE messages SET is_read = true, read_changed_at = NOW() WHERE account_id = $1 AND folder = $2', [accountId, folder]);
  await query('UPDATE folders SET unread_count = 0 WHERE account_id = $1 AND path = $2', [accountId, folder])
    .catch(err => console.error('Folder count update failed:', err.message));
  // Also update IMAP so the change survives the next sync (non-fatal if it fails)
  imapManager.markAllReadImap(check.rows[0], folder).catch(err =>
    console.warn('markAllReadImap failed:', err.message)
  );
  imapManager.broadcast({ type: 'sync_complete', accountId }, check.rows[0].user_id);
  res.json({ ok: true });
});

// Create folder
router.post('/folders', async (req, res) => {
  const { accountId, name, parentPath } = req.body;
  if (!accountId || !name?.trim()) return res.status(400).json({ error: 'accountId and name required' });
  if (!isValidFolderName(name.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (parentPath && !isValidFolderName(parentPath)) return res.status(400).json({ error: 'Invalid parent path' });

  const result = await createFolder(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    accountId,
    name,
    parentPath,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});
// Delete folder
router.post('/folders/delete', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });

  const result = await deleteFolder(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    accountId,
    path,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});
// Rename folder
router.post('/folders/rename', async (req, res) => {
  const { accountId, oldPath, newName } = req.body;
  if (!accountId || !oldPath || !newName?.trim()) return res.status(400).json({ error: 'Missing required fields' });
  if (!isValidFolderName(newName.trim())) return res.status(400).json({ error: 'Invalid folder name' });
  if (!isValidFolderName(oldPath)) return res.status(400).json({ error: 'Invalid folder path' });

  const result = await renameFolder(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    accountId,
    oldPath,
    newName,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});
// Empty folder (delete all messages)
router.post('/folders/empty', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  if (!isValidFolderName(path)) return res.status(400).json({ error: 'Invalid folder path' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    await imapManager.emptyFolder(check.rows[0], path);
  } catch (err) {
    console.error(`IMAP emptyFolder failed for ${path}:`, err.message);
    return res.status(500).json({ error: 'Failed to empty folder on server' });
  }
  await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
  await query(
    'UPDATE folders SET total_count = 0, unread_count = 0 WHERE account_id = $1 AND path = $2',
    [accountId, path]
  );
  imapManager.broadcast({ type: 'sync_complete', accountId }, check.rows[0].user_id);
  res.json({ ok: true });
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

  const result = await bulkSetRead(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    ids,
    read,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// Bulk delete (move to trash)
router.post('/messages/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message id format' });
  }

  const result = await bulkTrash(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    ids,
    allowPermanent: true,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});
// Bulk move to folder
router.post('/messages/bulk-move', async (req, res) => {
  const { ids, folder } = req.body;
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

  const result = await bulkMoveToFolder(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    ids,
    folder,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // MCP consumes the richer receipt (movedDetails/skippedAccounts/failed) via the
  // service return value directly; REST keeps its original {ok, moved} wire shape.
  res.json({ ok: result.ok, moved: result.moved });
});
// Bulk archive — moves messages to the archive folder for each account
router.post('/messages/bulk-archive', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Too many ids — maximum 500 per request' });
  }
  if (!areValidUUIDs(ids)) {
    return res.status(400).json({ error: 'Invalid message IDs' });
  }

  const result = await bulkArchive(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    ids,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // MCP consumes the richer receipt (archivedDetails/failed) via the service return
  // value directly; REST keeps its original {ok, archived, noArchiveFolder} wire shape.
  res.json({ ok: result.ok, archived: result.archived, noArchiveFolder: result.noArchiveFolder });
});

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

  const result = await snoozeConversation(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
    until: untilDate,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

router.delete('/messages/:id/snooze', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await unsnoozeConversation(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// Delete (move to trash; drafts are permanently deleted)
router.delete('/messages/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await query(`
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
  const account = accountResult.rows[0];
  const wasUnread = !message.is_read ? 1 : 0;

  // Drafts bypass Trash and are permanently deleted (consistent with all major email clients).
  const allDraftsPaths = await resolveAllDraftsPaths(message.account_id, account.folder_mappings);
  if (allDraftsPaths.has(message.folder)) {
    try {
      await imapManager.permanentDeleteMessage(account, message.uid, message.folder);
    } catch (err) {
      console.error('IMAP permanent delete (draft) failed:', err.message);
      return res.status(500).json({ error: 'Failed to delete draft' });
    }
    await query('DELETE FROM messages WHERE id = $1', [id]);
    adjustFolderCounts(message.account_id, message.folder, -1, -wasUnread);
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
    let newUid;
    try {
      try {
        newUid = await imapManager.moveMessage(account, message.uid, message.folder, trashPath);
      } catch (err) {
        console.error('IMAP move to trash failed:', err.message);
        return res.status(500).json({ error: 'Failed to delete message' });
      }
      if (newUid != null) {
        // Delete any stale row the sync may have already inserted at the destination,
        // then update the source row in place to avoid a unique-constraint violation.
        await query('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4',
          [message.account_id, newUid, trashPath, id]);
        await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [trashPath, newUid, id]);
      } else {
        // Non-UIDPLUS: DB holds the stale source UID at the destination. Guard it so
        // reconcileDeletes does not treat it as an orphan before the next sync corrects it.
        imapManager._guardMoveUid(message.account_id, trashPath, message.uid);
        await query('UPDATE messages SET folder = $1 WHERE id = $2', [trashPath, id]);
        setTimeout(() => imapManager._unguardMoveUid(message.account_id, trashPath, message.uid), 10_000);
      }
    } finally {
      imapManager._unguardMoveUid(message.account_id, message.folder, message.uid);
    }
    adjustFolderCounts(message.account_id, message.folder, -1, -wasUnread);
    adjustFolderCounts(message.account_id, trashPath, 1, wasUnread);
  } else {
    // strategy.action === 'expunge': message is already in Trash — permanently delete.
    try {
      await imapManager.permanentDeleteMessage(account, message.uid, message.folder);
    } catch (err) {
      console.error('IMAP permanent delete failed:', err.message);
      return res.status(500).json({ error: 'Failed to delete message' });
    }
    await query('DELETE FROM messages WHERE id = $1', [id]);
    adjustFolderCounts(message.account_id, message.folder, -1, -wasUnread);
  }
  imapManager.broadcast({ type: 'folder_updated', folder: message.folder, accountId: message.account_id }, req.session.userId);
  // Refresh GTD section data if this thread still carries a GTD label sibling (same staleness the
  // bulk-delete route addresses, reached via the single-message delete button).
  emitGtdSectionsRefresh([message], req.session.userId);
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

// POST /api/mail/messages/:id/spam
// Moves the message to the account's spam/junk folder and records the user
// override as spam. Coexists with the future ML/SA auto-classification:
// spam_user_override always wins over auto verdicts.
router.post('/messages/:id/spam', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });

  const result = await markSpam(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
  });
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

  const result = await setCategory(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
    category,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result);
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
    WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false
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

  const result = await markNotSpam(imapManager, {
    userId: req.session.userId,
    accountIds: null,
    id,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.body);
});

export default router;
