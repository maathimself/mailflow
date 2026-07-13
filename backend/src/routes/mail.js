import { Router } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { sanitizeEmail, stripEmailHead, hasRemoteImages, blockRemoteImages, rewriteEbayImageserUrls, rewriteAnchorHrefs } from '../services/emailSanitizer.js';
import { snippetFromBody, decodeMimeWords, parseRawHeaders, buildHeadersFromMessage } from '../services/messageParser.js';
import { resolveTrashFolder, resolveAllTrashPaths, resolveAllDraftsPaths, resolveArchiveFolder, isAllMailFolder, resolveSpamFolder, resolveAllSpamPaths, getDeleteStrategy, adjustFolderCounts, fanOutReadToSiblings, fanOutStarToSiblings, fanOutBulkReadToSiblings } from '../utils/mailUtils.js';
import { emitGtdIfRelevant } from '../services/gtdSections.js';
import { listMessages } from '../services/messageService.js';
import { validateHost } from '../services/hostValidation.js';
import { safeFetch } from '../services/safeFetch.js';

const router = Router();
router.use(requireAuth);

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

// Validate a folder name / path component: no control chars, max 255 chars.
function isValidFolderName(name) {
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function areValidUUIDs(ids) {
  return ids.every(id => typeof id === 'string' && UUID_RE.test(id));
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
             m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at,
             a.name AS account_name, a.email_address AS account_email,
             a.color AS account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.id = $1
        AND a.user_id = $2
        AND m.is_deleted = false
    `, [id, req.session.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /messages/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load message' });
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
      'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
      [req.session.userId]
    );
    const userAccountIds = accountsResult.rows.map(r => r.id);
    if (!userAccountIds.length) return res.json({ messages: [] });

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
               m.list_unsubscribe, m.list_unsubscribe_post, m.unsubscribed_at,
               a.name AS account_name, a.email_address AS account_email, a.color AS account_color
        FROM messages m
        JOIN email_accounts a ON m.account_id = a.id
        WHERE m.is_deleted = false
          AND m.account_id = ANY($1)
          AND m.thread_key = $2
        ORDER BY m.message_id,
                 CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
                 m.date ASC
      )
      SELECT * FROM deduped ORDER BY date ASC
    `, [userAccountIds, threadId]);

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
    SELECT m.account_id, COUNT(*) AS count
    FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE a.user_id = $1 AND a.enabled = true
      AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false
    GROUP BY m.account_id
  `, [req.session.userId]);

  const byAccount = {};
  let total = 0;
  for (const row of result.rows) {
    byAccount[row.account_id] = parseInt(row.count);
    total += parseInt(row.count);
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

  const result = await query(`
    SELECT m.*, a.user_id,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Run DB update and account fetch concurrently — no dependency between them.
  // read_changed_at tells the IMAP sync not to overwrite this change for 30 s,
  // preventing a race where a concurrent sync fetch sees the old IMAP flag.
  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = $2', [read, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  // Keep the cached folder unread_count in sync so pagination totals stay accurate.
  if (!!message.is_read !== !!read) {
    adjustFolderCounts(message.account_id, message.folder, 0, read ? -1 : 1);
  }

  // GTD: a labeled message owns a sibling row per folder. Fan the read change out to
  // those rows (and their folder unread counts) so label views don't go stale. Gated on
  // gtd_enabled (so a non-GTD account is byte-identical to pre-GTD behaviour) AND on the
  // message actually having siblings — a plain single-folder message keeps the PK-only
  // fast path. The IMAP \Seen flag is written to the acted folder only (below): Gmail
  // propagates \Seen message-wide server-side, and per-copy writes to N folders would
  // multiply round-trips — an asymmetry accepted in the GTD design.
  if (accountResult.rows[0]?.gtd_enabled && Number(message.sibling_count) > 1) {
    await fanOutReadToSiblings(message.account_id, message.message_id, read);
  }

  try {
    await imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Seen', read);
    imapManager._resolveFlagPush(message.account_id, id, '\\Seen'); // confirmed — drop any stale queued op
  } catch (err) {
    console.error('IMAP flag update failed:', err.message);
    // Push failed — queue a durable retry so a later flag-sync pull can't silently revert
    // the user's change once the 30s local-wins window lapses.
    imapManager._enqueueFlagPush(message.account_id, id, '\\Seen', read);
  }

  // Refresh GTD section data if this message's thread carries a GTD label (its head shows read state).
  emitGtdSectionsRefresh([message], req.session.userId);

  res.json({ ok: true, is_read: read });
});

