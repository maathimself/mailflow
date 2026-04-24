import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { refreshMicrosoftToken } from './oauth.js';
import { decrypt } from '../services/encryption.js';

const router = Router();
router.use(requireAuth);

// Providers whose SMTP servers automatically save sent mail to the IMAP Sent folder.
// For these we skip IMAP APPEND and just sync after a delay.
const AUTO_SAVE_SMTP = ['gmail.com', 'googlemail.com', 'smtp.mail.me.com', 'office365.com', 'outlook.com', 'live.com', 'hotmail.com'];

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

    // Use a stable Message-ID so the SMTP copy and any IMAP APPEND reference the same message.
    const domain = account.email_address.split('@')[1] || 'mailflow.local';
    const mailOptions = {
      messageId: `<${randomBytes(16).toString('hex')}@${domain}>`,
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

    // Determine if this SMTP server auto-saves sent mail to IMAP.
    // OAuth providers (Gmail, Microsoft) always auto-save; standard SMTP hosts are checked by name.
    const smtpHost = (account.smtp_host || '').toLowerCase();
    const serverAutoSaves = !!account.oauth_provider ||
      AUTO_SAVE_SMTP.some(h => smtpHost.includes(h));

    // For servers that don't auto-save, generate the raw MIME now so we can APPEND it.
    let rawMessage = null;
    if (!serverAutoSaves) {
      const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
      const streamInfo = await streamTransport.sendMail(mailOptions);
      const chunks = [];
      await new Promise((resolve, reject) => {
        streamInfo.message.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        streamInfo.message.on('end', resolve);
        streamInfo.message.on('error', reject);
      });
      rawMessage = Buffer.concat(chunks);
    }

    await transport.sendMail(mailOptions);

    // Get the Sent folder path (manual mapping takes priority over special_use auto-detect)
    const imapManager = req.app.get('imapManager');
    if (imapManager) {
      let sentFolder = account.folder_mappings?.sent || null;
      if (!sentFolder) {
        const folderResult = await query(
          "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Sent' LIMIT 1",
          [accountId]
        );
        sentFolder = folderResult.rows[0]?.path || null;
      }
      console.log(`Post-send: ${account.email_address} sentFolder=${sentFolder} autoSaves=${serverAutoSaves}`);

      if (sentFolder) {
        if (rawMessage) {
          // APPEND directly to IMAP Sent, then run a sync to pull it into the DB
          imapManager.appendToSent(account, sentFolder, rawMessage)
            .then(() => {
              setTimeout(() => {
                imapManager.syncFolderOnDemand(account, sentFolder)
                  .then(() => console.log(`Post-append sync done: ${account.email_address}/${sentFolder}`))
                  .catch(e => console.error(`Post-append sync failed: ${e.message}`));
              }, 1000);
            })
            .catch(err => {
              console.error(`IMAP append failed for ${account.email_address}/${sentFolder}: ${err.message}`);
              // Fall back to delayed sync
              setTimeout(() => {
                imapManager.syncFolderOnDemand(account, sentFolder)
                  .catch(e => console.error(`Fallback sync failed: ${e.message}`));
              }, 5000);
            });
        } else {
          // Server auto-saves via SMTP; just sync after a delay
          const syncAttempt = (label) => imapManager.syncFolderOnDemand(account, sentFolder)
            .then(() => console.log(`Post-send ${label} sync done: ${account.email_address}/${sentFolder}`))
            .catch(e => console.error(`Post-send ${label} sync failed: ${e.message}`));
          setTimeout(() => syncAttempt('3s'), 3000);
          setTimeout(() => syncAttempt('15s'), 15000);
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
