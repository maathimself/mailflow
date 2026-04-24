import { Router } from 'express';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// In-memory rate limiter for TOTP verification attempts (5 per 15 min per user)
const totpBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of totpBuckets) {
    if (now > bucket.resetAt) totpBuckets.delete(key);
  }
}, 5 * 60 * 1000);

function totpLimiter(req, res, next) {
  const key = req.session.userId;
  const now = Date.now();
  const bucket = totpBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    totpBuckets.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return next();
  }
  if (bucket.count >= 5) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  bucket.count++;
  next();
}

// GET /api/totp/setup — generate a new TOTP secret and QR code
router.get('/setup', async (req, res) => {
  const userResult = await query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
  const username = userResult.rows[0]?.username || 'user';

  const secret = authenticator.generateSecret(20);
  const otpauthUrl = authenticator.keyuri(username, 'MailFlow', secret);
  const qrCode = await QRCode.toDataURL(otpauthUrl);

  // Hold the secret in the session until the user verifies it
  req.session.pendingTOTPSecret = secret;

  res.json({ secret, qrCode });
});

// POST /api/totp/enable — verify a code against the pending secret and save it
router.post('/enable', totpLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const secret = req.session.pendingTOTPSecret;
  if (!secret) return res.status(400).json({ error: 'No pending setup found. Start over.' });

  if (!authenticator.verify({ token: String(code).replace(/\s/g, ''), secret })) {
    return res.status(400).json({ error: 'Invalid code — check your device clock and try again.' });
  }

  await query(
    'UPDATE users SET totp_secret = $1, totp_enabled = true WHERE id = $2',
    [secret, req.session.userId]
  );
  delete req.session.pendingTOTPSecret;

  res.json({ ok: true });
});

// POST /api/totp/disable — disable 2FA after confirming password
router.post('/disable', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'User not found' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  await query(
    'UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1',
    [req.session.userId]
  );

  res.json({ ok: true });
});

export default router;
