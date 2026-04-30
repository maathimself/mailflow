import { Router } from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { query } from '../services/db.js';
import { requireAdmin } from '../middleware/auth.js';
import { decrypt, encrypt } from '../services/encryption.js';

const router = Router();
router.use(requireAdmin);

// ── Users ──────────────────────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  const result = await query(
    'SELECT id, username, is_admin, totp_enabled, created_at FROM users ORDER BY created_at ASC LIMIT 500'
  );
  res.json({ users: result.rows.map(u => ({ ...u, isAdmin: u.is_admin, totpEnabled: u.totp_enabled })) });
});

router.post('/users/:id/totp/disable', async (req, res) => {
  const { id } = req.params;
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Use your account settings to manage your own 2FA.' });
  }
  const target = await query('SELECT username FROM users WHERE id = $1', [id]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  await query('UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [id]);
  console.log(`[admin] ${req.session.username} disabled 2FA for user ${target.rows[0].username} (${id})`);
  res.json({ ok: true });
});

router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { isAdmin } = req.body;

  // Prevent removing your own admin status
  if (id === req.session.userId && isAdmin === false) {
    return res.status(400).json({ error: 'Cannot remove your own admin status' });
  }

  const target = await query('SELECT username FROM users WHERE id = $1', [id]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });

  await query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin, id]);
  console.log(`[admin] ${req.session.username} set is_admin=${isAdmin} for user ${target.rows[0].username} (${id})`);

  // If user is currently logged in, their session isAdmin will be refreshed on next /me call
  res.json({ ok: true });
});

router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const target = await query('SELECT username FROM users WHERE id = $1', [id]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  await query('DELETE FROM users WHERE id = $1', [id]);
  console.log(`[admin] ${req.session.username} deleted user ${target.rows[0].username} (${id})`);
  res.json({ ok: true });
});

// ── System settings ────────────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  const result = await query('SELECT key, value FROM system_settings');
  const settings = {};
  for (const row of result.rows) settings[row.key] = row.value;
  res.json({ settings });
});

router.patch('/settings', async (req, res) => {
  const { registration_open } = req.body;
  if (typeof registration_open === 'boolean') {
    await query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('registration_open', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [registration_open ? 'true' : 'false']
    );
  }
  res.json({ ok: true });
});

// ── Invites ────────────────────────────────────────────────────────────────────

router.get('/invites', async (req, res) => {
  const result = await query(`
    SELECT i.id, i.email, i.token, i.created_at, i.expires_at, i.used_at,
           u.username as used_by_username
    FROM invites i
    LEFT JOIN users u ON i.used_by = u.id
    ORDER BY i.created_at DESC
    LIMIT 500
  `);
  res.json({ invites: result.rows });
});

router.post('/invites', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  // Generate a 32-byte hex token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await query(
    `INSERT INTO invites (email, token, created_by, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [email.trim().toLowerCase(), token, req.session.userId, expiresAt]
  );

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    return res.status(500).json({ error: 'APP_URL is not configured — set it in .env before sending invites.' });
  }
  const inviteUrl = `${appUrl}/register?invite=${token}`;

  // Try to send an invite email via the admin's first SMTP-enabled account
  let emailSent = false;
  let emailError = null;
  try {
    const accountResult = await query(
      `SELECT * FROM email_accounts
       WHERE user_id = $1 AND enabled = true AND smtp_host IS NOT NULL
       ORDER BY created_at LIMIT 1`,
      [req.session.userId]
    );

    if (accountResult.rows.length) {
      const account = accountResult.rows[0];
      let smtpAuth;
      if ((account.oauth_provider === 'microsoft' || account.oauth_provider === 'google')
          && account.oauth_access_token) {
        smtpAuth = {
          type: 'OAuth2',
          user: account.auth_user || account.email_address,
          accessToken: decrypt(account.oauth_access_token),
        };
      } else {
        smtpAuth = { user: account.auth_user, pass: decrypt(account.auth_pass) };
      }

      const transport = nodemailer.createTransport({
        host: account.smtp_host,
        port: account.smtp_port,
        secure: account.smtp_port === 465,
        auth: smtpAuth,
        tls: { rejectUnauthorized: !account.imap_skip_tls_verify },
      });

      await transport.sendMail({
        from: `${account.name} <${account.email_address}>`,
        to: email,
        subject: 'You\'ve been invited to MailFlow',
        text: [
          `You've been invited to join MailFlow.`,
          ``,
          `Click the link below to create your account:`,
          `${inviteUrl}`,
          ``,
          `This invite expires in 7 days and can only be used once.`,
        ].join('\n'),
        html: `
          <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; color: #1a1a1a;">
            <div style="margin-bottom: 24px;">
              <span style="font-size: 22px; font-weight: 700; color: #1a1a1a;">Mail</span><span style="font-size: 22px; font-weight: 600; color: #7c6af7;">Flow</span>
            </div>
            <h2 style="margin: 0 0 12px; font-size: 18px; font-weight: 600;">You've been invited</h2>
            <p style="color: #555; line-height: 1.6; margin: 0 0 24px;">
              You've been invited to join MailFlow. Click the button below to create your account.
            </p>
            <a href="${inviteUrl}" style="display: inline-block; padding: 12px 24px; background: #7c6af7; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 14px;">
              Accept Invite
            </a>
            <p style="color: #999; font-size: 12px; margin: 24px 0 0;">
              This invite expires in 7 days and can only be used once.<br>
              If you weren't expecting this, you can ignore this email.
            </p>
          </div>
        `,
      });
      emailSent = true;
    }
  } catch (err) {
    console.error('Invite email failed:', err.message);
    emailError = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|authentication|535|reject/i.test(err.message)
      ? 'Mail server error. Check your SMTP account settings.'
      : 'Failed to send invite email.';
  }

  res.json({ ok: true, inviteUrl, emailSent, emailError });
});

