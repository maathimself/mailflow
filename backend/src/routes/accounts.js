import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { encrypt } from '../services/encryption.js';
import { sanitizeSignature } from '../services/emailSanitizer.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { invalidateGtdConfigCache, sanitizeGtdFoldersDetailed, findGtdFolderCollisions, DEFAULT_GTD_FOLDERS } from '../services/gtdConfig.js';
import { createKeyedSerializer } from '../utils/keyedSerializer.js';

// Serialize an account's reconnect triggers so a rapid settings change (e.g. a
// gtd_enabled double-toggle) can't fire two overlapping disconnect→connect chains —
// connectAccount's in-progress guard would drop the second and leave the GTD sync
// tick armed inconsistently with the final DB value. Queued per account id.
const reconnectQueue = createKeyedSerializer();

const ALLOWED_IMAP_PORTS = new Set([143, 993]);
const ALLOWED_SMTP_PORTS = new Set([465, 587]);

function validatePort(port, allowed) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return `Port ${port} is not a valid port number`;
  }
  // When private/local hosts are explicitly allowed (e.g. Proton Mail Bridge on 1143/1025),
  // skip the whitelist — the operator has already opted into unrestricted host access.
  if (process.env.ALLOW_PRIVATE_IMAP_HOSTS === 'true') return null;
  if (!allowed.has(n)) {
    return `Port ${port} is not allowed. Allowed: ${[...allowed].join(', ')}`;
  }
  return null;
}

// Reject strings that contain characters that could inject extra email headers.
function hasHeaderInjectionChars(str) {
  return typeof str === 'string' && /[\r\n\0]/.test(str);
}

const router = Router();
router.use(requireAuth);

// Fields safe to return to the client — matches the GET list, excludes credentials and tokens
const SAFE_FIELDS = [
  'id', 'name', 'sender_name', 'email_address', 'color', 'protocol',
  'imap_host', 'imap_port', 'imap_skip_tls_verify',
  'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_user', 'oauth_provider', 'enabled',
  'last_sync', 'sync_error', 'sort_order', 'folder_mappings',
  'signature', 'created_at', 'categorization_enabled',
  'gtd_enabled', 'gtd_folders',
];
function safeAccount(row) {
  const obj = Object.fromEntries(SAFE_FIELDS.map(k => [k, row[k]]));
  // Sanitize on read so legacy values stored before the write-time sanitizer are safe
  if (obj.signature) obj.signature = sanitizeSignature(obj.signature);
  return obj;
}

router.get('/', async (req, res) => {
  const result = await query(
    `SELECT id, name, sender_name, email_address, color, protocol, imap_host, imap_port, imap_tls, imap_skip_tls_verify,
            smtp_host, smtp_port, smtp_tls, auth_user, oauth_provider, enabled,
            last_sync, sync_error, sort_order, folder_mappings, signature, created_at,
            categorization_enabled, gtd_enabled, gtd_folders
     FROM email_accounts WHERE user_id = $1 ORDER BY sort_order, created_at`,
    [req.session.userId]
  );

  // Attach aliases to each account in one query
  const accountIds = result.rows.map(a => a.id);
  let aliasMap = {};
  if (accountIds.length) {
    const aliasResult = await query(
      `SELECT id, account_id, name, email, reply_to, signature, created_at
       FROM account_aliases WHERE account_id = ANY($1) ORDER BY created_at`,
      [accountIds]
    );
    for (const alias of aliasResult.rows) {
      if (!aliasMap[alias.account_id]) aliasMap[alias.account_id] = [];
      aliasMap[alias.account_id].push(alias);
    }
  }

  res.json(result.rows.map(a => ({
    ...a,
    signature: a.signature ? sanitizeSignature(a.signature) : a.signature,
    aliases: (aliasMap[a.id] || []).map(alias => ({
      ...alias,
      signature: alias.signature ? sanitizeSignature(alias.signature) : alias.signature,
    })),
  })));
});

