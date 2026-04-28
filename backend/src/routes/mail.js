import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { sanitizeEmail, stripEmailHead, hasRemoteImages, blockRemoteImages, rewriteEbayImageserUrls } from '../services/emailSanitizer.js';

const router = Router();
router.use(requireAuth);

// Sanitize an attachment filename for use in Content-Disposition.
// Strips path separators and control characters; falls back to 'attachment'.
function safeFilename(name) {
  if (!name) return 'attachment';
  const cleaned = String(name).replace(/[/\\]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned || 'attachment';
}

// Validate a folder name / path component: no control chars, max 255 chars.
function isValidFolderName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
}

// Regex matching zero-width and invisible Unicode chars that corrupt preview snippets.
// Built from code points to avoid embedding invisible characters in source.
const INVISIBLE_CHARS_RE = new RegExp(
  [0x00AD, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0xFEFF]
    .map(n => String.fromCodePoint(n)).join('|'),
  'g'
);

// Returns true if a snippet contains undecoded HTML entities (&zwnj; &shy; etc.)
// that indicate it was generated before the entity-stripping fix and needs refresh.
function snippetIsGarbled(s) {
  return s && /&[a-z][a-z0-9]*;/i.test(s);
}

// Extract a plain-text snippet from a message body for list previews.
// Prefers plain text; strips HTML tags from html-only bodies.
function snippetFromBody(text, html) {
  if (text) {
    // Apply entity stripping to the plain-text path too — some senders
    // (marketing tools, broken generators) embed HTML entities in text/plain parts.
    return text
      .replace(/&[a-z][a-z0-9]*;/gi, ' ')
      .replace(INVISIBLE_CHARS_RE, '')
      .replace(/\s+/g, ' ').trim().substring(0, 200);
  }
  if (html) {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      // Catch-all: any remaining named HTML entities (&zwnj; &shy; &hellip; etc.)
      .replace(/&[a-z][a-z0-9]*;/gi, ' ')
      .replace(INVISIBLE_CHARS_RE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
  }
  return '';
}


// Get messages (unified or per-account/folder)
router.get('/messages', async (req, res) => {
  const { accountId, folder = 'INBOX', limit = 50, offset = 0, unreadOnly } = req.query;

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ messages: [], total: 0 });

  let whereConditions = ['m.is_deleted = false'];
  const values = [];
  let p = 1;

  if (accountId && userAccountIds.includes(accountId)) {
    whereConditions.push(`m.account_id = $${p++}`);
    values.push(accountId);
    whereConditions.push(`m.folder = $${p++}`);
    values.push(folder);
  } else {
    whereConditions.push(`m.account_id = ANY($${p++})`);
    values.push(userAccountIds);
    whereConditions.push(`m.folder = 'INBOX'`);
  }

  if (unreadOnly === 'true') whereConditions.push('m.is_read = false');

  const where = whereConditions.join(' AND ');

  // Use cached counts from the folders table instead of an expensive COUNT(*).
  // These are kept current by the sync process and are accurate within one sync cycle.
  let total = 0;
  try {
    if (accountId && userAccountIds.includes(accountId)) {
      const r = await query(
        'SELECT total_count, unread_count FROM folders WHERE account_id = $1 AND path = $2',
        [accountId, folder]
      );
      if (r.rows.length) {
        total = unreadOnly === 'true' ? (r.rows[0].unread_count ?? 0) : (r.rows[0].total_count ?? 0);
      }
    } else {
      // Unified inbox: sum INBOX counts across all enabled accounts
      const r = unreadOnly === 'true'
        ? await query(
            "SELECT COALESCE(SUM(unread_count), 0)::int AS n FROM folders WHERE account_id = ANY($1) AND path = 'INBOX'",
            [userAccountIds]
          )
        : await query(
            "SELECT COALESCE(SUM(total_count), 0)::int AS n FROM folders WHERE account_id = ANY($1) AND path = 'INBOX'",
            [userAccountIds]
          );
      total = r.rows[0]?.n ?? 0;
    }
  } catch (_) {
    total = 0;
  }

  values.push(Math.min(Math.max(parseInt(limit) || 50, 1), 200));
  values.push(Math.max(parseInt(offset) || 0, 0));

  const result = await query(`
    SELECT m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
           m.to_addresses, m.cc_addresses, m.reply_to, m.in_reply_to,
           m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id,
           a.name as account_name, a.email_address as account_email, a.color as account_color
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT $${p++} OFFSET $${p++}
  `, values);

  res.json({ messages: result.rows, total });
});