router.delete('/invites/:id', async (req, res) => {
  await query('DELETE FROM invites WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── OIDC providers ─────────────────────────────────────────────────────────────

router.get('/oidc', async (req, res) => {
  const result = await query(
    `SELECT id, name, slug, issuer_url, client_id, scopes, provisioning_mode,
            allowed_domains, enabled, require_email_verified, created_at, updated_at
     FROM oidc_providers ORDER BY name ASC`
  );
  res.json({ providers: result.rows });
});

router.post('/oidc', async (req, res) => {
  const { name, slug, issuer_url, client_id, client_secret, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified } = req.body;
  if (!name || !slug || !issuer_url || !client_id || !client_secret) {
    return res.status(400).json({ error: 'name, slug, issuer_url, client_id and client_secret are required' });
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Slug must contain only lowercase letters, numbers and hyphens' });
  }
  try {
    const result = await query(
      `INSERT INTO oidc_providers (name, slug, issuer_url, client_id, client_secret, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, name, slug, issuer_url, client_id, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified`,
      [
        name.trim(), slug.trim(), issuer_url.trim(), client_id.trim(),
        encrypt(client_secret),
        (scopes || 'openid email profile').trim(),
        provisioning_mode || 'login_existing_only',
        allowed_domains?.trim() || null,
        enabled !== false,
        require_email_verified !== false,
      ]
    );
    res.json({ provider: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A provider with this slug already exists' });
    throw err;
  }
});

router.patch('/oidc/:id', async (req, res) => {
  const { id } = req.params;
  const { name, slug, issuer_url, client_id, client_secret, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified } = req.body;
  if (slug && !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Slug must contain only lowercase letters, numbers and hyphens' });
  }
  // Only encrypt a new secret if one was provided (non-placeholder)
  const secretUpdate = client_secret && client_secret !== '••••••••'
    ? encrypt(client_secret)
    : undefined;
  try {
    const result = await query(
      `UPDATE oidc_providers SET
        name = COALESCE($2, name),
        slug = COALESCE($3, slug),
        issuer_url = COALESCE($4, issuer_url),
        client_id = COALESCE($5, client_id),
        client_secret = COALESCE($6, client_secret),
        scopes = COALESCE($7, scopes),
        provisioning_mode = COALESCE($8, provisioning_mode),
        allowed_domains = CASE WHEN $9::text IS DISTINCT FROM '__keep__' THEN $9::text ELSE allowed_domains END,
        enabled = COALESCE($10, enabled),
        require_email_verified = COALESCE($11, require_email_verified),
        updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, slug, issuer_url, client_id, scopes, provisioning_mode, allowed_domains, enabled, require_email_verified`,
      [
        id,
        name?.trim() || null,
        slug?.trim() || null,
        issuer_url?.trim() || null,
        client_id?.trim() || null,
        secretUpdate || null,
        scopes?.trim() || null,
        provisioning_mode || null,
        allowed_domains !== undefined ? (allowed_domains?.trim() || null) : '__keep__',
        enabled !== undefined ? enabled : null,
        require_email_verified !== undefined ? require_email_verified : null,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Provider not found' });
    res.json({ provider: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A provider with this slug already exists' });
    throw err;
  }
});

router.delete('/oidc/:id', async (req, res) => {
  await query('DELETE FROM oidc_providers WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

export default router;
