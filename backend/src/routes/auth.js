import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { authenticator } from 'otplib';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const router = Router();

// Simple in-memory rate limiter — no extra dependency required.
// Buckets are keyed by IP; entries expire after the window elapses.
const rateBuckets = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= maxRequests) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    bucket.count++;
    next();
  };
}
const authLimiter = rateLimit(10, 15 * 60 * 1000); // 10 attempts per 15 minutes per IP

router.post('/register', authLimiter, async (req, res) => {
  const { username, password, inviteToken } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    // Check if this is the very first user (no rows in users table)
    const countResult = await query('SELECT COUNT(*) as count FROM users');
    const isFirstUser = parseInt(countResult.rows[0].count) === 0;

    if (!isFirstUser) {
      // Not the first user — check registration policy
      const settingResult = await query(
        "SELECT value FROM system_settings WHERE key = 'registration_open'"
      );
      const registrationOpen = settingResult.rows[0]?.value === 'true';

      if (!registrationOpen) {
        // Registration closed — require a valid invite token
        if (!inviteToken) {
          return res.status(403).json({ error: 'Registration is currently by invitation only.' });
        }
        const inviteResult = await query(
          `SELECT * FROM invites
           WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
          [inviteToken]
        );
        if (!inviteResult.rows.length) {
          return res.status(403).json({ error: 'Invalid or expired invite link.' });
        }
      } else if (inviteToken) {
        // Registration open but a token was provided — still validate it (non-fatal if invalid)
        const inviteResult = await query(
          `SELECT * FROM invites WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
          [inviteToken]
        );
        if (!inviteResult.rows.length) {
          return res.status(403).json({ error: 'Invalid or expired invite link.' });
        }
      }
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id, username, is_admin',
      [username.toLowerCase().trim(), hash, isFirstUser]
    );
    const newUser = result.rows[0];

    // Mark invite as used
    if (inviteToken) {
      await query(
        `UPDATE invites SET used_by = $1, used_at = NOW() WHERE token = $2`,
        [newUser.id, inviteToken]
      );
    }

    // Create session so the user is immediately logged in after registering
    req.session.userId = newUser.id;
    req.session.username = newUser.username;
    req.session.isAdmin = newUser.is_admin;

    // Start IMAP connections (no accounts yet on first register, harmless)
    imapManager.connectAllForUser(newUser.id);

    res.json({ user: { id: newUser.id, username: newUser.username, isAdmin: newUser.is_admin } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const result = await query('SELECT * FROM users WHERE username = $1', [username.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // If 2FA is enabled, require a TOTP challenge before creating a full session
    if (user.totp_enabled) {
      req.session.pendingUserId = user.id;
      req.session.pendingTOTPExpiry = Date.now() + 5 * 60 * 1000; // 5-minute window
      return res.json({ requiresTOTP: true });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    // Start IMAP connections for this user
    imapManager.connectAllForUser(user.id);

    res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Second step of login when 2FA is enabled
router.post('/2fa/challenge', authLimiter, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  if (!req.session.pendingUserId) {
    return res.status(400).json({ error: 'No pending authentication' });
  }
  if (Date.now() > (req.session.pendingTOTPExpiry || 0)) {
    delete req.session.pendingUserId;
    delete req.session.pendingTOTPExpiry;
    return res.status(400).json({ error: 'Authentication timed out. Please log in again.' });
  }

  const result = await query('SELECT * FROM users WHERE id = $1', [req.session.pendingUserId]);
  const user = result.rows[0];
  if (!user || !user.totp_secret) {
    return res.status(401).json({ error: 'Authentication failed' });
  }

  if (!authenticator.verify({ token: String(code).replace(/\s/g, ''), secret: user.totp_secret })) {
    return res.status(401).json({ error: 'Invalid code' });
  }

  delete req.session.pendingUserId;
  delete req.session.pendingTOTPExpiry;
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin;

  imapManager.connectAllForUser(user.id);
  res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = await query('SELECT id, username, is_admin, totp_enabled FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.session.isAdmin = user.is_admin;
  res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin, totpEnabled: user.totp_enabled } });
});

// Public endpoint: check if registration is open (used by login page)
router.get('/registration-status', async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'registration_open'");
  const open = result.rows[0]?.value === 'true';
  res.json({ open });
});

// Public endpoint: validate an invite token before showing the registration form
router.get('/invite/:token', async (req, res) => {
  const result = await query(
    `SELECT email, expires_at FROM invites
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [req.params.token]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Invalid or expired invite' });
  res.json({ valid: true, email: result.rows[0].email });
});

router.get('/preferences', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const result = await query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]);
  res.json(result.rows[0]?.preferences || {});
});

router.patch('/preferences', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { theme, font, layout, notificationSound } = req.body;
  await query(`
    UPDATE users
    SET preferences = preferences
      || CASE WHEN $2::text IS NOT NULL THEN jsonb_build_object('theme',  $2::text) ELSE '{}'::jsonb END
      || CASE WHEN $3::text IS NOT NULL THEN jsonb_build_object('font',   $3::text) ELSE '{}'::jsonb END
      || CASE WHEN $4::text IS NOT NULL THEN jsonb_build_object('layout', $4::text) ELSE '{}'::jsonb END
      || CASE WHEN $5::text IS NOT NULL THEN jsonb_build_object('notificationSound', $5::text) ELSE '{}'::jsonb END
    WHERE id = $1
  `, [req.session.userId, theme ?? null, font ?? null, layout ?? null, notificationSound ?? null]);
  res.json({ ok: true });
});

export default router;
