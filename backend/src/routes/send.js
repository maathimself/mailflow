import nodemailer from 'nodemailer';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { refreshMicrosoftToken } from './oauth.js';

const router = Router();
router.use(requireAuth);

router.post('/send', async (req, res) => {
  const { accountId, to, cc = [], subject, body, inReplyTo } = req.body;
  if (!accountId || !to?.length) return res.status(400).json({ error: 'accountId and to required' });

  const result = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  let account = result.rows[0];

  try {
    if (account.oauth_provider === 'microsoft') {
      account = await refreshMicrosoftToken(account);
    }

    let smtpAuth;
    if ((account.oauth_provider === 'microsoft' || account.oauth_provider === 'google')
        && account.oauth_access_token) {
      smtpAuth = {
        type: 'OAuth2',
        user: account.auth_user || account.email_address,
        accessToken: account.oauth_access_token,
      };
    } else {
      smtpAuth = { user: account.auth_user, pass: account.auth_pass };
    }

    const transport = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: account.smtp_port === 465,
      auth: smtpAuth,
      tls: { rejectUnauthorized: false },
    });

    const mailOptions = {
      from: `${account.name} <${account.email_address}>`,
      to: to.join(', '),
      cc: cc.join(', ') || undefined,
      subject,
      text: body,
    };
    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = inReplyTo;
    }

    await transport.sendMail(mailOptions);
    res.json({ ok: true });
  } catch (err) {
    console.error('Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