// Star/unstar
router.patch('/messages/:id/star', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { starred } = req.body;

  const result = await query(`
    SELECT m.*, a.user_id,
           CASE WHEN m.message_id IS NULL THEN 1
                ELSE (SELECT COUNT(*) FROM messages s
                       WHERE s.account_id = m.account_id AND s.message_id = m.message_id)
           END AS sibling_count
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Run DB update and account fetch concurrently — no dependency between them.
  // star_changed_at tells the IMAP sync not to overwrite this change for 30 s.
  const [, accountResult] = await Promise.all([
    query('UPDATE messages SET is_starred = $1, star_changed_at = NOW() WHERE id = $2', [starred, id]),
    query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]),
  ]);

  // GTD: fan the star change out to the message's sibling label rows (see the read
  // handler). Gated on gtd_enabled to keep a non-GTD account byte-identical to pre-GTD.
  // Stars don't affect folder unread counts, so no count adjustment. The IMAP \Flagged
  // write below stays on the acted folder only.
  if (accountResult.rows[0]?.gtd_enabled && Number(message.sibling_count) > 1) {
    await fanOutStarToSiblings(message.account_id, message.message_id, starred);
  }

  try {
    await imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Flagged', starred);
    imapManager._resolveFlagPush(message.account_id, id, '\\Flagged'); // confirmed — drop any stale queued op
  } catch (err) {
    console.error('IMAP star update failed:', err.message);
    // Push failed — queue a durable retry so a later flag-sync pull can't silently revert it.
    imapManager._enqueueFlagPush(message.account_id, id, '\\Flagged', starred);
  }

  // Refresh GTD section data if this message's thread carries a GTD label (its head shows star state).
  emitGtdSectionsRefresh([message], req.session.userId);

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
    await imapManager.createFolder(check.rows[0], path);
    await query(
      `INSERT INTO folders (account_id, path, name) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, path) DO NOTHING`,
      [accountId, path, name.trim()]
    );
    res.json({ ok: true, path });
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
  await query('DELETE FROM folders WHERE account_id = $1 AND path = $2', [accountId, path]);
  await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
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
    await query(
      'UPDATE folders SET path = $1, name = $2, updated_at = NOW() WHERE account_id = $3 AND path = $4',
      [newPath, newName.trim(), accountId, oldPath]
    );
    await query('UPDATE messages SET folder = $1 WHERE account_id = $2 AND folder = $3', [newPath, accountId, oldPath]);
    res.json({ ok: true, newPath });
  } catch (err) {
    console.error('Rename folder error:', err);
    res.status(500).json({ error: 'Failed to rename folder' });
  }
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

  try {
    const result = await query(
      `SELECT m.id, m.uid, m.folder, m.is_read, m.account_id, m.message_id, a.gtd_enabled FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
      [req.session.userId, ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, updated: [] });

    // Skip messages whose state already matches — avoid spurious DB writes and IMAP round-trips.
    const toUpdate = owned.filter(m => !!m.is_read !== !!read);
    if (!toUpdate.length) return res.json({ ok: true, updated: [] });

    await query(
      'UPDATE messages SET is_read = $1, read_changed_at = NOW() WHERE id = ANY($2::uuid[])',
      [read, toUpdate.map(m => m.id)]
    );

    // Adjust cached unread counts per account+folder.
    const folderDeltas = {};
    for (const msg of toUpdate) {
      const key = `${msg.account_id}:${msg.folder}`;
      if (!folderDeltas[key]) folderDeltas[key] = { accountId: msg.account_id, folder: msg.folder, delta: 0 };
      folderDeltas[key].delta += read ? -1 : 1;
    }
    for (const { accountId, folder, delta } of Object.values(folderDeltas)) {
      adjustFolderCounts(accountId, folder, 0, delta);
    }

    // GTD: fan the read change out to sibling label rows of every updated message that
    // belongs to a gtd_enabled account, adjusting each sibling folder's unread count.
    // Gating on gtd_enabled keeps a non-GTD account byte-identical to pre-GTD (no extra
    // fan-out query); the fan-out itself is also self-limiting for messages without
    // siblings. IMAP \Seen is still written per acted row only (below); Gmail propagates
    // it message-wide server-side.
    // gtdUpdatedIds is scoped to toUpdate (rows whose read-state actually changed), so a
    // message already at the target state never triggers sibling fan-out here — unlike the
    // single-message handler above, which fans out unconditionally regardless of whether the
    // acted message's own state changed. That asymmetry is acceptable: nothing else in this
    // path can push a sibling out of sync with its head, and the label-folder tick already
    // self-heals any divergence on the next read.
    const gtdUpdatedIds = toUpdate.filter(m => m.gtd_enabled).map(m => m.id);
    if (gtdUpdatedIds.length) await fanOutBulkReadToSiblings(gtdUpdatedIds, read);

    // IMAP flag updates — group by account to fetch each account row once.
    const byAccount = {};
    for (const msg of toUpdate) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }
    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const results = await runInBatches(
        msgs, 3,
        msg => imapManager.setFlag(account, msg.uid, msg.folder, '\\Seen', read)
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`bulk-read IMAP ${msgs[i].id}:`, r.reason.message);
          // Durable retry so a later flag-sync pull can't revert this message to unread.
          imapManager._enqueueFlagPush(accountId, msgs[i].id, '\\Seen', read);
        } else {
          imapManager._resolveFlagPush(accountId, msgs[i].id, '\\Seen'); // confirmed
        }
      });
    }

    // Refresh GTD section data for any updated thread that carries a GTD label.
    emitGtdSectionsRefresh(toUpdate, req.session.userId);

    res.json({ ok: true, updated: toUpdate.map(m => m.id) });
  } catch (err) {
    console.error('bulk-read error:', err);
    res.status(500).json({ error: 'Failed to update messages' });
  }
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

  const moveGuards = [];
  try {
    const result = await query(
      `SELECT m.*, a.user_id, a.folder_mappings FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
      [req.session.userId, ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, deleted: [] });

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

      // Drafts and messages already in Trash are permanently deleted; others move to Trash.
      const toExpunge = msgs.filter(m => allTrashPaths.has(m.folder) || allDraftsPaths.has(m.folder));
      const toMove    = msgs.filter(m => !allTrashPaths.has(m.folder) && !allDraftsPaths.has(m.folder));

      // Permanently delete messages already in a trash-like folder (grouped by actual folder).
      if (toExpunge.length) {
        const byExpungeFolder = {};
        for (const msg of toExpunge) {
          (byExpungeFolder[msg.folder] = byExpungeFolder[msg.folder] || []).push(msg);
        }
        for (const [expungeFolder, folderMsgs] of Object.entries(byExpungeFolder)) {
          const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
          const { succeeded, failed } = await imapManager.bulkPermanentDelete(account, folderMsgs.map(m => m.uid), expungeFolder);
          for (const uid of succeeded) expungeSucceeded.push(uidToMsg.get(String(uid)));
          for (const uid of failed) console.error(`bulk-delete IMAP expunge uid ${uid} from ${expungeFolder}: IMAP delete failed`);
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
          const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(account, folderMsgs.map(m => m.uid), srcFolder, trashPath);
          for (const uid of succeeded) {
            trashMoveSucceeded.push({ msg: uidToMsg.get(String(uid)), trashPath, newUid: uidMap.get(Number(uid)) || null });
          }
          for (const uid of failed) console.error(`bulk-delete IMAP move uid ${uid}: IMAP move failed`);
        }
      }
    }

    // Permanently deleted: remove DB rows immediately.
    if (expungeSucceeded.length) {
      await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [expungeSucceeded.map(m => m.id)]);
    }

    // Trash moves: same CTE approach as bulk-move — DELETE source rows and
    // immediately re-INSERT at the destination when new UIDs are known.
    // Group by trashPath since different accounts may have different Trash folders.
    if (trashMoveSucceeded.length) {
      const byTrashPath = {};
      for (const u of trashMoveSucceeded) {
        (byTrashPath[u.trashPath] = byTrashPath[u.trashPath] || []).push(u);
      }
      for (const [trashPath, entries] of Object.entries(byTrashPath)) {
        const allIds    = entries.map(u => u.msg.id);
        const withUid   = entries.filter(u => u.newUid);
        await query(`
          WITH deleted AS (
            DELETE FROM messages WHERE id = ANY($1::uuid[]) RETURNING *
          ),
          uid_map(src_id, new_uid) AS (
            SELECT * FROM unnest($2::uuid[], $3::bigint[])
          )
          INSERT INTO messages (
            account_id, uid, folder, message_id, subject,
            from_name, from_email, to_addresses, cc_addresses,
            reply_to, in_reply_to, date, snippet, is_read, is_starred,
            has_attachments, flags, body_html, body_text, attachments,
            thread_references, thread_id, is_bulk,
            read_changed_at, star_changed_at, spam_score_sa, spam_score_ml,
            spam_verdict, spam_analyzed_at, spam_details, spam_user_override,
            category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at
          )
          SELECT
            d.account_id, u.new_uid, $4, d.message_id, d.subject,
            d.from_name, d.from_email, d.to_addresses, d.cc_addresses,
            d.reply_to, d.in_reply_to, d.date, d.snippet, d.is_read, d.is_starred,
            d.has_attachments, d.flags, d.body_html, d.body_text, d.attachments,
            d.thread_references, d.thread_id, d.is_bulk,
            d.read_changed_at, d.star_changed_at, d.spam_score_sa, d.spam_score_ml,
            d.spam_verdict, d.spam_analyzed_at, d.spam_details, d.spam_user_override,
            d.category, d.list_unsubscribe, d.list_unsubscribe_post, d.unsubscribed_at
          FROM deleted d
          JOIN uid_map u ON d.id = u.src_id
          ON CONFLICT (account_id, uid, folder) DO NOTHING
        `, [allIds, withUid.map(u => u.msg.id), withUid.map(u => u.newUid), trashPath]);
      }
      // Non-UIDPLUS trash moves were deleted with no reinsert; pull each affected
      // (account, trash folder) now so they reappear promptly instead of via IDLE.
      const needResync = new Map(); // accountId -> Set<trashPath>
      for (const u of trashMoveSucceeded) {
        if (u.newUid) continue;
        if (!needResync.has(u.msg.account_id)) needResync.set(u.msg.account_id, new Set());
        needResync.get(u.msg.account_id).add(u.trashPath);
      }
      for (const [acctId, paths] of needResync) {
        const acct = accountsById[acctId];
        if (!acct) continue;
        for (const tp of paths) {
          imapManager.syncFolderOnDemand(acct, tp)
            .catch(err => console.warn('post-trash destination sync failed:', err.message));
        }
      }
    }

    // Adjust cached folder counts.
    // Source folders always lose the message; Trash gains only for non-Trash moves.
    const allSucceeded = [
      ...expungeSucceeded.map(m => m.id),
      ...trashMoveSucceeded.map(u => u.msg.id),
    ];
    if (allSucceeded.length) {
      const srcDeltas = {};
      for (const msg of expungeSucceeded) {
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcDeltas[key]) srcDeltas[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcDeltas[key].total++;
        if (!msg.is_read) srcDeltas[key].unread++;
      }
      for (const { msg } of trashMoveSucceeded) {
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcDeltas[key]) srcDeltas[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcDeltas[key].total++;
        if (!msg.is_read) srcDeltas[key].unread++;
      }
      for (const { accountId, path, total, unread } of Object.values(srcDeltas)) {
        adjustFolderCounts(accountId, path, -total, -unread);
      }
      const dstDeltas = {};
      for (const { msg, trashPath } of trashMoveSucceeded) {
        const key = `${msg.account_id}:${trashPath}`;
        if (!dstDeltas[key]) dstDeltas[key] = { accountId: msg.account_id, path: trashPath, total: 0, unread: 0 };
        dstDeltas[key].total++;
        if (!msg.is_read) dstDeltas[key].unread++;
      }
      for (const { accountId, path, total, unread } of Object.values(dstDeltas)) {
        adjustFolderCounts(accountId, path, total, unread);
      }
      // Notify clients viewing each Trash folder to refresh silently.
      for (const { accountId, path } of Object.values(dstDeltas)) {
        imapManager.broadcast({ type: 'folder_updated', folder: path, accountId }, req.session.userId);
      }
    }

    // Refresh GTD section data for any deleted thread that still carries a GTD label sibling.
    emitGtdSectionsRefresh(owned, req.session.userId);

    res.json({ ok: true, deleted: allSucceeded });
  } catch (err) {
    console.error('bulk-delete error:', err);
    res.status(500).json({ error: 'Failed to delete messages' });
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
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

  const moveGuards = [];
  try {
    const result = await query(
      `SELECT m.*, a.user_id FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
      [req.session.userId, ids]
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
    const uidUpdates = [];
    const resyncAccounts = []; // accounts whose moved msgs lacked new UIDs (non-UIDPLUS)
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
      let accountMissingUid = false;
      for (const [srcFolder, folderMsgs] of Object.entries(byFolder)) {
        const uidToMsg = new Map(folderMsgs.map(m => [String(m.uid), m]));
        const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(account, folderMsgs.map(m => m.uid), srcFolder, folder);
        for (const uid of succeeded) {
          const msg = uidToMsg.get(String(uid));
          movedIds.push(msg.id);
          const newUid = uidMap.get(Number(uid)) || null;
          if (newUid) uidUpdates.push({ id: msg.id, newUid });
          else accountMissingUid = true;
        }
        for (const uid of failed) console.error(`bulk-move IMAP uid ${uid}: IMAP move failed`);
      }
      if (accountMissingUid) resyncAccounts.push(account);
    }

    if (movedIds.length > 0) {
      // DELETE source rows and, when we have UIDPLUS-provided new UIDs, immediately
      // re-INSERT at the destination in one atomic CTE statement. This avoids any
      // transient folder/uid state that could collide with existing rows (UIDs are
      // per-folder, so the same UID number is valid in two different folders).
      // If IMAP IDLE already inserted the destination row, ON CONFLICT DO NOTHING
      // keeps it intact. For messages without new UIDs the DELETE-only path relies
      // on IMAP IDLE + the message_id pre-check in processMsg to re-insert them.
      const uidUpdateMap = new Map(uidUpdates.map(u => [u.id, u.newUid]));
      const withNewUid   = movedIds.filter(id =>  uidUpdateMap.has(id));
      await query(`
        WITH deleted AS (
          DELETE FROM messages WHERE id = ANY($1::uuid[]) RETURNING *
        ),
        uid_map(src_id, new_uid) AS (
          SELECT * FROM unnest($2::uuid[], $3::bigint[])
        )
        INSERT INTO messages (
          account_id, uid, folder, message_id, subject,
          from_name, from_email, to_addresses, cc_addresses,
          reply_to, in_reply_to, date, snippet, is_read, is_starred,
          has_attachments, flags, body_html, body_text, attachments,
          thread_references, thread_id, is_bulk,
          read_changed_at, star_changed_at, spam_score_sa, spam_score_ml,
          spam_verdict, spam_analyzed_at, spam_details, spam_user_override,
          category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at
        )
        SELECT
          d.account_id, u.new_uid, $4, d.message_id, d.subject,
          d.from_name, d.from_email, d.to_addresses, d.cc_addresses,
          d.reply_to, d.in_reply_to, d.date, d.snippet, d.is_read, d.is_starred,
          d.has_attachments, d.flags, d.body_html, d.body_text, d.attachments,
          d.thread_references, d.thread_id, d.is_bulk,
          d.read_changed_at, d.star_changed_at, d.spam_score_sa, d.spam_score_ml,
          d.spam_verdict, d.spam_analyzed_at, d.spam_details, d.spam_user_override,
          d.category, d.list_unsubscribe, d.list_unsubscribe_post, d.unsubscribed_at
        FROM deleted d
        JOIN uid_map u ON d.id = u.src_id
        ON CONFLICT (account_id, uid, folder) DO NOTHING
      `, [movedIds, withNewUid, withNewUid.map(id => uidUpdateMap.get(id)), folder]);
      // Messages moved on a non-UIDPLUS server were deleted with no reinsert; pull the
      // destination folder now so they reappear promptly instead of waiting for IDLE.
      for (const acct of resyncAccounts) {
        imapManager.syncFolderOnDemand(acct, folder)
          .catch(err => console.warn('post-move destination sync failed:', err.message));
      }
      // Adjust cached counts: decrement source folders, increment the destination.
      const movedSet = new Set(movedIds);
      const srcTotals = {};
      for (const msg of owned) {
        if (!movedSet.has(msg.id)) continue;
        const key = `${msg.account_id}:${msg.folder}`;
        if (!srcTotals[key]) srcTotals[key] = { accountId: msg.account_id, path: msg.folder, total: 0, unread: 0 };
        srcTotals[key].total++;
        if (!msg.is_read) srcTotals[key].unread++;
      }
      for (const { accountId, path, total, unread } of Object.values(srcTotals)) {
        adjustFolderCounts(accountId, path, -total, -unread);
        adjustFolderCounts(accountId, folder, total, unread);
      }

      // Notify clients that the destination folder has new content so they
      // refresh without sounds or alerts (unlike new_messages).
      for (const accountId of Object.keys(srcTotals).map(k => k.split(':')[0])) {
        imapManager.broadcast({ type: 'folder_updated', folder, accountId }, req.session.userId);
      }
    }

    // Refresh GTD section data for any moved thread that still carries a GTD label sibling.
    emitGtdSectionsRefresh(owned, req.session.userId);

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

  const moveGuards = [];
  try {
    const result = await query(
      `SELECT m.*, a.user_id, a.folder_mappings FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
      [req.session.userId, ids]
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
        const { uidMap, succeeded, failed } = await imapManager.bulkMoveMessages(account, folderMsgs.map(m => m.uid), srcFolder, archiveFolder);
        for (const uid of succeeded) {
          const msg = uidToMsg.get(String(uid));
          archivedIds.push({ id: msg.id, accountId, folder: archiveFolder, newUid: uidMap.get(Number(uid)) || null });
        }
        for (const uid of failed) console.error(`bulk-archive IMAP uid ${uid}: IMAP move failed`);
      }
    }

    // Update DB: same CTE DELETE+INSERT pattern as bulk-move — except when the
    // destination is Gmail's All Mail, where the message just vanishes from our view
    // (see allMailDestFolders above), so a plain DELETE with no reinsert is correct.
    const byFolder = {};
    for (const { id, folder, newUid } of archivedIds) {
      (byFolder[folder] = byFolder[folder] || []).push({ id, newUid });
    }
    for (const [archiveFolder, entries] of Object.entries(byFolder)) {
      const allIds  = entries.map(e => e.id);
      if (allMailDestFolders.has(archiveFolder)) {
        await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [allIds]);
        continue;
      }
      const withUid = entries.filter(e => e.newUid != null);
      await query(`
        WITH deleted AS (
          DELETE FROM messages WHERE id = ANY($1::uuid[]) RETURNING *
        ),
        uid_map(src_id, new_uid) AS (
          SELECT * FROM unnest($2::uuid[], $3::bigint[])
        )
        INSERT INTO messages (
          account_id, uid, folder, message_id, subject,
          from_name, from_email, to_addresses, cc_addresses,
          reply_to, in_reply_to, date, snippet, is_read, is_starred,
          has_attachments, flags, body_html, body_text, attachments,
          thread_references, thread_id, is_bulk,
          read_changed_at, star_changed_at, spam_score_sa, spam_score_ml,
          spam_verdict, spam_analyzed_at, spam_details, spam_user_override,
          category, list_unsubscribe, list_unsubscribe_post, unsubscribed_at
        )
        SELECT
          d.account_id, u.new_uid, $4, d.message_id, d.subject,
          d.from_name, d.from_email, d.to_addresses, d.cc_addresses,
          d.reply_to, d.in_reply_to, d.date, d.snippet, d.is_read, d.is_starred,
          d.has_attachments, d.flags, d.body_html, d.body_text, d.attachments,
          d.thread_references, d.thread_id, d.is_bulk,
          d.read_changed_at, d.star_changed_at, d.spam_score_sa, d.spam_score_ml,
          d.spam_verdict, d.spam_analyzed_at, d.spam_details, d.spam_user_override,
          d.category, d.list_unsubscribe, d.list_unsubscribe_post, d.unsubscribed_at
        FROM deleted d
        JOIN uid_map u ON d.id = u.src_id
        ON CONFLICT (account_id, uid, folder) DO NOTHING
      `, [allIds, withUid.map(e => e.id), withUid.map(e => e.newUid), archiveFolder]);
    }

    // Non-UIDPLUS archive moves were deleted with no reinsert; pull each affected
    // (account, archive folder) now so they reappear promptly instead of via IDLE.
    const needResync = new Map(); // accountId -> Set<archiveFolder>
    for (const e of archivedIds) {
      if (e.newUid) continue;
      if (allMailDestFolders.has(e.folder)) continue; // no DB row there to keep fresh
      if (!needResync.has(e.accountId)) needResync.set(e.accountId, new Set());
      needResync.get(e.accountId).add(e.folder);
    }
    for (const [acctId, paths] of needResync) {
      const acct = accountsById[acctId];
      if (!acct) continue;
      for (const fp of paths) {
        imapManager.syncFolderOnDemand(acct, fp)
          .catch(err => console.warn('post-archive destination sync failed:', err.message));
      }
    }

    // Adjust cached folder counts: use signed deltas so source and dest share one pass.
    if (archivedIds.length > 0) {
      const idToArchiveDest = new Map(archivedIds.map(({ id, folder: dest }) => [id, dest]));
      const folderDeltas = {}; // key: `${accountId}:${path}` -> { accountId, path, totalDelta, unreadDelta }
      for (const msg of owned) {
        const dest = idToArchiveDest.get(msg.id);
        if (!dest) continue;
        const wasUnread = !msg.is_read ? 1 : 0;
        const srcKey = `${msg.account_id}:${msg.folder}`;
        if (!folderDeltas[srcKey]) folderDeltas[srcKey] = { accountId: msg.account_id, path: msg.folder, totalDelta: 0, unreadDelta: 0 };
        folderDeltas[srcKey].totalDelta--;
        folderDeltas[srcKey].unreadDelta -= wasUnread;
        if (allMailDestFolders.has(dest)) continue; // All Mail counts aren't tracked
        const dstKey = `${msg.account_id}:${dest}`;
        if (!folderDeltas[dstKey]) folderDeltas[dstKey] = { accountId: msg.account_id, path: dest, totalDelta: 0, unreadDelta: 0 };
        folderDeltas[dstKey].totalDelta++;
        folderDeltas[dstKey].unreadDelta += wasUnread;
      }
      for (const { accountId, path, totalDelta, unreadDelta } of Object.values(folderDeltas)) {
        adjustFolderCounts(accountId, path, totalDelta, unreadDelta);
      }
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
    emitGtdSectionsRefresh(owned, req.session.userId);

    res.json({ ok: true, archived: archivedIds.map(a => a.id), noArchiveFolder });
  } catch (err) {
    console.error('bulk-archive error:', err);
    res.status(500).json({ error: 'Failed to archive messages' });
  } finally {
    for (const g of moveGuards) imapManager._unguardMoveUid(g.accountId, g.folder, g.uid);
  }
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

  // Ownership check
  const msgResult = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON a.id = m.account_id
     WHERE m.id = $1 AND a.user_id = $2`,
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

  let snoozedUid;
  imapManager._guardMoveUid(msg.account_id, msg.folder, msg.uid);
  try {
    try {
      await imapManager.ensureFolder(account, snoozedFolder);
      snoozedUid = await imapManager.moveMessage(account, msg.uid, msg.folder, snoozedFolder);
    } catch (err) {
      console.error(`Snooze IMAP move failed for message ${id}:`, err.message);
      return res.status(500).json({ error: 'Failed to move message to Snoozed folder' });
    }
    if (snoozedUid != null) {
      await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [snoozedFolder, snoozedUid, id]);
    } else {
      imapManager._guardMoveUid(msg.account_id, snoozedFolder, msg.uid);
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [snoozedFolder, id]);
      setTimeout(() => imapManager._unguardMoveUid(msg.account_id, snoozedFolder, msg.uid), 10_000);
    }
  } finally {
    imapManager._unguardMoveUid(msg.account_id, msg.folder, msg.uid);
  }

  await query(
    `INSERT INTO snoozed_messages (user_id, account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.session.userId, msg.account_id, msg.message_id, msg.folder, untilDate.toISOString(), snoozedFolder]
  );

  adjustFolderCounts(msg.account_id, msg.folder, -1, msg.is_read ? 0 : -1);
  adjustFolderCounts(msg.account_id, snoozedFolder, 1, msg.is_read ? 0 : 1);

  // Refresh GTD section data if the snoozed message's thread carries a GTD label (its in_inbox flips).
  emitGtdSectionsRefresh([msg], req.session.userId);

  res.json({ ok: true });
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

// Helper: move a single message to a destination folder, update DB, log to
// training_log, and broadcast folder_updated. Shared between /spam and /ham.
async function moveForSpamLabel(messageId, userId, destinationFolder, label) {
  const result = await query(`
    SELECT m.*, a.user_id, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
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
      newUid = await imapManager.moveMessage(account, message.uid, message.folder, destinationFolder);
    } catch (err) {
      console.error(`IMAP move for /${label} failed:`, err.message);
      return { ok: false, status: 502, error: `IMAP move failed: ${err.message}` };
    }
    if (newUid != null) {
      await query('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3 AND id != $4',
        [account.id, newUid, destinationFolder, messageId]);
      await query(
        `UPDATE messages SET folder = $1, uid = $2,
            spam_user_override = $3, spam_verdict = $3, spam_analyzed_at = NOW()
         WHERE id = $4`,
        [destinationFolder, newUid, label, messageId]
      );
    } else {
      // Non-UIDPLUS server: DB holds the stale source UID at the destination.
      imapManager._guardMoveUid(account.id, destinationFolder, message.uid);
      await query(
        `UPDATE messages SET folder = $1,
            spam_user_override = $2, spam_verdict = $2, spam_analyzed_at = NOW()
         WHERE id = $3`,
        [destinationFolder, label, messageId]
      );
      setTimeout(() => imapManager._unguardMoveUid(account.id, destinationFolder, message.uid), 10_000);
    }
  } finally {
    imapManager._unguardMoveUid(account.id, message.folder, message.uid);
  }

  // Adjust cached folder counts.
  const wasUnread = !message.is_read ? 1 : 0;
  adjustFolderCounts(account.id, message.folder, -1, -wasUnread);
  adjustFolderCounts(account.id, destinationFolder, 1, wasUnread);

  // Training log: capture the decision for future model training.
  await query(
    `INSERT INTO spam_training_log
       (user_id, account_id, message_id_header, message_uid, folder, label, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
    [userId, account.id, message.message_id, message.uid, destinationFolder, label]
  );

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
  emitGtdSectionsRefresh([message], userId);

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
    WHERE m.id = $1 AND a.user_id = $2
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
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ counts: {} });

  const scopedIds = accountId && userAccountIds.includes(accountId)
    ? [accountId]
    : userAccountIds;

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

  const result = await query(
    `UPDATE messages SET category = $1
     FROM email_accounts a
     WHERE messages.id = $2
       AND messages.account_id = a.id
       AND a.user_id = $3
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

  const lookup = await query(`
    SELECT m.account_id, m.folder, a.folder_mappings FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
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
