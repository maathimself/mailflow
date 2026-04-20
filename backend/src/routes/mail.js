import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import sanitizeHtml from 'sanitize-html';

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

// Extract a plain-text snippet from a message body for list previews.
// Prefers plain text; strips HTML tags from html-only bodies.
function snippetFromBody(text, html) {
  if (text) {
    return text.replace(/\s+/g, ' ').trim().substring(0, 200);
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
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
  }
  return '';
}

// Sanitize HTML email body — permissive but safe
function sanitizeEmail(html) {
  return sanitizeHtml(html, {
    allowVulnerableTags: true,
    allowedTags: [
      'html','head','body','div','span','p','br','hr',
      'h1','h2','h3','h4','h5','h6',
      'ul','ol','li','dl','dt','dd',
      'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
      'a','img','figure','figcaption',
      'strong','b','em','i','u','s','del','ins','sub','sup','small','big',
      'blockquote','pre','code','tt','kbd','samp',
      'center','font','strike',
      'style',
    ],
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'align', 'valign', 'width', 'height',
             'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing',
             'colspan', 'rowspan', 'nowrap', 'dir', 'lang'],
      'a': ['href', 'name', 'target', 'title'],
      'img': ['src', 'alt', 'width', 'height', 'border'],
      'table': ['summary'],
      'td': ['abbr', 'axis', 'headers', 'scope'],
      'th': ['abbr', 'axis', 'headers', 'scope'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
    },
    // Don't strip unknown tags entirely — preserve structure
    disallowedTagsMode: 'discard',
  });
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
  const countResult = await query(`SELECT COUNT(*) FROM messages m WHERE ${where}`, values);

  values.push(parseInt(limit));
  values.push(parseInt(offset));

  const result = await query(`
    SELECT m.id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
           m.to_addresses, m.date, m.snippet, m.is_read, m.is_starred,
           m.has_attachments, m.account_id,
           a.name as account_name, a.email_address as account_email, a.color as account_color
    FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE ${where}
    ORDER BY m.date DESC
    LIMIT $${p++} OFFSET $${p++}
  `, values);

  res.json({ messages: result.rows, total: parseInt(countResult.rows[0].count) });
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
    SELECT m.*, a.user_id FROM messages m
    JOIN email_accounts a ON m.account_id = a.id
    WHERE m.id = $1 AND a.user_id = $2
  `, [id, req.session.userId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
  const message = result.rows[0];

  // Return cached body if available — but re-fetch when the cached HTML still
  // contains unresolved cid: references (inline images cached before CID resolution
  // was added, or emails where image parts weren't fetched during the initial sync).
  const hasCidRefs = message.body_html && /\bcid:/i.test(message.body_html);
  if ((message.body_html || message.body_text) && !hasCidRefs) {
    const attachments = message.attachments
      ? (typeof message.attachments === 'string' ? JSON.parse(message.attachments) : message.attachments)
      : [];
    // Backfill snippet for messages that have a body cached but no snippet yet
    if (!message.snippet) {
      const snip = snippetFromBody(message.body_text, message.body_html);
      if (snip) {
        query('UPDATE messages SET snippet = $1 WHERE id = $2 AND (snippet IS NULL OR snippet = \'\')',
          [snip, id]).catch(() => {});
      }
    }
    return res.json({ html: message.body_html, text: message.body_text, attachments });
  }

  // Fetch from IMAP
  try {
    const accountResult = await query('SELECT * FROM email_accounts WHERE id = $1', [message.account_id]);
    const account = accountResult.rows[0];

    const { html, text, attachments } = await imapManager.fetchMessageBody(account, message.uid, message.folder);

    const safeHtml = html ? sanitizeEmail(html) : null;
    const snip = snippetFromBody(text, safeHtml || html);

    // Cache body + backfill snippet
    await query(
      `UPDATE messages
       SET body_html = $1, body_text = $2, attachments = $3,
           snippet = CASE WHEN snippet IS NULL OR snippet = '' THEN $5 ELSE snippet END
       WHERE id = $4`,
      [safeHtml, text, JSON.stringify(attachments || []), id, snip]
    );

    res.json({ html: safeHtml, text, attachments: attachments || [] });
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