router.post('/', async (req, res) => {
  const {
    name, sender_name = null, email_address, color = '#6366f1', protocol = 'imap',
    imap_host, imap_port = 993, imap_skip_tls_verify = false,
    smtp_host, smtp_port = 587, smtp_tls = 'STARTTLS',
    auth_user, auth_pass,
    oauth_provider, oauth_access_token, oauth_refresh_token,
    signature = null
  } = req.body;

  if (!name || !email_address) return res.status(400).json({ error: 'Name and email required' });
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email_address)) {
    return res.status(400).json({ error: 'Name and email address cannot contain control characters' });
  }
  if (sender_name && hasHeaderInjectionChars(sender_name)) {
    return res.status(400).json({ error: 'Sender name cannot contain control characters' });
  }

  const policy = await getConnectionPolicy();

  if (imap_host) {
    const err = (await validateHost(imap_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(imap_port, ALLOWED_IMAP_PORTS));
    if (err) return res.status(400).json({ error: `IMAP: ${err}` });
  }
  if (smtp_host) {
    const err = (await validateHost(smtp_host, { allowPrivate: policy.allowPrivateHosts }))
      || (!policy.allowNonstandardPorts && validatePort(smtp_port, ALLOWED_SMTP_PORTS));
    if (err) return res.status(400).json({ error: `SMTP: ${err}` });
  }

  try {
    const result = await query(`
      INSERT INTO email_accounts (
        user_id, name, sender_name, email_address, color, protocol,
        imap_host, imap_port, imap_tls, imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
        auth_user, auth_pass, oauth_provider, oauth_access_token, oauth_refresh_token,
        signature
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *
    `, [
      req.session.userId, name, sender_name || null, email_address, color, protocol,
      imap_host, imap_port, Number(imap_port) % 1000 === 993, !!imap_skip_tls_verify, smtp_host, smtp_port, smtp_tls,
      auth_user, encrypt(auth_pass), oauth_provider, encrypt(oauth_access_token), encrypt(oauth_refresh_token),
      sanitizeSignature(signature) || null
    ]);

    const account = result.rows[0];

    // Immediately try to connect — needs full credentials from DB row
    if (protocol === 'imap') {
      imapManager.connectAccount(account).catch(console.error);
    }

    res.json(safeAccount(account));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add account' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  // Verify ownership. gtd_folders comes back too so a folder remap can be compared
  // against the stored value below (a change must reconnect to backfill the new folder).
  const check = await query('SELECT id, gtd_folders FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  if ('name' in updates && hasHeaderInjectionChars(updates.name)) {
    return res.status(400).json({ error: 'Name cannot contain control characters' });
  }
  if ('sender_name' in updates && updates.sender_name && hasHeaderInjectionChars(updates.sender_name)) {
    return res.status(400).json({ error: 'Sender name cannot contain control characters' });
  }
  const policy = await getConnectionPolicy();

  if ('imap_host' in updates && updates.imap_host) {
    const err = await validateHost(updates.imap_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return res.status(400).json({ error: `IMAP: ${err}` });
  }
  if ('imap_port' in updates && updates.imap_port !== undefined && updates.imap_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.imap_port, ALLOWED_IMAP_PORTS);
      if (err) return res.status(400).json({ error: `IMAP: ${err}` });
    }
  }
  if ('smtp_host' in updates && updates.smtp_host) {
    const err = await validateHost(updates.smtp_host, { allowPrivate: policy.allowPrivateHosts });
    if (err) return res.status(400).json({ error: `SMTP: ${err}` });
  }
  if ('smtp_port' in updates && updates.smtp_port !== undefined && updates.smtp_port !== null) {
    if (!policy.allowNonstandardPorts) {
      const err = validatePort(updates.smtp_port, ALLOWED_SMTP_PORTS);
      if (err) return res.status(400).json({ error: `SMTP: ${err}` });
    }
  }

  if ('imap_port' in updates) updates.imap_tls = Number(updates.imap_port) % 1000 === 993;

  // Sanitize + validate GTD folder overrides up front so a folder collision or an
  // over-long/traversal path is caught before we touch the DB. Collisions (two states
  // resolving to one folder) are rejected outright; over-long/traversal values fall
  // back to defaults and are reported to the client so the settings UI can flag them.
  let gtdFoldersValue;
  let gtdRejected = [];
  let gtdFoldersChanged = false;
  if ('gtd_folders' in updates) {
    const { folders, rejected, reserved } = sanitizeGtdFoldersDetailed(updates.gtd_folders);
    // A state mapped onto a live system folder (INBOX, Sent, …) is a hard error: /done would
    // permanently delete that folder's real mail. Reject before any DB write.
    if (reserved.length) {
      return res.status(400).json({ error: 'A GTD state cannot map to a reserved system folder', reserved });
    }
    const collisions = findGtdFolderCollisions({ ...DEFAULT_GTD_FOLDERS, ...folders });
    if (collisions.length) {
      return res.status(400).json({ error: 'Two GTD states cannot map to the same folder', collisions });
    }
    gtdFoldersValue = folders;
    gtdRejected = rejected;
    // Did the overrides actually change? Sanitize both sides through the same function so
    // key order is canonical, then compare. Only a real change forces a reconnect below.
    const before = sanitizeGtdFoldersDetailed(check.rows[0].gtd_folders).folders;
    gtdFoldersChanged = JSON.stringify(before) !== JSON.stringify(folders);
  }

  const allowed = ['name', 'sender_name', 'color', 'enabled', 'auth_user', 'auth_pass', 'sort_order', 'imap_host', 'imap_port', 'imap_tls', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls', 'folder_mappings', 'signature', 'categorization_enabled', 'gtd_enabled', 'gtd_folders'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = $${i++}`);
      const value = (key === 'auth_pass' && updates[key]) ? encrypt(updates[key])
        : (key === 'signature') ? sanitizeSignature(updates[key]) || null
        : (key === 'gtd_enabled') ? !!updates[key]
        : (key === 'gtd_folders') ? gtdFoldersValue
        : updates[key];
      values.push(value);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  const result = await query(
    `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  const updated = result.rows[0];
  const payload = safeAccount(updated);
  // Tell the client which submitted folder values were rejected (over-long /
  // traversal) and reset to defaults, so the settings form can surface it.
  if ('gtd_folders' in updates) payload.gtd_folders_rejected = gtdRejected;
  res.json(payload);

  // A GTD config change must drop the cached { enabled, folders } so the tick,
  // transition engine, and classify routes read the new value immediately.
  if ('gtd_enabled' in updates || 'gtd_folders' in updates) invalidateGtdConfigCache(id);

  // Sync live IMAP state after DB update (fire-and-forget, non-fatal).
  // Toggling gtd_enabled reconnects so the GTD sync tick is armed/torn down (it is
  // only decided at connectAccount) and the persistent-connection account object the
  // INBOX/send transition hooks close over picks up the new flag. Remapping a GTD state
  // to a different folder reconnects for the same reason: connectAccount's syncFolders +
  // backfillAllFolders is what pulls the newly-designated folder's existing mail into the
  // rail (backfillAllFolders backfills every discovered folder except the provider's
  // skipFolderPatterns, which a GTD label folder never matches).
  const isDisabling = 'enabled' in updates && !updates.enabled;
  const needsReconnect = !isDisabling && (
    'enabled' in updates ||
    'auth_user' in updates ||
    'auth_pass' in updates ||
    'imap_host' in updates ||
    'imap_port' in updates ||
    'imap_tls' in updates ||
    'imap_skip_tls_verify' in updates ||
    'gtd_enabled' in updates ||
    gtdFoldersChanged
  );

  // Both branches queue through the per-account serializer so overlapping settings
  // changes (e.g. a rapid gtd_enabled double-toggle) apply their connection-state
  // effects in order, never as two overlapping chains.
  if (isDisabling) {
    reconnectQueue(id, () => imapManager.disconnectAccount(id))
      .catch(err => console.error(`Failed to disconnect account ${id} after disable:`, err.message));
  } else if (needsReconnect && updated.protocol === 'imap' && updated.enabled) {
    reconnectQueue(id, () =>
      imapManager.disconnectAccount(id)
        .then(() => query('SELECT * FROM email_accounts WHERE id = $1', [id]))
        .then(r => { if (r.rows.length) return imapManager.connectAccount(r.rows[0]); })
    ).catch(err => console.error(`Failed to reconnect account ${id} after update:`, err.message));
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const check = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

    // Delete from DB first (cascades to messages and folders immediately).
    // Disconnect IMAP afterward — fire-and-forget so a slow server logout
    // doesn't block the response.
    await query('DELETE FROM email_accounts WHERE id = $1', [id]);
    imapManager.disconnectAccount(id).catch(err =>
      console.error(`Disconnect error after delete for ${id}:`, err.message)
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Account delete error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

router.post('/:id/reconnect', async (req, res) => {
  const { id } = req.params;
  const result = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });

  imapManager.connectAccount(result.rows[0]).catch(console.error);
  res.json({ ok: true });
});

// ── Alias CRUD ─────────────────────────────────────────────────────────────

router.get('/:id/aliases', async (req, res) => {
  const { id } = req.params;
  const check = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'SELECT id, account_id, name, email, reply_to, signature, created_at FROM account_aliases WHERE account_id = $1 ORDER BY created_at',
    [id]
  );
  res.json(result.rows.map(alias => ({
    ...alias,
    signature: alias.signature ? sanitizeSignature(alias.signature) : alias.signature,
  })));
});

router.post('/:id/aliases', async (req, res) => {
  const { id } = req.params;
  const { name, email, reply_to, signature } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email) || hasHeaderInjectionChars(reply_to)) {
    return res.status(400).json({ error: 'Fields cannot contain control characters' });
  }

  const check = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'INSERT INTO account_aliases (account_id, name, email, reply_to, signature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [id, name, email, reply_to || null, sanitizeSignature(signature) || null]
  );
  res.json(result.rows[0]);
});

router.put('/:id/aliases/:aliasId', async (req, res) => {
  const { id, aliasId } = req.params;
  const { name, email, reply_to, signature } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  if (hasHeaderInjectionChars(name) || hasHeaderInjectionChars(email) || hasHeaderInjectionChars(reply_to)) {
    return res.status(400).json({ error: 'Fields cannot contain control characters' });
  }

  const check = await query(
    `SELECT a.id FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.user_id = $2 AND e.id = $3`,
    [aliasId, req.session.userId, id]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Alias not found' });

  const result = await query(
    'UPDATE account_aliases SET name = $1, email = $2, reply_to = $3, signature = $4 WHERE id = $5 RETURNING *',
    [name, email, reply_to || null, sanitizeSignature(signature) || null, aliasId]
  );
  res.json(result.rows[0]);
});

router.delete('/:id/aliases/:aliasId', async (req, res) => {
  const { id, aliasId } = req.params;

  const check = await query(
    `SELECT a.id FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.user_id = $2 AND e.id = $3`,
    [aliasId, req.session.userId, id]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Alias not found' });

  await query('DELETE FROM account_aliases WHERE id = $1', [aliasId]);
  res.json({ ok: true });
});

router.get('/:id/folders', async (req, res) => {
  const { id } = req.params;
  const check = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'SELECT * FROM folders WHERE account_id = $1 ORDER BY path',
    [id]
  );
  res.json(result.rows);
});

router.post('/:id/reindex', async (req, res) => {
  try {
    const result = await query(
      "SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true AND protocol = 'imap'",
      [req.params.id, req.session.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });

    const account = result.rows[0];
    const alreadyRunning = imapManager.backfillAllRunning.has(account.id);
    if (!alreadyRunning) {
      imapManager.backfillAllFolders(account).catch(err =>
        console.error(`Manual reindex error for ${account.email_address}:`, err.message)
      );
    }
    res.json({ ok: true, alreadyRunning });
  } catch (err) {
    console.error('POST /accounts/:id/reindex error:', err.message);
    res.status(500).json({ error: 'Failed to start reindex' });
  }
});

export default router;
