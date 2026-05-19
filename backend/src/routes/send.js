import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { sendEmail } from '../services/emailSend.js';

// Map SMTP/connection errors to user-friendly messages that don't expose server internals.
function sanitizeSmtpError(err) {
  const msg = err.message || '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/i.test(msg)) {
    return 'Could not connect to the mail server. Check your SMTP settings.';
  }
  if (/535|534|530|invalid.?login|authentication.?fail|bad.*credentials|username.*password|password.*username/i.test(msg)) {
    return 'Authentication failed. Check your email account credentials.';
  }
  if (/throttl|rate.?limit|too many|4\.2\.|4\.7\.94/i.test(msg)) {
    return 'The mail server is rate limiting sends. Please try again shortly.';
  }
  if (/550|5\.[13]\.|reject|blacklist|spam|not.?accept/i.test(msg)) {
    return 'Message was rejected by the mail server.';
  }
  if (/TLS|SSL|certificate|handshake/i.test(msg)) {
    return 'Secure connection to the mail server failed. Check your TLS settings.';
  }
  return 'Failed to send message. Please try again.';
}

const router = Router();
router.use(requireAuth);

router.post('/send', async (req, res) => {
  try {
    await sendEmail(req.body, req.session.userId, imapManager);
    res.json({ ok: true });
  } catch (err) {
    console.error('Send failed:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : sanitizeSmtpError(err) });
  }
});

export default router;
