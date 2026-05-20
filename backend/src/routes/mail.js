import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { sanitizeEmail, stripEmailHead, hasRemoteImages, blockRemoteImages, rewriteEbayImageserUrls } from '../services/emailSanitizer.js';
import { buildSnippetFromHtml, decodeNamedEntity } from '../services/messageParser.js';
import { resolveTrashFolder, resolveArchiveFolder, getDeleteStrategy } from '../utils/mailUtils.js';
import { listMessages } from '../services/messageService.js';

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
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[‪-‮⁦-⁩‏؜]/g, '')
    .trim()
    .substring(0, 255);
  return cleaned || 'attachment';
}

// Validate a folder name / path component: no control chars, max 255 chars.
function isValidFolderName(name) {
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

// Adjust cached folder row counts after local message mutations so that pagination
// totals stay accurate without waiting for the next IMAP sync. Fire-and-forget —
// errors are logged but never block the caller; sync will correct any discrepancy.
function adjustFolderCounts(accountId, path, totalDelta, unreadDelta) {
  if (totalDelta === 0 && unreadDelta === 0) return;
  query(
    `UPDATE folders
        SET total_count  = GREATEST(0, total_count  + $1),
            unread_count = GREATEST(0, unread_count + $2)
      WHERE account_id = $3 AND path = $4`,
    [totalDelta, unreadDelta, accountId, path]
  ).catch(err => console.error('Folder count adjust failed:', err.message));
}

// Regex matching invisible / zero-width / filler Unicode chars — kept in sync with
// the same constant in messageParser.js (must match the full set used there).
const INVISIBLE_CHARS_RE = new RegExp(
  [0x00AD, 0x034F, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
   0x2007, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF]
    .map(n => String.fromCodePoint(n)).join('|'),
  'g'
);

// Returns true if a snippet contains content that should never appear in plain-text
// preview, indicating it was generated from unclean HTML and needs regeneration:
//   - &entity; — undecoded HTML entities from before the entity-stripping fix
//   - ##marker## — unexpanded template placeholders (UPS, Epsilon marketing mail)
//   - --> — dangling HTML comment end leaked by comment-stripping gap
function snippetIsGarbled(s) {
  return s && (/&[a-z][a-z0-9]*;/i.test(s) || /##[^#]*##/.test(s) || /-->/.test(s));
}

// Extract a plain-text snippet from a message body for list previews.
// Delegates to the shared buildSnippetFromHtml for HTML bodies so both the
// sync path (messageParser) and the backfill/repair path (here) produce
// identical quality snippets.
function snippetFromBody(text, html) {
  if (text) {
    // Some senders embed HTML entities in text/plain parts as preheader fillers.
    return text
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-z][a-z0-9]*);/gi, decodeNamedEntity)
      .replace(INVISIBLE_CHARS_RE, '')
      .replace(/\s+/g, ' ').trim().substring(0, 200);
  }
  if (html) {
    return buildSnippetFromHtml(html);
  }
  return '';
}


// Get messages (unified or per-account/folder)
router.get('/messages', async (req, res) => {
  const { accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly, threaded } = req.query;

  const { messages, total, threaded: isThreaded, resolvedAccountId } = await listMessages({
    userId: req.session.userId,
    accountId,
    folder,
    limit,
    offset,
    unreadOnly,
    threaded,
  });

  if (resolvedAccountId && messages.length) {
    imapManager.prefetchFolderBodies(resolvedAccountId, messages.map(r => r.id))
      .catch(err => console.warn('Folder body prefetch error:', err.message));
  }

  res.json({ messages, total, ...(isThreaded ? { threaded: true } : {}) });
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

  const { folder } = req.query;

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ messages: [] });

  // Only restrict expansion to INBOX when viewing the INBOX — ensures the expansion
  // matches what the list shows. For All Mail and any other folder show all messages
  // regardless of which folder they were synced under (All Mail backfill is skipped so
  // not every message has a [Gmail]/All Mail row in the DB).
  const folderFilter = (folder === 'INBOX') ? `AND m.folder = $3` : '';
  const params = (folder === 'INBOX') ? [userAccountIds, threadId, folder] : [userAccountIds, threadId];

  const result = await query(`
    WITH deduped AS (
      SELECT DISTINCT ON (m.message_id)
             m.id, m.uid, m.folder, m.message_id, m.thread_id, m.subject,
             m.from_name, m.from_email, m.to_addresses, m.cc_addresses,
             m.reply_to, m.in_reply_to,
             m.date, m.snippet, m.is_read, m.is_starred,
             m.has_attachments, m.account_id,
             a.name AS account_name, a.email_address AS account_email, a.color AS account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.is_deleted = false
        AND m.account_id = ANY($1)
        AND m.thread_key = $2
        ${folderFilter}
      ORDER BY m.message_id,
               CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END,
               m.date ASC
    )
    SELECT * FROM deduped ORDER BY date ASC
  `, params);

  res.json({ messages: result.rows });
});

