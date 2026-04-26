import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { encrypt } from '../services/encryption.js';

const router = Router();
router.use(requireAuth);

// Fields safe to return to the client — matches the GET list, excludes credentials and tokens
const SAFE_FIELDS = [
  'id', 'name', 'email_address', 'color', 'protocol',
  'imap_host', 'imap_port', 'smtp_host', 'smtp_port',
  'auth_user', 'oauth_provider', 'enabled',
  'last_sync', 'sync_error', 'sort_order', 'folder_mappings',
  'imap_skip_tls_verify', 'signature', 'created_at',
];
function safeAccount(row) {
  return Object.fromEntries(SAFE_FIELDS.map(k => [k, row[k]]));
}

router.get('/', async (req, res) => {
  const result = await query(
    `SELECT id, name, email_address, color, protocol, imap_host, imap_port,
            smtp_host, smtp_port, auth_user, oauth_provider, enabled,
            last_sync, sync_error, sort_order, folder_mappings, imap_skip_tls_verify, signature, created_at
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

  res.json(result.rows.map(a => ({ ...a, aliases: aliasMap[a.id] || [] })));
});

router.post('/', async (req, res) => {
  const {
    name, email_address, color = '#6366f1', protocol = 'imap',
    imap_host, imap_port = 993, imap_tls = true,
    smtp_host, smtp_port = 587, smtp_tls = 'STARTTLS',
    auth_user, auth_pass,
    oauth_provider, oauth_access_token, oauth_refresh_token,
    jmap_session_url, signature = null
  } = req.body;

  if (!name || !email_address) return res.status(400).json({ error: 'Name and email required' });

  try {
    const result = await query(`
      INSERT INTO email_accounts (
        user_id, name, email_address, color, protocol,
        imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls,
        auth_user, auth_pass, oauth_provider, oauth_access_token, oauth_refresh_token,
        jmap_session_url, signature
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [
      req.session.userId, name, email_address, color, protocol,
      imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls,
      auth_user, encrypt(auth_pass), oauth_provider, encrypt(oauth_access_token), encrypt(oauth_refresh_token),
      jmap_session_url, signature || null
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

  // Verify ownership
  const check = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  const allowed = ['name', 'color', 'enabled', 'auth_pass', 'sort_order', 'smtp_host', 'smtp_port', 'folder_mappings', 'imap_skip_tls_verify', 'signature'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = $${i++}`);
      const value = (key === 'auth_pass' && updates[key]) ? encrypt(updates[key]) : updates[key];
      values.push(value);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  const result = await query(
    `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  res.json(safeAccount(result.rows[0]));
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
  res.json(result.rows);
});

router.post('/:id/aliases', async (req, res) => {
  const { id } = req.params;
  const { name, email, reply_to, signature } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  const check = await query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2', [id, req.session.userId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Account not found' });

  const result = await query(
    'INSERT INTO account_aliases (account_id, name, email, reply_to, signature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [id, name, email, reply_to || null, signature || null]
  );
  res.json(result.rows[0]);
});

router.put('/:id/aliases/:aliasId', async (req, res) => {
  const { id, aliasId } = req.params;
  const { name, email, reply_to, signature } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  const check = await query(
    `SELECT a.id FROM account_aliases a
     JOIN email_accounts e ON a.account_id = e.id
     WHERE a.id = $1 AND e.user_id = $2 AND e.id = $3`,
    [aliasId, req.session.userId, id]
  );
  if (!check.rows.length) return res.status(404).json({ error: 'Alias not found' });

  const result = await query(
    'UPDATE account_aliases SET name = $1, email = $2, reply_to = $3, signature = $4 WHERE id = $5 RETURNING *',
    [name, email, reply_to || null, signature || null, aliasId]
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

export default router;