// Returns true if remote images should be blocked for this message given the user's preferences.
// Default behaviour (no preference set) is to block.
function shouldBlockImages(prefs, message) {
  if (prefs?.blockRemoteImages === false) return false;
  const senderEmail = (message.from_email || '').toLowerCase();
  const atIdx = senderEmail.indexOf('@');
  const senderDomain = atIdx >= 0 ? senderEmail.slice(atIdx + 1) : '';
  const whitelist = prefs?.imageWhitelist || {};
  const allowedAddresses = (whitelist.addresses || []).map(a => a.toLowerCase());
  const allowedDomains   = (whitelist.domains   || []).map(d => d.toLowerCase());
  if (senderEmail && allowedAddresses.includes(senderEmail)) return false;
  if (senderDomain && allowedDomains.includes(senderDomain)) return false;
  return true;
}

// Unread counts
router.get('/unread-counts', async (req, res) => {
  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ total: 0, byAccount: {} });

  const result = await query(`
    SELECT account_id, COUNT(*) as count
    FROM messages
    WHERE account_id = ANY($1) AND is_read = false AND is_deleted = false AND folder = 'INBOX'
    GROUP BY account_id
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
      query('UPDATE messages SET body_html = $1 WHERE id = $2', [html, id]).catch(() => {});
    }
    // Rewrite eBay imageser URLs to direct image URLs for emails cached before this fix.
    // imageser requires eBay session cookies (never sent cross-site) and returns 1 byte
    // without them; the real image is always in the `imageUrl` query parameter.
    if (html && html.includes('svcs.ebay.com/imageser')) {
      const rewritten = rewriteEbayImageserUrls(html);
      if (rewritten !== html) {
        html = rewritten;
        query('UPDATE messages SET body_html = $1 WHERE id = $2', [html, id]).catch(() => {});
      }
    }
    // Backfill snippet when absent, or regenerate if garbled (undecoded HTML entities
    // from before the entity-stripping fix — e.g. "&zwnj;" in preview text).
    if (!message.snippet || snippetIsGarbled(message.snippet)) {
      const snip = snippetFromBody(message.body_text, html);
      if (snip) {
        query('UPDATE messages SET snippet = $1 WHERE id = $2', [snip, id]).catch(() => {});
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

  // Fetch from IMAP
  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];

    const { html, text, attachments } = await imapManager.fetchMessageBody(account, message.uid, message.folder);

    const safeHtml = html ? sanitizeEmail(html) : null;
    const snip = snippetFromBody(text, safeHtml || html);

    // Only cache when we actually got body content — don't overwrite a prior
    // successful cache with null if a transient IMAP fetch returns nothing.
    if (safeHtml || text || (attachments && attachments.length > 0)) {
      await query(
        `UPDATE messages
         SET body_html = $1, body_text = $2, attachments = $3,
             snippet = CASE WHEN snippet IS NULL OR snippet = '' THEN $5 ELSE snippet END
         WHERE id = $4`,
        [safeHtml, text, JSON.stringify(attachments || []), id, snip]
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
    res.json({ html: responseHtml, text, attachments: attachments || [], hasBlockedRemoteImages });
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
    console.error('Headers fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Download attachment
router.get('/messages/:id/attachments/:part', async (req, res) => {
  const { id, part } = req.params;
  const partNum = decodeURIComponent(part);

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

  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const buffer = await imapManager.fetchAttachment(accountResult.rows[0], message.uid, message.folder, partNum);

    if (!buffer) return res.status(404).json({ error: 'Could not fetch attachment' });

    const safe = safeFilename(att.filename);
    const encoded = encodeURIComponent(att.filename || 'attachment');
    res.setHeader('Content-Type', att.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Attachment fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Mark read/unread
router.patch('/messages/:id/read', async (req, res) => {
  const { id } = req.params;
  const { read } = req.body;

  const result = await query(`
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  await query('UPDATE messages SET is_read = $1 WHERE id = $2', [read, id]);

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
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
  const { starred } = req.body;

  const result = await query(`
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  await query('UPDATE messages SET is_starred = $1 WHERE id = $2', [starred, id]);

  const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
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
  const check = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });
  await query('UPDATE messages SET is_read = true WHERE account_id = $1 AND folder = $2', [accountId, folder]);
  // Also update IMAP so the change survives the next sync (non-fatal if it fails)
  imapManager.markAllReadImap(check.rows[0], folder).catch(err =>
    console.warn('markAllReadImap failed:', err.message)
  );
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
    res.status(500).json({ error: err.message });
  }
});

// Delete folder
router.post('/folders/delete', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    await imapManager.deleteFolder(check.rows[0], path);
  } catch (err) {
    console.warn(`IMAP deleteFolder warning for ${path}:`, err.message);
    // Continue — remove from DB even if IMAP fails
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
    res.status(500).json({ error: err.message });
  }
});

// Empty folder (delete all messages)
router.post('/folders/empty', async (req, res) => {
  const { accountId, path } = req.body;
  if (!accountId || !path) return res.status(400).json({ error: 'accountId and path required' });
  const check = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    await imapManager.emptyFolder(check.rows[0], path);
  } catch (err) {
    console.warn(`IMAP emptyFolder warning for ${path}:`, err.message);
    // Continue — clean up DB regardless
  }
  await query('DELETE FROM messages WHERE account_id = $1 AND folder = $2', [accountId, path]);
  res.json({ ok: true });
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

  const result = await query(
    `SELECT m.*, a.user_id FROM messages m
     JOIN email_accounts a ON m.account_id = a.id
     WHERE m.id = ANY($2::uuid[]) AND a.user_id = $1`,
    [req.session.userId, ids]
  );

  const owned = result.rows;
  if (!owned.length) return res.json({ ok: true, deleted: [] });

  const ownedIds = owned.map(m => m.id);
  await query('UPDATE messages SET is_deleted = true WHERE id = ANY($1::uuid[])', [ownedIds]);

  // Group by account_id then move each group to trash (best-effort, fire-and-forget)
  const byAccount = {};
  for (const msg of owned) {
    (byAccount[msg.account_id] = byAccount[msg.account_id] || []).push(msg);
  }
  for (const [accountId, msgs] of Object.entries(byAccount)) {
    const trash = await query(
      `SELECT path FROM folders WHERE account_id = $1 AND (special_use = '\\Trash' OR lower(name) LIKE '%trash%') LIMIT 1`,
      [accountId]
    );
    if (!trash.rows.length) continue;
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    const account = accountResult.rows[0];
    for (const msg of msgs) {
      imapManager.moveMessage(account, msg.uid, msg.folder, trash.rows[0].path)
        .catch(err => console.error(`bulk-delete IMAP move ${msg.id}:`, err.message));
    }
  }

  res.json({ ok: true, deleted: ownedIds });
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
    for (const msg of msgs) {
      try {
        await imapManager.moveMessage(account, msg.uid, msg.folder, folder);
        movedIds.push(msg.id);
      } catch (err) {
        console.error(`bulk-move IMAP ${msg.id}:`, err.message);
      }
    }
  }

  if (movedIds.length > 0) {
    await query('UPDATE messages SET folder = $1 WHERE id = ANY($2::uuid[])', [folder, movedIds]);
  }

  res.json({ ok: true, moved: movedIds });
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
    // Resolve archive folder: explicit mapping > special_use > name heuristic
    let archiveFolder = msgs[0].folder_mappings?.archive || null;
    if (!archiveFolder) {
      const folderResult = await query(
        `SELECT path FROM folders WHERE account_id = $1
         AND (special_use = '\\Archive' OR lower(name) LIKE '%archive%') LIMIT 1`,
        [accountId]
      );
      archiveFolder = folderResult.rows[0]?.path || null;
    }
    if (!archiveFolder) {
      noArchiveFolder.push(accountId);
      continue;
    }

    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    const account = accountResult.rows[0];
    for (const msg of msgs) {
      try {
        await imapManager.moveMessage(account, msg.uid, msg.folder, archiveFolder);
        archivedIds.push({ id: msg.id, folder: archiveFolder });
      } catch (err) {
        console.error(`bulk-archive IMAP ${msg.id}:`, err.message);
      }
    }
  }

  // Update DB folder for successfully archived messages, grouped by destination
  const byFolder = {};
  for (const { id, folder } of archivedIds) {
    (byFolder[folder] = byFolder[folder] || []).push(id);
  }
  for (const [folder, folderIds] of Object.entries(byFolder)) {
    await query('UPDATE messages SET folder = $1 WHERE id = ANY($2::uuid[])', [folder, folderIds]);
  }

  res.json({ ok: true, archived: archivedIds.map(a => a.id), noArchiveFolder });
});

// Delete (move to trash)
router.delete('/messages/:id', async (req, res) => {
  const { id } = req.params;

  const result = await query(`
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  await query('UPDATE messages SET is_deleted = true WHERE id = $1', [id]);

  const trashFolder = await query(`
    SELECT path FROM folders
    WHERE account_id = $1 AND (special_use = '\\Trash' OR lower(name) LIKE '%trash%')
    LIMIT 1
  `, [message.account_id]);

  if (trashFolder.rows.length) {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    try {
      await imapManager.moveMessage(accountResult.rows[0], message.uid, message.folder, trashFolder.rows[0].path);
    } catch (err) {
      console.error('IMAP move failed:', err.message);
    }
  }

  res.json({ ok: true });
});

export default router;
