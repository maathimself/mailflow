import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const result = await query(
    `SELECT id, name, email_address, color, protocol, imap_host, imap_port,
            smtp_host, smtp_port, auth_user, oauth_provider, enabled,
            last_sync, sync_error, sort_order, created_at
     FROM email_accounts WHERE user_id = $1 ORDER BY sort_order, created_at`,
    [req.session.userId]
  );
  res.json(result.rows);
});

router.post('/', async (req, res) => {
  const {
    name, email_address, color = '#6366f1', protocol = 'imap',
    imap_host, imap_port = 993, imap_tls = true,
    smtp_host, smtp_port = 587, smtp_tls = 'STARTTLS',
    auth_user, auth_pass,
    oauth_provider, oauth_access_token, oauth_refresh_token,
    jmap_session_url
  } = req.body;

  if (!name || !email_address) return res.status(400).json({ error: 'Name and email required' });

  try {
    const result = await query(`
      INSERT INTO email_accounts (
        user_id, name, email_address, color, protocol,
        imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls,
        auth_user, auth_pass, oauth_provider, oauth_access_token, oauth_refresh_token,
        jmap_session_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `, [
      req.session.userId, name, email_address, color, protocol,
      imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls,
      auth_user, auth_pass, oauth_provider, oauth_access_token, oauth_refresh_token,
      jmap_session_url
    ]);

    const account = result.rows[0];

    // Immediately try to connect
    if (protocol === 'imap') {
      imapManager.connectAccount(account).catch(console.error);
    }

    res.json(account);
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

  const allowed = ['name', 'color', 'enabled', 'auth_pass', 'sort_order', 'smtp_host', 'smtp_port'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = $${i++}`);
      values.push(updates[key]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  const result = await query(
    `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  res.json(result.rows[0]);
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