// Unread counts
router.get('/unread-counts', async (req, res) => {
  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ total: 0, byAccount: {} });

  const result = await query(`
    SELECT account_id, COALESCE(unread_count, 0) AS count
    FROM folders
    WHERE account_id = ANY($1) AND path = 'INBOX'
  `, [userAccountIds]);

  const byAccount = {};
  let total = 0;
  for (const row of result.rows) {
    byAccount[row.account_id] = parseInt(row.count);
    total += parseInt(row.count);
  }
  res.json({ total, byAccount });
});

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

    const { html, text, attachments } = await imapManager.fetchMessageBody(account, message.uid, message.folder);

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

    const headers = await imapManager.fetchHeaders(account, message.uid, message.folder);
    res.json({ headers });
  } catch (err) {
    console.error('Headers fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message headers' });
  }
});

// Download attachment
router.get('/messages/:id/attachments/:part', async (req, res) => {
  const { id, part } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  let partNum;
  try {
    partNum = decodeURIComponent(part);
  } catch (_) {
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
    SELECT m.*, a.user_id FROM messages m
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

  try {
    await imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Seen', read);
  } catch (err) {
    console.error('IMAP flag update failed:', err.message);
  }

  res.json({ ok: true, is_read: read });
});

// Star/unstar
router.patch('/messages/:id/star', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid message id' });
  const { starred } = req.body;

  const result = await query(`
    SELECT m.*, a.user_id FROM messages m
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

  try {
    await imapManager.setFlag(accountResult.rows[0], message.uid, message.folder, '\\Flagged', starred);
  } catch (err) {
    console.error('IMAP star update failed:', err.message);
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
  res.json({ ok: true });
  imapManager.broadcast({ type: 'sync_complete', accountId }, check.rows[0].user_id);
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
  res.json({ ok: true });
  imapManager.broadcast({ type: 'sync_complete', accountId }, check.rows[0].user_id);
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
      `SELECT m.id, m.uid, m.folder, m.is_read, m.account_id FROM messages m
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
        }
      });
    }

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

  try {
    const result = await query(
      `SELECT m.*, a.user_id, a.folder_mappings FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
      [req.session.userId, ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, deleted: [] });

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    // expungeSucceeded: permanently deleted (already in Trash, or no Trash folder on account).
    // trashMoveSucceeded: moved from a non-Trash folder into Trash.
    const expungeSucceeded = [];
    const trashMoveSucceeded = []; // { msg, trashPath, newUid }

    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const trashPath = await resolveTrashFolder(accountId, msgs[0].folder_mappings);

      if (!trashPath) {
        console.error(`bulk-delete: no Trash folder found for account ${accountId} — skipping ${msgs.length} messages`);
        continue;
      }

      const toExpunge = msgs.filter(m => m.folder === trashPath);
      const toMove    = msgs.filter(m => m.folder !== trashPath);

      // Permanently delete messages that are already in Trash.
      if (toExpunge.length) {
        const results = await runInBatches(
          toExpunge, 3,
          msg => imapManager.permanentDeleteMessage(account, msg.uid, msg.folder)
        );
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            expungeSucceeded.push(toExpunge[i]);
          } else {
            console.error(`bulk-delete IMAP expunge ${toExpunge[i].id}:`, r.reason.message);
          }
        });
      }

      // Move messages from non-Trash folders into Trash.
      if (toMove.length) {
        const results = await runInBatches(
          toMove, 3,
          msg => imapManager.moveMessage(account, msg.uid, msg.folder, trashPath)
        );
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            trashMoveSucceeded.push({ msg: toMove[i], trashPath, newUid: r.value || null });
          } else {
            console.error(`bulk-delete IMAP move ${toMove[i].id}:`, r.reason.message);
          }
        });
      }
    }

    // Permanently deleted: remove DB rows immediately.
    if (expungeSucceeded.length) {
      await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [expungeSucceeded.map(m => m.id)]);
    }

    // Trash moves: update folder, then UIDs where the server returned them.
    if (trashMoveSucceeded.length) {
      const byTrashPath = {};
      for (const u of trashMoveSucceeded) {
        (byTrashPath[u.trashPath] = byTrashPath[u.trashPath] || []).push(u);
      }
      for (const [trashPath, entries] of Object.entries(byTrashPath)) {
        await query(
          'UPDATE messages SET folder = $1 WHERE id = ANY($2::uuid[])',
          [trashPath, entries.map(e => e.msg.id)]
        );
      }
      const withNewUid = trashMoveSucceeded.filter(u => u.newUid);
      if (withNewUid.length) {
        // Remove any stale DB rows already sitting at (account_id, trashPath, newUid).
        // Moved messages still carry their source UID at this point, so they cannot
        // match the destination-folder/new-UID condition; the id exclusion is a
        // belt-and-suspenders guard for the degenerate uid==new_uid case.
        await query(
          `DELETE FROM messages
           WHERE (account_id, folder, uid) IN (
             SELECT v.acct, v.dest, v.uid
             FROM unnest($1::uuid[], $2::text[], $3::bigint[]) AS v(acct, dest, uid)
           )
           AND id != ANY($4::uuid[])`,
          [
            withNewUid.map(u => u.msg.account_id),
            withNewUid.map(u => u.trashPath),
            withNewUid.map(u => u.newUid),
            withNewUid.map(u => u.msg.id),
          ]
        );
        await query(
          `UPDATE messages SET uid = v.new_uid
           FROM unnest($1::uuid[], $2::bigint[]) AS v(id, new_uid)
           WHERE messages.id = v.id`,
          [withNewUid.map(u => u.msg.id), withNewUid.map(u => u.newUid)]
        );
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
    }

    res.json({ ok: true, deleted: allSucceeded });
  } catch (err) {
    console.error('bulk-delete error:', err);
    res.status(500).json({ error: 'Failed to delete messages' });
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

  try {
    const result = await query(
      `SELECT m.*, a.user_id FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
      [req.session.userId, ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, moved: [] });

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const movedIds = [];
    const uidUpdates = [];
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
      const results = await runInBatches(
        msgs, 3,
        msg => imapManager.moveMessage(account, msg.uid, msg.folder, folder)
      );
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          movedIds.push(msgs[i].id);
          if (r.value) uidUpdates.push({ id: msgs[i].id, newUid: r.value });
        } else {
          console.error(`bulk-move IMAP ${msgs[i].id}:`, r.reason.message);
        }
      });
    }

    if (movedIds.length > 0) {
      await query('UPDATE messages SET folder = $1 WHERE id = ANY($2::uuid[])', [folder, movedIds]);
      if (uidUpdates.length > 0) {
        const idToAccount = new Map(owned.map(m => [m.id, m.account_id]));
        await query(
          `DELETE FROM messages
           WHERE (account_id, folder, uid) IN (
             SELECT v.acct, v.dest, v.uid
             FROM unnest($1::uuid[], $2::text[], $3::bigint[]) AS v(acct, dest, uid)
           )
           AND id != ANY($4::uuid[])`,
          [
            uidUpdates.map(u => idToAccount.get(u.id)),
            uidUpdates.map(() => folder),
            uidUpdates.map(u => u.newUid),
            uidUpdates.map(u => u.id),
          ]
        );
        await query(
          `UPDATE messages SET uid = v.new_uid
           FROM unnest($1::uuid[], $2::bigint[]) AS v(id, new_uid)
           WHERE messages.id = v.id`,
          [uidUpdates.map(u => u.id), uidUpdates.map(u => u.newUid)]
        );
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
    }

    res.json({ ok: true, moved: movedIds });
  } catch (err) {
    console.error('bulk-move error:', err);
    res.status(500).json({ error: 'Failed to move messages' });
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

  try {
    const result = await query(
      `SELECT m.*, a.user_id, a.folder_mappings FROM messages m
       JOIN email_accounts a ON m.account_id = a.id
       WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
      [req.session.userId, ids]
    );

    const owned = result.rows;
    if (!owned.length) return res.json({ ok: true, archived: [], noArchiveFolder: [] });

    const byAccount = {};
    for (const msg of owned) {
      (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
    }

    const archivedIds = [];
    const noArchiveFolder = [];

    for (const [accountId, msgs] of Object.entries(byAccount)) {
      const archiveFolder = await resolveArchiveFolder(accountId, msgs[0].folder_mappings);
      if (!archiveFolder) {
        noArchiveFolder.push(accountId);
        continue;
      }

      const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      const account = accountResult.rows[0];
      const results = await runInBatches(
        msgs, 3,
        msg => imapManager.moveMessage(account, msg.uid, msg.folder, archiveFolder)
      );
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          archivedIds.push({ id: msgs[i].id, folder: archiveFolder, newUid: r.value || null });
        } else {
          console.error(`bulk-archive IMAP ${msgs[i].id}:`, r.reason.message);
        }
      });
    }

    // Update DB folder for successfully archived messages, grouped by destination
    const byFolder = {};
    for (const { id, folder, newUid } of archivedIds) {
      if (!byFolder[folder]) byFolder[folder] = [];
      byFolder[folder].push({ id, newUid });
    }
    const idToAccount = new Map(owned.map(m => [m.id, m.account_id]));
    for (const [folder, entries] of Object.entries(byFolder)) {
      const folderIds = entries.map(e => e.id);
      await query('UPDATE messages SET folder = $1 WHERE id = ANY($2::uuid[])', [folder, folderIds]);
      const withNewUid = entries.filter(e => e.newUid != null);
      if (withNewUid.length > 0) {
        await query(
          `DELETE FROM messages
           WHERE (account_id, folder, uid) IN (
             SELECT v.acct, v.dest, v.uid
             FROM unnest($1::uuid[], $2::text[], $3::bigint[]) AS v(acct, dest, uid)
           )
           AND id != ANY($4::uuid[])`,
          [
            withNewUid.map(e => idToAccount.get(e.id)),
            withNewUid.map(() => folder),
            withNewUid.map(e => e.newUid),
            withNewUid.map(e => e.id),
          ]
        );
        await query(
          `UPDATE messages SET uid = v.new_uid
           FROM unnest($1::uuid[], $2::bigint[]) AS v(id, new_uid)
           WHERE messages.id = v.id`,
          [withNewUid.map(e => e.id), withNewUid.map(e => e.newUid)]
        );
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
        const dstKey = `${msg.account_id}:${dest}`;
        if (!folderDeltas[dstKey]) folderDeltas[dstKey] = { accountId: msg.account_id, path: dest, totalDelta: 0, unreadDelta: 0 };
        folderDeltas[dstKey].totalDelta++;
        folderDeltas[dstKey].unreadDelta += wasUnread;
      }
      for (const { accountId, path, totalDelta, unreadDelta } of Object.values(folderDeltas)) {
        adjustFolderCounts(accountId, path, totalDelta, unreadDelta);
      }
    }

    res.json({ ok: true, archived: archivedIds.map(a => a.id), noArchiveFolder });
  } catch (err) {
    console.error('bulk-archive error:', err);
    res.status(500).json({ error: 'Failed to archive messages' });
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

  let snoozedUid = null;
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
    await query('UPDATE messages SET folder = $1 WHERE id = $2', [snoozedFolder, id]);
  }

  await query(
    `INSERT INTO snoozed_messages (user_id, account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.session.userId, msg.account_id, msg.message_id, msg.folder, untilDate.toISOString(), snoozedFolder]
  );

  adjustFolderCounts(msg.account_id, msg.folder, -1, msg.is_read ? 0 : -1);
  adjustFolderCounts(msg.account_id, snoozedFolder, 1, msg.is_read ? 0 : 1);

  res.json({ ok: true });
});

// Delete (move to trash)
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
  const trashPath = await resolveTrashFolder(message.account_id, account.folder_mappings);
  const strategy = getDeleteStrategy(message.folder, trashPath);
  const wasUnread = !message.is_read ? 1 : 0;

  if (strategy.action === 'no_trash') {
    return res.status(422).json({ error: 'No Trash folder configured for this account' });
  }

  if (strategy.action === 'move') {
    // Move to Trash.
    let newUid = null;
    try {
      newUid = await imapManager.moveMessage(account, message.uid, message.folder, trashPath);
    } catch (err) {
      console.error('IMAP move to trash failed:', err.message);
      return res.status(500).json({ error: 'Failed to delete message' });
    }
    if (newUid != null) {
      await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [trashPath, newUid, id]);
    } else {
      await query('UPDATE messages SET folder = $1 WHERE id = $2', [trashPath, id]);
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
  res.json({ ok: true });
});

export default router;
